// The operation metering record and its enforcement policy. See §9, §12.
//
// One record per ACP operation the library can observe — not one per hidden model
// inference. An ACP prompt may conceal retries, compaction, or several model calls, and
// the ACP-derived backend cannot see them; a certified backend can, and says so through
// provenance.
//
// An unavailable record is still a record. It proves an operation happened while refusing
// to assert it cost zero, which is the difference between "we don't know" and a false
// accounting entry.

import type { TokenUsage } from "../types.ts";
import type { ContextWindowStatus, ProviderCostSnapshot } from "./context.ts";
import type { Money } from "./money.ts";
import type { AttributableUsage } from "./rating.ts";
import type { AgentSessionMeteringState, StateRestoration } from "./state.ts";
import type { PricingConfiguration } from "./pricing.ts";
import type { InferenceSource } from "./engine.ts";

export type MeteredOperationKind =
  | "prompt"
  | "internal_command"
  | "handoff_summary"
  | "handoff_seed";

export type OperationOutcome = "completed" | "cancelled" | "error";

export type MeteringUsageResult =
  | {
      readonly status: "metered";
      readonly reportedCumulative: TokenUsage;
      readonly attributable: AttributableUsage;
    }
  | {
      readonly status: "usage_unavailable" | "baseline_required" | "counter_reset";
      readonly reportedCumulative?: TokenUsage;
      readonly reason: string;
    };

export type MeteringPricingStatus =
  | "priced"
  | "not_configured"
  | "not_attributable"
  | "pricing_unavailable";

export interface ProviderIdentitySnapshot {
  readonly adapterId: string;
  /** Provider catalog key when established by structured evidence, else null. */
  readonly providerId: string | null;
  readonly model: string | null;
}

/**
 * Where a record's numbers came from and how far they can be trusted.
 *
 * These describe EVIDENCE, not configuration. A consumer cannot promote a record by
 * asserting a stronger provenance: `routing` in particular is only ever "observed" or
 * "unknown" here, because a library spawning a subprocess cannot verify that no model
 * traffic bypassed it. Network isolation is a deployment property, not a library claim.
 */
export interface MeteringProvenance {
  readonly source: "certified" | "acp_usage" | "none";
  readonly measurement: "provider_normalized" | "acp_derived" | "unavailable";
  readonly routing: "observed" | "unknown";
  readonly attribution: "complete" | "partial" | "unavailable";
  /** Present for ACP-derived cumulative delta records. */
  readonly counterInterpretation?: "cumulative" | "per_turn";
  /** Present only when a recognized certified integration produced the record. */
  readonly certificationId?: string;
}

/**
 * Our rated cost checked against the provider's own reported cost for the same operation.
 *
 * The ACP-derived backend sees one record per ACP operation, but a harness may run SEVERAL
 * model inferences inside one — measured on OpenCode, a turn with N tool calls bills for
 * roughly N+1 inferences while `PromptResponse.usage` reports one. Token math alone cannot
 * detect that; the provider's own cumulative cost can.
 *
 * `ratio` is providerDelta / ratedTotal. 1 means we accounted for everything; 3.43 means
 * the provider charged 3.43x what we saw. Consumers choose their own tolerance — a
 * scale-12 rounding difference is not the same as a missing inference.
 */
export type CostReconciliation =
  | {
      readonly status: "checked";
      /** Provider cumulative cost consumed by this operation. */
      readonly providerDelta: Money;
      readonly ratedTotal: Money;
      /** providerDelta / ratedTotal at scale 6, or null when it cannot be formed. */
      readonly ratio: string | null;
      /** True only when the two agree exactly. */
      readonly matches: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly reason: string;
    };

export interface OperationMeteringRecord {
  readonly operationId: string;
  readonly operationKind: MeteredOperationKind;
  readonly outcome: OperationOutcome;
  readonly startedAt: number;
  readonly completedAt: number;

  readonly agentSessionId: string;
  readonly internalSessionId: string | null;
  readonly provider: ProviderIdentitySnapshot;
  readonly provenance: MeteringProvenance;

  readonly usage: MeteringUsageResult;
  readonly pricingStatus: MeteringPricingStatus;
  readonly pricingFailureReason?: string;
  /** Latest observation received by completion; not guaranteed to include this operation. */
  readonly contextAfter: ContextWindowStatus | null;
  /** Latest cumulative provider observation; not asserted to be an invoice. */
  readonly providerCostAfter: ProviderCostSnapshot | null;
  /**
   * Our rated cost against the provider's own, when both are available.
   *
   * The only signal the ACP-derived backend has for inferences it could not see.
   */
  readonly costReconciliation: CostReconciliation;

