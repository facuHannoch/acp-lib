// Per-operation metering. See §7 (rating units), §8, §9, §11, §12.
//
// The engine owns one rating unit per ACP operation: resolve and freeze a pricing policy
// BEFORE dispatch, then after the operation subtract the baseline, select one schedule
// from the frozen policy, and rate. Resolving before dispatch is what makes a strict mode
// able to fail preflight instead of after the provider has already been paid, and what
// stops a mid-flight configuration change from repricing work already sent.

import type { TokenUsage } from "../types.ts";
import type { ContextWindowStatus, ProviderCostSnapshot } from "./context.ts";
import { baselineMatches, calculateDelta } from "./delta.ts";
import {
  MeteringPreflightError,
  type MeteredOperationKind,
  type MeteringEnforcement,
  type MeteringPricingStatus,
  type MeteringProvenance,
  type MeteringUsageResult,
  type OperationMeteringRecord,
  type OperationOutcome,
  type CostReconciliation,
  acpProvenance,
  UNAVAILABLE_PROVENANCE,
} from "./record.ts";
import type {
  CategoryApplicability,
  PricingConfiguration,
  PricingContext,
  PricingPolicy,
  PricingResolver,
  TokenCategory,
} from "./pricing.ts";
import { validatePricingPolicy } from "./pricing.ts";
import { counterInterpretationForAdapter, type CounterInterpretation } from "./provider.ts";
import { rateDelta, selectSchedule, unpricedUsage, type AttributableUsage, type BillingFacts } from "./rating.ts";
import { ratioOf, subtractMoney, type Money } from "./money.ts";
import {
  accrueOperation,
  emptyMeteringState,
  restoreMeteringState,
  type AgentSessionMeteringState,
  type MeteringBaseline,
  type StateRestoration,
} from "./state.ts";

export interface MeteringEngineOptions {
  readonly agentSessionId: string;
  readonly adapterId: string;
  readonly enforcement: MeteringEnforcement;
  readonly pricing: PricingConfiguration;
  readonly initialState?: AgentSessionMeteringState;
  /** True when the library created the active provider thread, so counters began at zero. */
  readonly createdActiveThread: boolean;
  /**
   * How to read this harness's counters. Defaults to the adapter's measured evidence.
   * A consumer may override when it knows its harness version; it is never guessed at
   * runtime, because §4 forbids switching interpretations mid-session.
   */
  readonly counterInterpretation?: CounterInterpretation;
}

/** A rating unit opened before dispatch and closed after the operation finishes. */
export interface OpenOperation {
  readonly operationId: string;
  readonly operationKind: MeteredOperationKind;
  readonly startedAt: number;
  readonly internalSessionId: string | null;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly policy: PricingPolicy | null;
  readonly pricingFailureReason: string | null;
}

export interface CloseOperationInput {
  readonly outcome: OperationOutcome;
  /** Normalized cumulative report, or null when the harness supplied none. */
  readonly reportedCumulative: TokenUsage | null;
  readonly usageFailureReason?: string;
  readonly contextAfter: ContextWindowStatus | null;
  readonly providerCostAfter: ProviderCostSnapshot | null;
  readonly billingFacts?: BillingFacts;
}

const UNKNOWN_APPLICABILITY: Readonly<Record<TokenCategory, CategoryApplicability>> = Object.freeze({
  input: "unknown",
  output: "unknown",
  cached_read: "unknown",
  cached_write: "unknown",
  thought: "unknown",
});

export class MeteringEngine {
  private state: AgentSessionMeteringState;
  private readonly _restoration: StateRestoration;
  private _blocked = false;
  private _blockedReason: string | null = null;
  private _lastOperation: OperationMeteringRecord | null = null;
  /** Whether the active thread's counters are known to have started at zero. */
  private trustedZeroBaseline: boolean;
  private baseline: MeteringBaseline | null;
  private readonly interpretation: CounterInterpretation;
  /** Provider cumulative cost as of the previous close, for per-operation deltas. */
  private lastProviderCost: Money | null = null;

