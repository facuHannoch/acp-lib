// Bounded live metering state and its accumulation rules. See 9-6-SPEC-metering.md §11.
//
// The session keeps totals, the active baseline, and the last record — never an unbounded
// operation history. Consumers own durable accounting; the library hands them each
// immutable record plus the state to persist beside it.
//
// The counters exist so a partial total cannot look complete. "180k tokens" and "at least
// 180k tokens, with two operations we could not measure" are different claims, and per
// category they are different again: a harness may report input and output while never
// mentioning cache. Coverage distinguishes a category nobody could measure from one the
// model simply does not use.

import type { TokenUsage } from "../types.ts";
import { addMoney, canonicalizeMoney, isValidMoney, type Money } from "./money.ts";
import type { CategoryApplicability, TokenCategory } from "./pricing.ts";
import type { AttributableUsage } from "./rating.ts";

export type CategoryCoverage = "complete" | "partial" | "none" | "not_applicable";

export interface UsageCategoryTotal {
  /** Sum of deltas that were actually attributable; always a lower bound. */
  readonly knownTokens: number;
  /** Applicable operations that supplied an attributable value, including explicit 0. */
  readonly attributedOperationCount: number;
  /** Operations explicitly known not to use this category. */
  readonly notApplicableOperationCount: number;
  /** Applicable/unknown operations for which this category could not be established. */
  readonly unavailableOperationCount: number;
  readonly coverage: CategoryCoverage;
}

export interface AggregateUsageTotal {
  readonly knownTokens: number;
  readonly attributedOperationCount: number;
  readonly unavailableOperationCount: number;
  /** Total usage is always applicable, so this never reads "not_applicable". */
  readonly coverage: "complete" | "partial" | "none";
}

export interface UsageTotals {
  readonly total: AggregateUsageTotal;
  readonly input: UsageCategoryTotal;
  readonly output: UsageCategoryTotal;
  readonly cachedRead: UsageCategoryTotal;
  readonly cachedWrite: UsageCategoryTotal;
  readonly thought: UsageCategoryTotal;
}

export interface UnallocatedUsageState {
  /** Number of observed inference records not assigned to an operation. */
  readonly recordCount: number;
  /** Known unallocated tokens. Absent categories remain absent, never zero-filled. */
  readonly knownTokens: Partial<TokenUsage>;
  /** Rated unallocated amounts, accumulated separately by currency. */
  readonly ratedCosts: readonly Money[];
}

export interface MeteringBaseline {
  readonly adapterId: string;
  readonly internalSessionId: string;
  readonly reportedUsage: TokenUsage;
}

export interface AgentSessionMeteringState {
  readonly version: 2;
  readonly agentSessionId: string;
  readonly operationCount: number;
  readonly meteredOperationCount: number;
  readonly unmeteredOperationCount: number;
  readonly totals: UsageTotals;
  readonly ratedCosts: readonly Money[];
  readonly unallocatedUsage: UnallocatedUsageState;
  readonly activeBaseline: MeteringBaseline | null;
}

export const METERING_STATE_VERSION = 2;

/** Category → the TokenUsage field carrying it. */
const CATEGORY_FIELD: Readonly<Record<TokenCategory, keyof TokenUsage>> = Object.freeze({
  input: "inputTokens",
  output: "outputTokens",
  cached_read: "cachedReadTokens",
  cached_write: "cachedWriteTokens",
  thought: "thoughtTokens",
});

/** Category → the UsageTotals field carrying it. */
const CATEGORY_TOTAL: Readonly<Record<TokenCategory, keyof Omit<UsageTotals, "total">>> =
  Object.freeze({
    input: "input",
    output: "output",
    cached_read: "cachedRead",
    cached_write: "cachedWrite",
    thought: "thought",
  });

function emptyCategoryTotal(): UsageCategoryTotal {
  return Object.freeze({
    knownTokens: 0,
    attributedOperationCount: 0,
    notApplicableOperationCount: 0,
    unavailableOperationCount: 0,
    coverage: "none" as const,
  });
}