  /** State the consumer can persist and pass to a reopened AgentSession. */
  readonly nextState: AgentSessionMeteringState;
}

/**
 * Evidence policy, not authentication type. There is no subscription mode and no
 * subscription inference.
 *
 * `telemetry_required` is strict handling of ACP-derived telemetry — useful for tests and
 * for consumers that prefer to stop rather than accumulate gaps. It is explicitly NOT a
 * billing guarantee: ACP advertises no usage capability, so the library can fail fast on
 * known preflight conditions but cannot prove a harness will return usage until it does.
 *
 * `billing_required` needs a registered certified integration and is rejected until one
 * exists. Plain ACP usage can never activate it.
 */
export type MeteringEnforcement = "best_effort" | "telemetry_required" | "billing_required";

export interface MeteringConfig {
  readonly enforcement?: MeteringEnforcement;
  readonly pricing?: PricingConfiguration;
  readonly initialState?: AgentSessionMeteringState;
  /**
   * Override how this harness's ACP counters are read.
   *
   * Defaults to the adapter's measured evidence. Supply it when you know your harness
   * version reports differently than the library has recorded — it is evidence you are
   * asserting, and it is stamped into every record's provenance. The library never infers
   * it at runtime (§4).
   */
  readonly counterInterpretation?: "cumulative" | "per_turn";
  /**
   * A certified per-inference source, replacing ACP usage as the measurement.
   *
   * Required by `billing_required`: ACP reports one inference per prompt while a
   * tool-using turn bills several. See `createOpencodeMetering()`.
   */
  readonly inferenceSource?: InferenceSource;
}

export interface AgentSessionMeteringSnapshot extends AgentSessionMeteringState {
  readonly enforcement: MeteringEnforcement;
  readonly restoration: Exclude<StateRestoration, { status: "restored" }> | { status: "restored"; version: 2 };
  readonly blocked: boolean;
  readonly blockedReason: string | null;
  readonly lastOperation: OperationMeteringRecord | null;
}

/**
 * Provenance for an ACP-derived record.
 *
 * The interpretation is stamped in rather than assumed, so a stored record says how its
 * counters were read — the one thing ACP itself does not settle.
 */
export function acpProvenance(
  counterInterpretation: "cumulative" | "per_turn",
): MeteringProvenance {
  return Object.freeze({
    source: "acp_usage",
    measurement: "acp_derived",
    routing: "unknown",
    attribution: "partial",
    counterInterpretation,
  });
}

/** Provenance for an ordinary cumulative ACP-derived record. */
export const ACP_PROVENANCE: MeteringProvenance = acpProvenance("cumulative");

/** Provenance for an operation whose usage could not be established at all. */
export const UNAVAILABLE_PROVENANCE: MeteringProvenance = Object.freeze({
  source: "none",
  measurement: "unavailable",
  routing: "unknown",
  attribution: "unavailable",
});

export interface MeteringReconciliation {
  readonly state: AgentSessionMeteringState;
  readonly reason: string;
  /** Consumer/provider incident, invoice, or audit identifier. */
  readonly reference?: string;
}

/** Thrown when a strict mode refuses to start or continue a token-consuming operation. */
export class MeteringPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeteringPreflightError";
  }
}

/**
 * Thrown when an AgentSession operation fails, carrying the metering record.
 *
 * A failed operation can still have consumed tokens, so the record has to survive the
 * rejection rather than only reaching event subscribers.
 */
export class AgentSessionOperationError extends Error {
  readonly operationId: string;
  readonly metering: OperationMeteringRecord;

  constructor(operationId: string, metering: OperationMeteringRecord, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AgentSessionOperationError";
    this.operationId = operationId;
    this.metering = metering;
  }
}

/**
 * Thrown when a handoff fails, carrying the records it produced before and during failure.
 *
 * A rejected handoff cannot return a HandoffResult, but the summary and seed prompts it
 * already ran consumed real tokens, so their records must still reach the caller.
 */
export class AgentSessionHandoffError extends Error {
  readonly handoffId: string;
  readonly meteringRecords: readonly OperationMeteringRecord[];

  constructor(
    handoffId: string,
    meteringRecords: readonly OperationMeteringRecord[],
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AgentSessionHandoffError";
    this.handoffId = handoffId;
    this.meteringRecords = Object.freeze([...meteringRecords]);
  }
}
