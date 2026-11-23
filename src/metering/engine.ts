import { requireNativeMeteringCapability } from "./native/requirements.ts";
// Per-operation metering. See §7 (rating units), §8, §9, §11, §12.
//
// The engine owns one rating unit per ACP operation: resolve and freeze a pricing policy
// BEFORE dispatch, then after the operation subtract the baseline, select one schedule
// from the frozen policy, and rate. Resolving before dispatch is what makes a strict mode
// able to fail preflight instead of after the provider has already been paid, and what
// stops a mid-flight configuration change from repricing work already sent.

import type { TokenUsage } from "../types.ts";
import {
  TOKEN_CATEGORY_KEYS,
  disjointTokenUsage,
  type TokenCategoryKey,
} from "./categories.ts";
import type { ContextWindowStatus, ProviderCostSnapshot } from "./context.ts";
import { baselineMatches, calculateDelta } from "./delta.ts";
import {
  MeteringPreflightError,
  type MeteredOperationKind,
  type MeteringEnforcement,
  type MeteringPricingStatus,
  type MeteringUsageResult,
  type OperationMeteringRecord,
  type OperationOutcome,
  type CostReconciliation,
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
import { measurementProvenance } from "./measurement-provenance.ts";
import { measureNativeTurn, nativeRouteUnavailable } from "./native/operation.ts";
import { UNVERIFIED_NATIVE_SOURCE, type NativeTurnMetering } from "./native/source.ts";
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
   * Reports known skipped and not yet filled, for this provider thread.
   *
   * RETRACTABLE — a late arrival discharges its own gap, so this can fall. The engine asks
   * it as a STATE question at close rather than comparing a counter across the operation,
   * because a delta over a retractable value is meaningless.
   */
  outstandingReports?(internalSessionId: string | null): number;
  /**
   * Reports the source refused and can never receive.
   *
   * Permanent, and therefore the only loss that justifies stopping a billing session: that
   * usage is unaccounted anywhere, whereas a late report still lands in unallocated usage.
   */
  permanentlyLostCount?(): number;
  /** Highest sequence recorded for a thread, used to recognise a late arrival at close. */
  sequenceHighWater?(internalSessionId: string | null): number;
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
  readonly native?: boolean;
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
  /** Permanently-lost count at open, to spot a refusal during this operation. */
  readonly permanentlyLostAtOpen: number;
  /**
   * Sequence high-water when the operation opened.
   *
   * A record drained at close whose sequence is at or below this was expected before the
   * operation began — it is LATE, and belongs to unallocated usage rather than being
   * charged to whichever operation happens to be draining.
   */
  readonly sequenceHighWaterAtOpen: number;
  readonly nativeChannel?: string;
}

export interface CloseOperationInput {
  readonly outcome: OperationOutcome;
  /** Normalized cumulative report, or null when the harness supplied none. */
  readonly reportedCumulative: TokenUsage | null;
  readonly usageFailureReason?: string;
  readonly contextAfter: ContextWindowStatus | null;
  readonly providerCostAfter: ProviderCostSnapshot | null;
  readonly billingFacts?: BillingFacts;
  readonly nativeMetering?: NativeTurnMetering;
}

export interface OpenDetachedOperation {
  readonly engine: MeteringEngine;
  readonly operation: OpenOperation;
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
  private readonly inferenceSource: InferenceSource | undefined;
  /** Provider cumulative cost as of the previous close, for per-operation deltas. */
  private lastProviderCost: Money | null = null;
  /** Records drained this close that belong to an operation already finished. */
  private lateArrivals: readonly ProviderInference[] = [];