function deriveCoverage(total: Omit<UsageCategoryTotal, "coverage">): CategoryCoverage {
  const { attributedOperationCount, notApplicableOperationCount, unavailableOperationCount } = total;
  const seen = attributedOperationCount + notApplicableOperationCount + unavailableOperationCount;
  if (seen === 0) return "none";
  // Wholly inapplicable: a non-reasoning model never reports thought tokens, and that is
  // not a metering gap.
  if (notApplicableOperationCount === seen) return "not_applicable";
  if (unavailableOperationCount === 0) return "complete";
  if (attributedOperationCount === 0) return "none";
  return "partial";
}

export function emptyMeteringState(agentSessionId: string): AgentSessionMeteringState {
  return Object.freeze({
    version: METERING_STATE_VERSION as 2,
    agentSessionId,
    operationCount: 0,
    meteredOperationCount: 0,
    unmeteredOperationCount: 0,
    totals: Object.freeze({
      total: Object.freeze({
        knownTokens: 0,
        attributedOperationCount: 0,
        unavailableOperationCount: 0,
        coverage: "none" as const,
      }),
      input: emptyCategoryTotal(),
      output: emptyCategoryTotal(),
      cachedRead: emptyCategoryTotal(),
      cachedWrite: emptyCategoryTotal(),
      thought: emptyCategoryTotal(),
    }),
    ratedCosts: Object.freeze([]),
    unallocatedUsage: Object.freeze({
      recordCount: 0,
      knownTokens: Object.freeze({}),
      ratedCosts: Object.freeze([]),
    }),
    activeBaseline: null,
  });
}

export interface OperationAccrual {
  /** Attributable usage, or null when the operation could not be measured. */
  readonly attributable: AttributableUsage | null;
  /** Applicability from the resolved policy; unknown when no policy was resolved. */
  readonly applicability: Readonly<Record<TokenCategory, CategoryApplicability>> | null;
  readonly baseline: MeteringBaseline | null;
}

/**
 * Fold one completed operation into the running state.
 *
 * Returns a new frozen state; the previous one stays valid, because records already handed
 * to a consumer embed it.
 */
export function accrueOperation(
  previous: AgentSessionMeteringState,
  accrual: OperationAccrual,
): AgentSessionMeteringState {
  const { attributable, applicability } = accrual;
  const measured = attributable !== null;

  const aggregate = previous.totals.total;
  const nextAggregate = {
    knownTokens: aggregate.knownTokens + (attributable?.totalTokens ?? 0),
    attributedOperationCount: aggregate.attributedOperationCount + (measured ? 1 : 0),
    unavailableOperationCount: aggregate.unavailableOperationCount + (measured ? 0 : 1),
  };

  const categoryTotals: Record<string, UsageCategoryTotal> = {};
  for (const category of Object.keys(CATEGORY_FIELD) as TokenCategory[]) {
    const key = CATEGORY_TOTAL[category];
    const current = previous.totals[key];
    const value = attributable?.reportedDelta[CATEGORY_FIELD[category]];
    const notApplicable = applicability?.[category] === "not_applicable";

    const next = {
      knownTokens: current.knownTokens + (value ?? 0),
      // An explicit reported zero counts as attributed: it is a measurement, unlike an
      // absent counter.
      attributedOperationCount: current.attributedOperationCount + (value !== undefined ? 1 : 0),
      notApplicableOperationCount:
        current.notApplicableOperationCount + (value === undefined && notApplicable ? 1 : 0),
      unavailableOperationCount:
        current.unavailableOperationCount + (value === undefined && !notApplicable ? 1 : 0),
    };
    categoryTotals[key] = Object.freeze({ ...next, coverage: deriveCoverage(next) });
  }

  let ratedCosts = previous.ratedCosts;
  if (attributable?.ratedTotal) {
    const accumulated = accumulateByCurrency(previous.ratedCosts, attributable.ratedTotal);
    if (accumulated.ok) ratedCosts = accumulated.value;
  }

  return Object.freeze({
    ...previous,
    operationCount: previous.operationCount + 1,
    meteredOperationCount: previous.meteredOperationCount + (measured ? 1 : 0),
    unmeteredOperationCount: previous.unmeteredOperationCount + (measured ? 0 : 1),
    totals: Object.freeze({
      total: Object.freeze({ ...nextAggregate, coverage: deriveAggregateCoverage(nextAggregate) }),
      input: categoryTotals.input!,
      output: categoryTotals.output!,
      cachedRead: categoryTotals.cachedRead!,
      cachedWrite: categoryTotals.cachedWrite!,
      thought: categoryTotals.thought!,
    }),
    ratedCosts,
    activeBaseline: accrual.baseline,
  });
}

