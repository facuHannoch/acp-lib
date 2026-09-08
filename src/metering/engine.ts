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
import { billingRefusalReason, certificationFor } from "./certification.ts";
import type { ProviderInference } from "./opencode/channel.ts";

/**
 * A source of per-inference records from inside the harness.
 *
 * The ACP-derived backend sees one inference per prompt; a certified source sees them all,
 * which is the whole difference between observability and billing.
 */
export interface InferenceSource {
  /** Certification this source claims, engraved into every record it produces. */
  readonly certificationId: string;
  /** False when the channel never handshook or has since failed. */
  isHealthy(): boolean;
  /** Records completed since the last drain, for the named provider thread. */
  drain(internalSessionId: string | null): readonly ProviderInference[];
  /**
   * Records for OTHER provider threads, swept so they are accounted rather than stranded.
   *
   * Work the harness did outside the active thread — a replaced thread after a handoff,
   * or background activity — belongs in unallocated usage, not charged to whichever
   * operation happens to drain next and not silently dropped.
   */
  drainForeign?(internalSessionId: string | null): readonly ProviderInference[];
  /**
   * Reports the source knows it lost, cumulative.
   *
   * Without this a dropped report is indistinguishable from an inference that never
   * happened, and the operation would still claim complete attribution.
   */
  lostReportCount?(): number;
}
import {
  rateDelta,
  selectSchedule,
  unpricedUsage,
  type AttributableUsage,
  type BillingFacts,
  type PricedTokenAmount,
} from "./rating.ts";
import {
  EMPTY_MONEY_TOTAL,
  decimalFromNumber,
  isTotalComplete,
  mergeTotals,
  ratioOf,
  soleAmount,
  subtractMoney,
  type Money,
} from "./money.ts";
import {
  accrueOperation,
  emptyMeteringState,
  restoreMeteringState,
  type AgentSessionMeteringState,
  type MeteringBaseline,
  type StateRestoration,
  type UnallocatedUsageAccrual,
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
  /** When present and healthy, replaces ACP usage as the measurement. */
  readonly inferenceSource?: InferenceSource;
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
  /** Lost-report count when the operation opened, to detect loss during it. */
  readonly lostReportsAtOpen: number;
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
    const certification = certificationFor(options.adapterId);
    if (
      options.enforcement === "billing_required" &&
      (!certification || options.inferenceSource?.certificationId !== certification.certificationId)
    ) {
      // Refused at construction rather than at the first prompt: a consumer asking for
      // billing-grade metering should learn it is unavailable before any work is queued,
      // not after a turn has already been paid for.
      throw new MeteringPreflightError(billingRefusalReason(options.adapterId));
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
    // A certified source that is already unhealthy must fail BEFORE the provider is paid.
    // Checking only afterwards let the first operation through, which defeats the point of
    // a preflight in the one mode that exists to guarantee measurement.
    if (strict && this.options.inferenceSource && !this.options.inferenceSource.isHealthy()) {
      throw new MeteringPreflightError(
        "certified metering channel is not healthy; refusing to dispatch billable work",
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
      lostReportsAtOpen: this.options.inferenceSource?.lostReportCount?.() ?? 0,
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
  async close(open: OpenOperation, input: CloseOperationInput): Promise<OperationMeteringRecord> {
    const strict = this.options.enforcement !== "best_effort";
    const source = this.options.inferenceSource;
    const certified = source ? await this.measureCertified(source, open, input) : null;
    const { usage, attributable, applicability, nextBaseline, ratingFailureReason, ratingComplete } =
      certified ?? this.measure(open, input);

    let pricingStatus: MeteringPricingStatus;
    // A post-operation rating failure is more specific than a preflight one, so it wins.
    let pricingFailureReason = ratingFailureReason ?? open.pricingFailureReason ?? undefined;

    // `pricingSource` describes PROVENANCE and is legitimately null on a multi-model
    // operation, where each model's source is engraved in its line item instead. Using it
    // as the "was this priced" signal marked fully-rated multi-model operations
    // pricing_unavailable and blocked strict mode on correctly priced work.
    if (usage.status !== "metered") {
      pricingStatus = "not_attributable";
    } else if (this.options.pricing === false) {
      pricingStatus = "not_configured";
    } else if (ratingComplete && attributable && isTotalComplete(attributable.ratedTotal)) {
      // Completeness is read off the DATA, not from a flag travelling beside it. The two
      // could drift, and did: a fully rated multi-model operation was once reported
      // pricing_unavailable because a separate signal disagreed with the total.
      pricingStatus = "priced";
    } else {
      pricingStatus = "pricing_unavailable";
    }

    // Swept before provenance so the attribution claim and the blocking decision are made
    // from the same facts, not from two separate reads of a moving source.
    const foreign = source?.drainForeign?.(open.internalSessionId) ?? [];
    const lostDuringOperation =
      (source?.lostReportCount?.() ?? 0) > open.lostReportsAtOpen;

    const provenance: MeteringProvenance =
      usage.status !== "metered"
        ? UNAVAILABLE_PROVENANCE
        : certified
          ? Object.freeze({
              source: "certified" as const,
              measurement: "provider_normalized" as const,
              // Still "observed", never "enforced": the plugin reports what the harness
              // ran, but a library cannot prove no model call bypassed it.
              routing: "observed" as const,
              // "complete" has to be EARNED. If the source lost a report while this
              // operation ran, some inference happened that we never saw, and claiming
              // complete attribution would be exactly the overstatement this design
              // refuses everywhere else.
              attribution:
                lostDuringOperation || foreign.length > 0
                  ? ("partial" as const)
                  : ("complete" as const),
              certificationId: source!.certificationId,
            })
          : acpProvenance(this.interpretation);

    this.state = accrueOperation(this.state, {
      attributable,
      applicability,
      baseline: nextBaseline,
      ...(foreign.length > 0 ? { unallocated: foreign.map(toUnallocated) } : {}),
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

    // Attribution gaps block billing_required only. telemetry_required is strict handling
    // of ACP telemetry and never claimed to account for every hidden inference, so holding
    // it to that standard would be a promise it was explicitly not making.
    if (this.options.enforcement === "billing_required" && !this._blocked) {
      if (lostDuringOperation) {
        this.block(
          `operation ${open.operationId}: certified source lost inference reports, so some ` +
            `billable work was never measured`,
        );
      } else if (foreign.length > 0) {
        this.block(
          `operation ${open.operationId}: observed ${foreign.length} inference(s) from ` +
            `another provider thread; usage was preserved as unallocated but cannot be ` +
            `attributed`,
        );
      }
    }

    return record;
  }

  /**
   * Measure an operation from per-inference records instead of ACP usage.
   *
   * Returns null when there is no certified measurement to make, so the caller falls back
   * to the ACP path — except in a strict mode, where an unhealthy source is a failure
   * rather than a silent downgrade to a backend known to undercount.
   */
  private async measureCertified(
    source: InferenceSource,
    open: OpenOperation,
    input: CloseOperationInput,
  ): Promise<ReturnType<MeteringEngine["measure"]> | null> {
    if (!source.isHealthy()) {
      return {
        usage: {
          status: "usage_unavailable",
          reason: "certified metering channel is not healthy",
        },
        attributable: null,
        applicability: open.policy?.categoryApplicability ?? null,
        nextBaseline: this.baseline,
      };
    }

    const inferences = source.drain(open.internalSessionId);
    if (inferences.length === 0) {
      // A prompt that reached the provider ran at least one inference. None means the
      // channel missed them, which is exactly the silent undercount this path exists to
      // prevent — so it is reported unavailable rather than as a free operation.
      return {
        usage: {
          status: "usage_unavailable",
          reason: "certified channel reported no inferences for this operation",
        },
        attributable: null,
        applicability: open.policy?.categoryApplicability ?? null,
        nextBaseline: this.baseline,
      };
    }

    const summed = sumInferenceTokens(inferences);
    const rated = await this.ratePerInference(open, inferences, input.billingFacts ?? {});
    return {
      usage: {
        status: "metered",
        reportedCumulative: summed,
        attributable: rated.usage,
      },
      attributable: rated.usage,
      applicability: open.policy?.categoryApplicability ?? UNKNOWN_APPLICABILITY,
      nextBaseline: this.baseline,
      ratingComplete: rated.complete,
      ...(rated.reason ? { ratingFailureReason: rated.reason } : {}),
    };
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
    /** Whether every reported category was actually rated. */
    ratingComplete?: boolean;
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
      ratingComplete: attributable.complete,
      // Why rating fell back to unpriced. Without this the record says
      // "pricing_unavailable" with no way to find out why.
      ...(attributable.reason ? { ratingFailureReason: attributable.reason } : {}),
    };
  }

  /**
   * Rate a certified operation one MODEL GROUP at a time.
   *
   * §7 makes a certified backend's rating unit the physical inference, and it matters:
   * a harness may run compaction or title generation on a different, cheaper model than
   * the one answering the prompt. Summing every inference and applying the operation's
   * model would price that work at the wrong rate, silently.
   *
   * The policy resolved at open() is reused for its own provider/model so the frozen price
   * still governs the work the caller asked for; any other model is resolved here, because
   * which models a turn would use cannot be known before it runs.
   */
  private async ratePerInference(
    open: OpenOperation,
    inferences: readonly ProviderInference[],
    facts: BillingFacts,
  ): Promise<{ usage: AttributableUsage; complete: boolean; reason?: string }> {
    const groups = new Map<string, ProviderInference[]>();
    for (const inference of inferences) {
      const key = `${inference.providerID}\u0000${inference.modelID}`;
      const group = groups.get(key);
      if (group) group.push(inference);
      else groups.set(key, [inference]);
    }

    // One model: the operation's own policy applies, unchanged.
    if (groups.size === 1) {
      const [only] = [...groups.values()];
      const first = only![0]!;
      if (first.providerID === open.providerId && first.modelID === open.model) {
        return this.rate(open, sumInferenceTokens(only!), facts);
      }
    }

    const parts: { usage: AttributableUsage; sample: ProviderInference }[] = [];
    let reason: string | undefined;
    for (const group of groups.values()) {
      const sample = group[0]!;
      const tokens = sumInferenceTokens(group);
      const matchesOperation =
        sample.providerID === open.providerId && sample.modelID === open.model;
      const policy = matchesOperation
        ? open.policy
        : await this.resolveForInference(open, sample);
      if (!policy) {
        reason ??= `no pricing policy for ${sample.providerID}/${sample.modelID}`;
        parts.push({ usage: unpricedUsage(tokens), sample });
        continue;
      }
      const selected = selectSchedule(policy, facts);
      if (!selected.ok) {
        reason ??= selected.reason;
        parts.push({ usage: unpricedUsage(tokens), sample });
        continue;
      }
      const rated = rateDelta(tokens, policy, selected.schedule);
      if (!rated.ok) {
        reason ??= rated.reason;
        parts.push({ usage: unpricedUsage(tokens), sample });
        continue;
      }
      parts.push({ usage: rated.usage, sample });
    }

    const combined = combineAttributable(parts);
    // Complete only when EVERY model group rated. One unpriceable model makes the
    // operation's total an understatement, whatever the others managed.
    const complete = parts.every((part) => isTotalComplete(part.usage.ratedTotal));
    return reason ? { usage: combined, complete, reason } : { usage: combined, complete };
  }

  /** Resolve a policy for a model the operation did not anticipate. */
  private async resolveForInference(
    open: OpenOperation,
    inference: ProviderInference,
  ): Promise<PricingPolicy | null> {
    if (this.options.pricing === false) return null;
    const resolved = await this.resolvePolicy(this.options.pricing, {
      scope: "inference",
      agentSessionId: this.options.agentSessionId,
      internalSessionId: open.internalSessionId,
      operationId: open.operationId,
      inferenceId: inference.messageID,
      adapterId: this.options.adapterId,
      providerId: inference.providerID,
      model: inference.modelID,
      operationKind: open.operationKind,
      at: inference.completedAt,
    });
    return resolved.ok ? resolved.policy : null;
  }

  private rate(
    open: OpenOperation,
    delta: TokenUsage,
    facts: BillingFacts,
  ): { usage: AttributableUsage; complete: boolean; reason?: string } {
    if (!open.policy) {
      // `pricing: false` is a choice, not a failure. Marking it unaccounted would make a
      // deliberately unrated session report lost costs.
      const reason = this.options.pricing === false ? "not_attempted" : "failed";
      return { usage: unpricedUsage(delta, reason), complete: this.options.pricing === false };
    }

    const selected = selectSchedule(open.policy, facts);
    if (!selected.ok) {
      return { usage: unpricedUsage(delta), complete: false, reason: selected.reason };
    }

    const rated = rateDelta(delta, open.policy, selected.schedule);
    if (!rated.ok) return { usage: unpricedUsage(delta), complete: false, reason: rated.reason };
    return { usage: rated.usage, complete: true };
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
    // Only an unambiguous single amount can be compared with the provider's single figure.
    // A multi-currency or incomplete total has no one number to reconcile.
    const rated = attributable ? soleAmount(attributable.ratedTotal) : null;
    if (!rated) {
      return {
        status: "unavailable",
        reason: attributable
          ? "operation has no single rated amount to compare"
          : "operation was not rated",
      };
    }
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
    // Agreement is judged on the ratio, not on string equality. Provider cost arrives as
    // a JSON float, so subtracting two cumulative values yields artifacts like
    // 0.002577469999999998 against an exact 0.00257747 — the same number, and an exact
    // comparison would report a discrepancy on every operation. The ratio rounds at scale
    // 6, which is far tighter than any real undercount (the measured ones were 2x-3.4x).
    const ratio = ratioOf(delta, rated);
    return {
      status: "checked",
      providerDelta: delta,
      ratedTotal: rated,
      ratio,
      matches: ratio === "1",
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

/**
 * Sum the token counts of every inference in an operation.
 *
 * OpenCode's categories are disjoint — measured across five providers, input + output +
 * reasoning + cache equals its reported total exactly — so summing them per category and
 * recomputing the total is faithful rather than an approximation.
 *
 * A category absent from EVERY inference stays absent: a model that never reported cache
 * has told us nothing, and zero-filling would claim it cached nothing.
 */
export function sumInferenceTokens(inferences: readonly ProviderInference[]): TokenUsage {
  let input = 0;
  let output = 0;
  let cachedRead: number | null = null;
  let cachedWrite: number | null = null;
  let thought: number | null = null;

  for (const inference of inferences) {
    const tokens = inference.tokens;
    input += tokens.inputTokens;
    output += tokens.outputTokens;
    if (tokens.cachedReadTokens !== undefined) cachedRead = (cachedRead ?? 0) + tokens.cachedReadTokens;
    if (tokens.cachedWriteTokens !== undefined) cachedWrite = (cachedWrite ?? 0) + tokens.cachedWriteTokens;
    if (tokens.thoughtTokens !== undefined) thought = (thought ?? 0) + tokens.thoughtTokens;
  }

  return Object.freeze({
    totalTokens: input + output + (cachedRead ?? 0) + (cachedWrite ?? 0) + (thought ?? 0),
    inputTokens: input,
    outputTokens: output,
    ...(cachedRead !== null ? { cachedReadTokens: cachedRead } : {}),
    ...(cachedWrite !== null ? { cachedWriteTokens: cachedWrite } : {}),
    ...(thought !== null ? { thoughtTokens: thought } : {}),
  });
}

/**
 * Merge per-model-group ratings into one operation-level view.
 *
 * Subtotals stay as each group rated them, so a record still adds up, but the engraved
 * unit price belongs to whichever group priced that category — with several models in one
 * operation there is no single rate to show. `pricingKey` is kept only when every group
 * agreed, rather than presenting one model's key as if it covered the whole operation.
 */
/**
 * Merge per-model ratings into one operation-level view WITHOUT inventing a blended rate.
 *
 * An earlier version kept the first group's unit price beside a cost summed across groups
 * priced differently, so `tokens x unitPrice` did not reproduce `ratedCost` and the record
 * could not be recomputed — the one property §6 and §8 exist to protect.
 *
 * Now the top level carries tokens and the exact total, per-category `pricing` is null
 * because no single rate applies, and `lineItems` carries each model's own rated detail.
 */
function combineAttributable(
  parts: readonly { usage: AttributableUsage; sample: ProviderInference }[],
): AttributableUsage {
  if (parts.length === 1) return parts[0]!.usage;

  const categories = ["input", "output", "cachedRead", "cachedWrite", "thought"] as const;
  const merged: Partial<Record<(typeof categories)[number], PricedTokenAmount>> = {};
  for (const category of categories) {
    const present = parts
      .map((part) => part.usage[category])
      .filter((amount): amount is PricedTokenAmount => amount !== undefined);
    if (present.length === 0) continue;
    merged[category] = Object.freeze({
      reportedTokens: present.reduce((total, amount) => total + amount.reportedTokens, 0),
      pricedTokens: present.every((amount) => amount.pricedTokens !== null)
        ? present.reduce((total, amount) => total + (amount.pricedTokens ?? 0), 0)
        : null,
      // Deliberately null: several rates priced these tokens, and naming one would make
      // the record look recomputable when it is not. See lineItems.
      pricing: null,
    });
  }

  // Merged, never dropped. The previous version discarded a line item whose currency could
  // not be added — producing a total of 10 beside line items summing to 20, reported as
  // fully priced.
  let ratedTotal = EMPTY_MONEY_TOTAL;
  for (const part of parts) ratedTotal = mergeTotals(ratedTotal, part.usage.ratedTotal);

  const lineItems = parts.map((part) =>
    Object.freeze({
      providerId: part.sample.providerID,
      modelId: part.sample.modelID,
      tier: part.usage.pricingKey?.tier ?? "unrated",
      pricingSource: part.usage.pricingSource,
      cacheInputConvention: part.usage.cacheInputConvention,
      totalTokens: part.usage.totalTokens,
      input: part.usage.input,
      output: part.usage.output,
      ...(part.usage.cachedRead ? { cachedRead: part.usage.cachedRead } : {}),
      ...(part.usage.cachedWrite ? { cachedWrite: part.usage.cachedWrite } : {}),
      ...(part.usage.thought ? { thought: part.usage.thought } : {}),
      ratedTotal: part.usage.ratedTotal,
    }),
  );

  return Object.freeze({
    reportedDelta: sumInferenceTokens(
      parts.map((part) => ({ tokens: part.usage.reportedDelta }) as ProviderInference),
    ),
    // Source and key describe ONE model; with several there is no single answer, and the
    // line items carry the per-model identities instead.
    pricingSource: null,
    pricingKey: null,
    cacheInputConvention: null,
    totalTokens: parts.reduce((total, part) => total + part.usage.totalTokens, 0),
    input: merged.input!,
    output: merged.output!,
    ...(merged.cachedRead ? { cachedRead: merged.cachedRead } : {}),
    ...(merged.cachedWrite ? { cachedWrite: merged.cachedWrite } : {}),
    ...(merged.thought ? { thought: merged.thought } : {}),
    ratedTotal,
    lineItems: Object.freeze(lineItems),
  });
}

/**
 * Describe an inference no operation can claim.
 *
 * Uses the harness's own cost rather than rating it here: pricing would need a policy for
 * a model no operation selected, and the provider has already priced the work. A cost that
 * cannot be represented becomes null — never zero, which would understate a reconciliation
 * against an invoice.
 */
function toUnallocated(inference: ProviderInference): UnallocatedUsageAccrual {
  const decimal = inference.cost === null ? null : decimalFromNumber(inference.cost);
  return {
    usage: inference.tokens,
    // OpenCode reports cost in USD; the currency travels with the figure so a consumer
    // never has to infer it.
    ratedCost: decimal?.ok ? { amount: decimal.value, currency: "USD" } : null,
    reason: `inference from provider thread ${inference.sessionID}`,
  };
}