  constructor(private readonly options: MeteringEngineOptions) {
    const restoration = restoreMeteringState(options.initialState, options.agentSessionId);
    this._restoration = restoration;
    this.state =
      restoration.status === "restored"
        ? restoration.state
        : emptyMeteringState(options.agentSessionId);
    this.baseline = restoration.status === "restored" ? this.state.activeBaseline : null;
    this.trustedZeroBaseline = options.createdActiveThread;
    this.interpretation =
      options.counterInterpretation ?? counterInterpretationForAdapter(options.adapterId);

    if (restoration.status === "ignored" && options.enforcement !== "best_effort") {
      throw new MeteringPreflightError(
        `metering initialState rejected: ${restoration.reason}`,
      );
    }
    if (options.enforcement === "billing_required") {
      // No certified integration is registered yet, and plain ACP usage can never satisfy
      // this mode. Failing at construction is the honest answer.
      throw new MeteringPreflightError(
        "billing_required needs a certified metering integration; none is registered",
      );
    }
  }

  get enforcement(): MeteringEnforcement {
    return this.options.enforcement;
  }
  get restoration(): StateRestoration {
    return this._restoration;
  }
  get currentState(): AgentSessionMeteringState {
    return this.state;
  }
  get blocked(): boolean {
    return this._blocked;
  }
  get blockedReason(): string | null {
    return this._blockedReason;
  }
  get lastOperation(): OperationMeteringRecord | null {
    return this._lastOperation;
  }
  get counterInterpretation(): CounterInterpretation {
    return this.interpretation;
  }

  /**
   * Called when the active provider thread is replaced.
   *
   * The new thread's counters restart, so the old baseline is meaningless. A thread the
   * library created has a trusted zero baseline; one it merely loaded does not.
   */
  onThreadReplaced(internalSessionId: string | null, created: boolean): void {
    // A restored baseline that names the thread we just activated is still valid — that
    // is the whole point of restoring it. Only a baseline for some OTHER thread is stale.
    const keep =
      this.baseline &&
      internalSessionId &&
      baselineMatches(this.baseline, {
        adapterId: this.options.adapterId,
        internalSessionId,
      });
    if (!keep) this.baseline = null;
    // A thread we created has counters starting at zero; one we merely loaded does not.
    this.trustedZeroBaseline = created && !keep;
  }

  /**
   * Open a rating unit. Throws in a strict mode when a known preflight condition fails —
   * before any provider work is dispatched, so nothing has been paid for.
   */
  async open(input: {
    operationId: string;
    operationKind: MeteredOperationKind;
    internalSessionId: string | null;
    providerId: string | null;
    model: string | null;
    degraded: boolean;
  }): Promise<OpenOperation> {
    const strict = this.options.enforcement !== "best_effort";

    if (this._blocked && strict) {
      throw new MeteringPreflightError(
        `metering is blocked: ${this._blockedReason ?? "unknown reason"}`,
      );
    }
    if (input.degraded && strict) {
      throw new MeteringPreflightError(
        "degraded (pty) mode cannot supply structured metering",
      );
    }
    // A per-turn harness needs no baseline: each report already describes one operation.
    if (
      strict &&
      this.interpretation === "cumulative" &&
      !this.trustedZeroBaseline &&
      !this.baseline
    ) {
      throw new MeteringPreflightError(
        "no trusted baseline for the active provider thread; restore prior metering state",
      );
    }

    const startedAt = Date.now();
    let policy: PricingPolicy | null = null;
    let pricingFailureReason: string | null = null;

    if (this.options.pricing === false) {
      if (strict) {
        throw new MeteringPreflightError("pricing is disabled but this mode requires rating");
      }
      pricingFailureReason = "pricing disabled by configuration";
    } else {
      const context: PricingContext = {
        scope: "operation",
        agentSessionId: this.options.agentSessionId,
        internalSessionId: input.internalSessionId,
        operationId: input.operationId,
        adapterId: this.options.adapterId,
        providerId: input.providerId,
        model: input.model,
        operationKind: input.operationKind,
        at: startedAt,
      };
      const resolved = await this.resolvePolicy(this.options.pricing, context);
      if (resolved.ok) policy = resolved.policy;
      else pricingFailureReason = resolved.reason;

      if (!policy && strict) {
        throw new MeteringPreflightError(`pricing unavailable: ${pricingFailureReason}`);
      }
    }

    return Object.freeze({
      operationId: input.operationId,
      operationKind: input.operationKind,
      startedAt,
      internalSessionId: input.internalSessionId,
      providerId: input.providerId,
      model: input.model,
      policy,
      pricingFailureReason,
    });
  }