function deriveAggregateCoverage(
  total: Omit<AggregateUsageTotal, "coverage">,
): AggregateUsageTotal["coverage"] {
  if (total.attributedOperationCount === 0) return "none";
  return total.unavailableOperationCount === 0 ? "complete" : "partial";
}

/**
 * Add one amount into a per-currency accumulation.
 *
 * Amounts are already-rounded operation totals, so the sum is exact and never re-rounded.
 * Currencies are kept as separate facts rather than converted.
 */
export function accumulateByCurrency(
  totals: readonly Money[],
  addition: Money,
): { ok: true; value: readonly Money[] } | { ok: false; reason: string } {
  const next: Money[] = [];
  let merged = false;
  for (const existing of totals) {
    if (existing.currency !== addition.currency) {
      next.push(existing);
      continue;
    }
    const sum = addMoney(existing, addition);
    if (!sum.ok) return { ok: false, reason: sum.reason };
    next.push(sum.value);
    merged = true;
  }
  if (!merged) {
    const canonical = canonicalizeMoney(addition);
    if (!canonical.ok) return { ok: false, reason: canonical.reason };
    next.push(canonical.value);
  }
  return { ok: true, value: Object.freeze(next) };
}

export type StateRestoration =
  | { readonly status: "not_provided" }
  | { readonly status: "restored"; readonly version: 2; readonly state: AgentSessionMeteringState }
  | {
      readonly status: "ignored";
      readonly reason:
        | "initial_state_version_unsupported"
        | "initial_state_identity_mismatch"
        | "initial_state_malformed";
      readonly providedVersion?: number;
    };

/**
 * Validate restored state before any version-specific field is read.
 *
 * A foreign version is refused wholesale rather than partially read: fields that happen to
 * line up between versions are the most dangerous kind of near-match, because the result
 * looks like a successful restore.
 */
function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCategoryTotal(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const total = value as Record<string, unknown>;
  return (
    isCount(total.knownTokens) &&
    isCount(total.attributedOperationCount) &&
    isCount(total.unavailableOperationCount)
  );
}

/** Check the shape a restored state must have before any of it is trusted. */
function isStructurallyValid(state: AgentSessionMeteringState): boolean {
  if (
    !isCount(state.operationCount) ||
    !isCount(state.meteredOperationCount) ||
    !isCount(state.unmeteredOperationCount)
  ) {
    return false;
  }
  const totals = state.totals as unknown as Record<string, unknown> | undefined;
  if (!totals) return false;
  for (const key of ["total", "input", "output", "cachedRead", "cachedWrite", "thought"]) {
    if (!isCategoryTotal(totals[key])) return false;
  }
  if (!Array.isArray(state.ratedCosts) || !state.ratedCosts.every(isValidMoney)) return false;

  const baseline = state.activeBaseline;
  if (baseline !== null) {
    if (typeof baseline !== "object") return false;
    if (typeof baseline.adapterId !== "string" || typeof baseline.internalSessionId !== "string") {
      return false;
    }
    const usage = baseline.reportedUsage as unknown as Record<string, unknown> | undefined;
    if (!usage || !isCount(usage.totalTokens) || !isCount(usage.inputTokens) || !isCount(usage.outputTokens)) {
      return false;
    }
  }
  return true;
}

export function restoreMeteringState(
  provided: AgentSessionMeteringState | undefined,
  agentSessionId: string,
): StateRestoration {
  if (provided === undefined) return { status: "not_provided" };

  const version = (provided as { version?: unknown }).version;
  if (version !== METERING_STATE_VERSION) {
    return {
      status: "ignored",
      reason: "initial_state_version_unsupported",
      ...(typeof version === "number" ? { providedVersion: version } : {}),
    };
  }
  if (provided.agentSessionId !== agentSessionId) {
    return { status: "ignored", reason: "initial_state_identity_mismatch" };
  }
  // A matching version and id is not proof the rest is intact. This state comes back from
  // a consumer's database or a JSON file and feeds straight into totals a bill is drawn
  // from, so a truncated write or a hand-edit must be refused rather than absorbed.
  if (!isStructurallyValid(provided)) {
    return { status: "ignored", reason: "initial_state_malformed" };
  }
  return { status: "restored", version: METERING_STATE_VERSION, state: provided };
}