  constructor(private readonly options: MeteringEngineOptions) {
    if (options.native) requireNativeMeteringCapability(options.enforcement);
    const source = options.inferenceSource;
    this.inferenceSource = source?.certificationId === UNVERIFIED_NATIVE_SOURCE ? undefined : source;
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
      (!certification || this.inferenceSource?.certificationId !== certification.certificationId)
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
  /** Reports the certified source is still missing for a thread; retractable. */
  outstandingReports(internalSessionId: string | null): number {
    return this.inferenceSource?.outstandingReports?.(internalSessionId) ?? 0;
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
    if (!keep) {
      this.baseline = null;
      // The serializable state is a continuation checkpoint, not only accumulated totals.
      // Carrying the replaced thread's baseline here can make a later restore look valid
      // until the controller reconnects, and makes a mode-transition checkpoint lie.
      if (this.state.activeBaseline !== null) {
        this.state = Object.freeze({ ...this.state, activeBaseline: null });
      }
    }
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
    native?: { readonly host: { readonly sessionId: string }; readonly channelId: string };
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
    if (strict && this.inferenceSource && !this.inferenceSource.isHealthy()) {
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

    if (input.native) {
      pricingFailureReason = nativeRouteUnavailable;
    } else if (this.options.pricing === false) {
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
      internalSessionId: input.native ? `${input.native.host.sessionId}/${input.native.channelId}` : input.internalSessionId,
      providerId: input.native ? null : input.providerId,
      model: input.native ? null : input.model,
      ...(input.native ? { nativeChannel: input.native.channelId } : {}),
      policy,
      pricingFailureReason,
      permanentlyLostAtOpen: this.inferenceSource?.permanentlyLostCount?.() ?? 0,
      sequenceHighWaterAtOpen:
        this.inferenceSource?.sequenceHighWater?.(input.internalSessionId) ?? 0,
    });
  }

  /**
   * Open work on a disposable provider thread without changing the visible thread's
   * cumulative-counter baseline. The returned unit must be closed with closeDetached().
   */
  async openDetached(input: {
    operationId: string;
    operationKind: MeteredOperationKind;
    internalSessionId: string;
    providerId: string | null;
    model: string | null;
  }): Promise<OpenDetachedOperation> {
    const engine = new MeteringEngine({
      ...this.options,
      initialState: emptyMeteringState(this.options.agentSessionId),
      createdActiveThread: true,
    });
    const operation = await engine.open({ ...input, degraded: false });
    return Object.freeze({ engine, operation });
  }

  /** Accrue a disposable thread's operation while preserving the visible baseline. */
  async closeDetached(
    detached: OpenDetachedOperation,
    input: CloseOperationInput,
  ): Promise<OperationMeteringRecord> {
    const detachedRecord = await detached.engine.close(detached.operation, input);
    const attributable = detachedRecord.usage.status === "metered"
      ? detachedRecord.usage.attributable
      : null;
    this.state = accrueOperation(this.state, {
      attributable,
      applicability: detached.operation.policy?.categoryApplicability ?? null,
      baseline: this.baseline,
    });
    const record = Object.freeze({ ...detachedRecord, nextState: this.state });
    this._lastOperation = record;
    if (detached.engine.blocked && !this._blocked) {
      this.block(detached.engine.blockedReason ?? "detached metering failed");
    }
    return record;
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
    const cursor = this.state.nativeCursor;
    const native = open.nativeChannel === undefined ? undefined : await measureNativeTurn(open.nativeChannel, input.nativeMetering,
      cursor?.channelKey === open.internalSessionId ? cursor.after : undefined);
    const source = native ? undefined : this.inferenceSource;
    const certified = source ? await this.measureCertified(source, open, input) : null;
    const { usage, attributable, applicability, nextBaseline, ratingFailureReason, ratingComplete } =
      native ? { ...native, nextBaseline: this.baseline } : certified ?? this.measure(open, input);

    let pricingStatus: MeteringPricingStatus;
    const pricingFailureReason = ratingFailureReason ?? open.pricingFailureReason ?? undefined;

    // `pricingSource` describes PROVENANCE and is legitimately null on a multi-model
    // operation, where each model's source is engraved in its line item instead. Using it
    // as the "was this priced" signal marked fully-rated multi-model operations
    // pricing_unavailable and blocked strict mode on correctly priced work.
    if (usage.status !== "metered") {
      pricingStatus = "not_attributable";
    } else if (this.options.pricing === false && !native) {
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
    // A STATE question, not a delta: gaps are retractable, so "did a counter rise" is not
    // answerable. What matters is whether anything is still missing now, at close.
    const outstanding = source?.outstandingReports?.(open.internalSessionId) ?? 0;
    const permanentlyLost =
      (source?.permanentlyLostCount?.() ?? 0) > open.permanentlyLostAtOpen;

    const provenance = native?.provenance ?? measurementProvenance(usage, this.interpretation,
      certified ? source?.certificationId : undefined, outstanding > 0 || permanentlyLost || foreign.length > 0);

    this.state = accrueOperation(this.state, {
      attributable,
      applicability,
      baseline: nextBaseline,
      partial: native?.usage.status === "metered" && native.usage.reason !== undefined,
      ...(foreign.length > 0 || this.lateArrivals.length > 0
        ? {
            unallocated: [
              ...foreign.map((inference) => toUnallocated(inference, "foreign")),
              ...this.lateArrivals.map((inference) => toUnallocated(inference, "late")),
            ],
          }
        : {}),
    });
    this.baseline = nextBaseline;
    if (nextBaseline) this.trustedZeroBaseline = false;
    if (native?.accountedThrough && open.internalSessionId) {
      this.state = Object.freeze({ ...this.state, nativeCursor: { channelKey: open.internalSessionId, after: native.accountedThrough } });
    }

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
      ...(native ? { nativeUsage: native.evidence } : {}),
      pricingStatus,
      ...(pricingFailureReason ? { pricingFailureReason } : {}),
      contextAfter: input.contextAfter,
      providerCostAfter: input.providerCostAfter,
      costReconciliation: this.reconcileCost(attributable, input.providerCostAfter),
      nextState: this.state,
    });
    this.lastProviderCost = input.providerCostAfter?.cumulative ?? this.lastProviderCost;
    this.lateArrivals = [];

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
      // Only PERMANENT loss blocks. An outstanding gap usually resolves moments later and
      // its usage then lands in unallocated — visible, costed, reconcilable — so the
      // promise "never silently under-account" still holds, and the record already says
      // `attribution: partial`. Blocking a production session on a loopback reorder costs
      // more than it prevents. A refused record is different: that usage is accounted
      // nowhere and never will be.
      if (permanentlyLost) {
        this.block(
          `operation ${open.operationId}: certified source refused inference reports for ` +
            `capacity, so some billable work can never be measured`,
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

    const drained = source.drain(open.internalSessionId);
    // A record whose sequence predates this operation's start was expected earlier: it is
    // a LATE arrival belonging to an operation already closed. Charging it here would
    // misattribute it, so it goes to unallocated usage instead — which is what makes it
    // defensible not to block on an outstanding gap.
    // `typeof`, not `=== null`: a source that omits `sequence` yields undefined, and
    // comparing that against the high-water mark is false — which silently classified
    // EVERY record as late and reported the operation unmeasured. An absent sequence means
    // "no ordering information", which must default to keeping the record.
    const isLate = (inference: ProviderInference): boolean =>
      typeof inference.sequence === "number" &&
      inference.sequence <= open.sequenceHighWaterAtOpen;
    const inferences = drained.filter((inference) => !isLate(inference));
    this.lateArrivals = drained.filter(isLate);
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
    // `pricing: false` is a choice everywhere, including here. The single-model fast path
    // already honoured it; a multi-model operation was still recording each group as a
    // failed rating, so a deliberately unrated session accumulated phantom losses.
    const unpricedReason = this.options.pricing === false ? "not_attempted" : "failed";
    for (const group of groups.values()) {
      const sample = group[0]!;
      const tokens = sumInferenceTokens(group);
      const matchesOperation =
        sample.providerID === open.providerId && sample.modelID === open.model;
      const policy = matchesOperation
        ? open.policy
        : await this.resolveForInference(open, sample);
      if (!policy) {
        if (unpricedReason === "failed") {
          reason ??= `no pricing policy for ${sample.providerID}/${sample.modelID}`;
        }
        parts.push({ usage: unpricedUsage(tokens, unpricedReason), sample });
        continue;
      }
      const selected = selectSchedule(policy, facts);
      if (!selected.ok) {
        reason ??= selected.reason;
        parts.push({ usage: unpricedUsage(tokens, "failed"), sample });
        continue;
      }
      const rated = rateDelta(tokens, policy, selected.schedule);
      if (!rated.ok) {
        reason ??= rated.reason;
        parts.push({ usage: unpricedUsage(tokens, "failed"), sample });
        continue;
      }
      parts.push({ usage: rated.usage, sample });
    }

    const combined = combineAttributable(parts);
    // Complete only when EVERY model group rated. One unpriceable model makes the
    // operation's total an understatement, whatever the others managed.
    // With pricing off, "complete" means nothing was lost — not that everything was rated.
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
  /**
   * Adopt totals accumulated by a parallel engine that is being discarded.
   *
   * A transition meters its target on its own engine, because the target's counters start
   * at zero. When the transition fails, those operations were still minted, reported and
   * paid for, so their totals belong to the session that remains. Unlike `reconcile` this
   * is not a correction: nothing this engine measured was wrong, so its own baseline and
   * any block it is under both stand.
   */
  adoptAccounting(state: AgentSessionMeteringState): void {
    this.state = Object.freeze({ ...state, activeBaseline: this.state.activeBaseline });
  }

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

  return disjointTokenUsage({ input, output, cachedRead, cachedWrite, thought });
}

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

  const merged: Partial<Record<TokenCategoryKey, PricedTokenAmount>> = {};
  for (const category of TOKEN_CATEGORY_KEYS) {
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
function toUnallocated(
  inference: ProviderInference,
  kind: "foreign" | "late",
): UnallocatedUsageAccrual {
  const decimal = inference.cost === null ? null : decimalFromNumber(inference.cost);
  return {
    usage: inference.tokens,
    // OpenCode reports cost in USD; the currency travels with the figure so a consumer
    // never has to infer it.
    ratedCost: decimal?.ok ? { amount: decimal.value, currency: "USD" } : null,
    reason:
      kind === "foreign"
        ? `inference from provider thread ${inference.sessionID}`
        : `report arrived after the operation it belonged to had closed`,
  };
}