  private async resolvePolicy(
    resolver: PricingResolver,
    context: PricingContext,
  ): Promise<{ ok: true; policy: PricingPolicy } | { ok: false; reason: string }> {
    let policy: PricingPolicy | null;
    try {
      policy = await resolver(context);
    } catch (err) {
      // A resolver that throws follows the same path as one returning null; the original
      // error is preserved as the preflight cause by the caller.
      return { ok: false, reason: `pricing resolver failed: ${String(err)}` };
    }
    if (!policy) return { ok: false, reason: "no pricing policy for this provider/model" };
    const validation = validatePricingPolicy(policy);
    if (!validation.ok) return { ok: false, reason: `invalid pricing policy: ${validation.reason}` };
    return { ok: true, policy };
  }

  /**
   * Close a rating unit and produce its immutable record.
   *
   * Never throws for missing or malformed post-operation usage: the provider has already
   * done the work, and rejecting would risk a retry that duplicates cost. A strict mode
   * records the failure and blocks FUTURE operations instead.
   */
  close(open: OpenOperation, input: CloseOperationInput): OperationMeteringRecord {
    const strict = this.options.enforcement !== "best_effort";
    const { usage, attributable, applicability, nextBaseline, ratingFailureReason } =
      this.measure(open, input);

    let pricingStatus: MeteringPricingStatus;
    // A post-operation rating failure is more specific than a preflight one, so it wins.
    let pricingFailureReason = ratingFailureReason ?? open.pricingFailureReason ?? undefined;

    if (usage.status !== "metered") {
      pricingStatus = "not_attributable";
    } else if (this.options.pricing === false) {
      pricingStatus = "not_configured";
    } else if (attributable?.pricingSource) {
      pricingStatus = "priced";
    } else {
      pricingStatus = "pricing_unavailable";
    }

    const provenance: MeteringProvenance =
      usage.status === "metered" ? acpProvenance(this.interpretation) : UNAVAILABLE_PROVENANCE;

    this.state = accrueOperation(this.state, {
      attributable,
      applicability,
      baseline: nextBaseline,
    });
    this.baseline = nextBaseline;
    if (nextBaseline) this.trustedZeroBaseline = false;

    const record: OperationMeteringRecord = Object.freeze({
      operationId: open.operationId,
      operationKind: open.operationKind,
      outcome: input.outcome,
      startedAt: open.startedAt,
      completedAt: Date.now(),
      agentSessionId: this.options.agentSessionId,
      internalSessionId: open.internalSessionId,
      provider: Object.freeze({
        adapterId: this.options.adapterId,
        providerId: open.providerId,
        model: open.model,
      }),
      provenance,
      usage,
      pricingStatus,
      ...(pricingFailureReason ? { pricingFailureReason } : {}),
      contextAfter: input.contextAfter,
      providerCostAfter: input.providerCostAfter,
      costReconciliation: this.reconcileCost(attributable, input.providerCostAfter),
      nextState: this.state,
    });
    this.lastProviderCost = input.providerCostAfter?.cumulative ?? this.lastProviderCost;

    this._lastOperation = record;

    // Strict modes block on any post-operation metering failure. The response is kept —
    // it was paid for — but continued silent under-accounting is prevented.
    if (strict && !this._blocked) {
      if (usage.status !== "metered") {
        this.block(`operation ${open.operationId}: ${usage.reason}`);
      } else if (pricingStatus !== "priced") {
        this.block(
          `operation ${open.operationId}: ${pricingFailureReason ?? "rated cost unavailable"}`,
        );
      }
    }

    return record;
  }

