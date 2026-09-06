// Attributable delta calculation. See 9-6-SPEC-metering.md §8.
//
// ACP reports cumulative internal-session counters, so "what did THIS operation use" is a
// subtraction — and a subtraction is only meaningful against a baseline we can justify.
// The three trusted baselines are: we created the thread (counters began at zero), the
// consumer restored matching state, or we observed a prior report in this same live
// session. Anything else is unattributable, and says so, rather than reporting the whole
// cumulative figure as if one operation had incurred it.

import type { TokenUsage } from "../types.ts";
import type { CounterInterpretation } from "./provider.ts";

/** Optional counters, which may legitimately appear and disappear between reports. */
const OPTIONAL_KEYS = ["cachedReadTokens", "cachedWriteTokens", "thoughtTokens"] as const;
const REQUIRED_KEYS = ["totalTokens", "inputTokens", "outputTokens"] as const;

export type DeltaResult =
  | { readonly kind: "attributable"; readonly delta: TokenUsage }
  /** A counter went backwards: the provider thread's counters restarted. */
  | { readonly kind: "counter_reset"; readonly reason: string }
  /** No trusted baseline, so no subtraction is defensible. */
  | { readonly kind: "baseline_required"; readonly reason: string };

/**
 * Subtract a baseline cumulative report from the latest one.
 *
 * `baseline` is null only for a thread the library created, whose counters are known to
 * have started at zero — the one case where absence genuinely means zero.
 */
export function calculateDelta(
  baseline: TokenUsage | null,
  current: TokenUsage,
  options: {
    readonly trustedZeroBaseline: boolean;
    /** Defaults to cumulative — see counterInterpretationForAdapter. */
    readonly interpretation?: CounterInterpretation;
  },
): DeltaResult {
  // A per-turn harness already reports exactly this operation's usage. There is nothing
  // to subtract, no baseline to trust, and no such thing as a counter reset: a counter
  // that "decreased" just means this turn was smaller than the last one.
  if (options.interpretation === "per_turn") {
    return { kind: "attributable", delta: Object.freeze({ ...current }) };
  }

  if (!baseline && !options.trustedZeroBaseline) {
    return {
      kind: "baseline_required",
      reason: "no trusted baseline for this provider thread; restore prior metering state",
    };
  }

  // A decreasing counter is a reset, never a negative operation. Reporting a negative
  // delta — or clamping it to zero — would both be inventions.
  for (const key of REQUIRED_KEYS) {
    const previous = baseline?.[key] ?? 0;
    if (current[key] < previous) {
      return {
        kind: "counter_reset",
        reason: `${key} decreased from ${previous} to ${current[key]}`,
      };
    }
  }
  for (const key of OPTIONAL_KEYS) {
    const previous = baseline?.[key];
    const now = current[key];
    if (previous !== undefined && now !== undefined && now < previous) {
      return { kind: "counter_reset", reason: `${key} decreased from ${previous} to ${now}` };
    }
  }

  const delta: TokenUsage = {
    totalTokens: current.totalTokens - (baseline?.totalTokens ?? 0),
    inputTokens: current.inputTokens - (baseline?.inputTokens ?? 0),
    outputTokens: current.outputTokens - (baseline?.outputTokens ?? 0),
  };

  for (const key of OPTIONAL_KEYS) {
    const now = current[key];
    if (now === undefined) continue; // not reported now → nothing attributable
    const previous = baseline?.[key];
    if (previous === undefined) {
      // The category appeared with no prior value. From a known-zero baseline the whole
      // amount is this operation's; otherwise the prior value is unknown and no exact
      // delta exists, so the category is omitted rather than guessed.
      if (baseline === null && options.trustedZeroBaseline) delta[key] = now;
      continue;
    }
    delta[key] = now - previous;
  }

  return { kind: "attributable", delta: Object.freeze(delta) };
}

/**
 * Whether a restored baseline may be used for the thread being opened.
 *
 * All three identifiers must match: a baseline from another logical session, another
 * adapter, or another provider thread describes counters that have nothing to do with
 * this one, and subtracting it would produce a confident wrong number.
 */
export function baselineMatches(
  baseline: { readonly adapterId: string; readonly internalSessionId: string },
  target: { readonly adapterId: string; readonly internalSessionId: string | null },
): boolean {
  return (
    target.internalSessionId !== null &&
    baseline.adapterId === target.adapterId &&
    baseline.internalSessionId === target.internalSessionId
  );
}