  private measure(
    open: OpenOperation,
    input: CloseOperationInput,
  ): {
    usage: MeteringUsageResult;
    attributable: AttributableUsage | null;
    applicability: Readonly<Record<TokenCategory, CategoryApplicability>> | null;
    nextBaseline: MeteringBaseline | null;
    ratingFailureReason?: string;
  } {
    const applicability = open.policy?.categoryApplicability ?? null;
    const keepBaseline = this.baseline;

    if (!input.reportedCumulative) {
      return {
        usage: {
          status: "usage_unavailable",
          reason: input.usageFailureReason ?? "harness reported no usage",
        },
        attributable: null,
        applicability,
        nextBaseline: keepBaseline,
      };
    }

    const reported = input.reportedCumulative;
    const usableBaseline =
      keepBaseline && open.internalSessionId
        ? baselineMatches(keepBaseline, {
            adapterId: this.options.adapterId,
            internalSessionId: open.internalSessionId,
          })
          ? keepBaseline.reportedUsage
          : null
        : null;

    const delta = calculateDelta(usableBaseline, reported, {
      trustedZeroBaseline: this.trustedZeroBaseline && !usableBaseline,
      interpretation: this.interpretation,
    });

    const nextBaseline: MeteringBaseline | null = open.internalSessionId
      ? Object.freeze({
          adapterId: this.options.adapterId,
          internalSessionId: open.internalSessionId,
          reportedUsage: reported,
        })
      : keepBaseline;

    if (delta.kind !== "attributable") {
      return {
        usage: {
          status: delta.kind === "counter_reset" ? "counter_reset" : "baseline_required",
          reportedCumulative: reported,
          reason: delta.reason,
        },
        attributable: null,
        applicability,
        // A reset report becomes the next baseline so best-effort metering can continue.
        nextBaseline,
      };
    }

    const attributable = this.rate(open, delta.delta, input.billingFacts ?? {});
    return {
      usage: {
        status: "metered",
        reportedCumulative: reported,
        attributable: attributable.usage,
      },
      attributable: attributable.usage,
      applicability: applicability ?? UNKNOWN_APPLICABILITY,
      nextBaseline,
      // Why rating fell back to unpriced. Without this the record says
      // "pricing_unavailable" with no way to find out why.
      ...(attributable.reason ? { ratingFailureReason: attributable.reason } : {}),
    };
  }

  private rate(
    open: OpenOperation,
    delta: TokenUsage,
    facts: BillingFacts,
  ): { usage: AttributableUsage; reason?: string } {
    if (!open.policy) return { usage: unpricedUsage(delta) };

    const selected = selectSchedule(open.policy, facts);
    if (!selected.ok) return { usage: unpricedUsage(delta), reason: selected.reason };

    const rated = rateDelta(delta, open.policy, selected.schedule);
    if (!rated.ok) return { usage: unpricedUsage(delta), reason: rated.reason };
    return { usage: rated.usage };
  }

  /**
   * Compare our rated cost with the provider's own for this operation.
   *
   * The provider's cumulative cost is the only visibility the ACP-derived backend has into
   * inferences it never saw — retries, compaction, and above all tool-call round trips. A
   * divergence here is not a rounding question; it means real spend went unaccounted.
   */
  private reconcileCost(
    attributable: AttributableUsage | null,
    providerCostAfter: ProviderCostSnapshot | null,
  ): CostReconciliation {
    const rated = attributable?.ratedTotal;
    if (!rated) return { status: "unavailable", reason: "operation was not rated" };
    if (!providerCostAfter) {
      return { status: "unavailable", reason: "harness reported no provider cost" };
    }
    const previous = this.lastProviderCost;
    const current = providerCostAfter.cumulative;
    if (previous && previous.currency !== current.currency) {
      return { status: "unavailable", reason: "provider cost changed currency" };
    }

    // Provider cost is cumulative, so this operation's share is the rise since the last
    // close. Operations are serialized, which is what makes that difference attributable.
    const delta = previous ? subtractMoney(current, previous) : current;
    if (!delta) {
      return { status: "unavailable", reason: "provider cost decreased" };
    }
    if (delta.currency !== rated.currency) {
      return { status: "unavailable", reason: "provider and rated currencies differ" };
    }
    return {
      status: "checked",
      providerDelta: delta,
      ratedTotal: rated,
      ratio: ratioOf(delta, rated),
      matches: delta.amount === rated.amount,
    };
  }

  private block(reason: string): void {
    this._blocked = true;
    this._blockedReason = reason;
  }

  /**
   * Replace state after an out-of-band reconciliation.
   *
   * Deliberately does not mint a record: the adjustment is an accounting correction, not
   * provider usage, and pretending otherwise would put a fabricated operation in the
   * consumer's ledger.
   */
  reconcile(state: AgentSessionMeteringState): { before: AgentSessionMeteringState } {
    const before = this.state;
    this.state = state;
    this.baseline = state.activeBaseline;
    if (state.activeBaseline) this.trustedZeroBaseline = false;
    this._blocked = false;
    this._blockedReason = null;
    return { before };
  }
}
