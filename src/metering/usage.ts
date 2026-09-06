// ACP usage normalization. The ONLY place raw `PromptResponse.usage` is turned into the
// library's public TokenUsage shape. See 9-6-SPEC-metering.md §4.
//
// Two things this module deliberately does NOT do:
//   1. Coerce a missing or malformed counter to zero. Absence is not zero — a harness
//      that omits cachedWriteTokens has told us nothing, not that it wrote no cache.
//   2. Decide whether the harness emits cumulative or per-turn counters. The installed
//      ACP SDK contradicts itself (PromptResponse.usage says "for this turn", the Usage
//      fields say "across all turns"/"across session") and exposes no discriminator, so
//      the interpretation is adapter evidence recorded in provenance, never a heuristic
//      applied here.

import type { TokenUsage } from "../types.ts";

/** Optional counters, in the order they are validated. */
const OPTIONAL_KEYS = ["cachedReadTokens", "cachedWriteTokens", "thoughtTokens"] as const;

/** Required counters. A malformed one makes the whole report unavailable. */
const REQUIRED_KEYS = ["totalTokens", "inputTokens", "outputTokens"] as const;

export type UsageNormalization =
  | { readonly ok: true; readonly usage: TokenUsage }
  /** `reason` is a stable, safe-to-log string; it becomes MeteringUsageResult.reason. */
  | { readonly ok: false; readonly reason: string };

/** A counter must be a finite, non-negative safe integer. Nothing else is a token count. */
function isValidCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function describe(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : String(value);
  if (value === null) return "null";
  return typeof value;
}

/**
 * Normalize a raw ACP usage object.
 *
 * Absent/null report → unavailable (the harness reported nothing).
 * Malformed REQUIRED counter → unavailable, never zero-filled.
 * Malformed PRESENT optional counter → unavailable. A present-but-corrupt value is not
 *   the same as absence: silently dropping it would assert the harness never reported
 *   the category, which is exactly the fabrication §4 forbids.
 * Absent/null optional counter → omitted from the result, so absence stays absence.
 */
export function normalizeTokenUsage(raw: unknown): UsageNormalization {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "harness reported no usage" };
  }
  if (typeof raw !== "object") {
    return { ok: false, reason: `usage is ${typeof raw}, not an object` };
  }

  const source = raw as Record<string, unknown>;
  const required: Record<string, number> = {};
  for (const key of REQUIRED_KEYS) {
    const value = source[key];
    if (!isValidCounter(value)) {
      return { ok: false, reason: `usage.${key} is ${describe(value)}, not a token count` };
    }
    required[key] = value;
  }

  const usage: TokenUsage = {
    totalTokens: required.totalTokens!,
    inputTokens: required.inputTokens!,
    outputTokens: required.outputTokens!,
  };

  for (const key of OPTIONAL_KEYS) {
    const value = source[key];
    // ACP types these as `number | null | undefined`; both nullish forms mean "not reported".
    if (value === null || value === undefined) continue;
    if (!isValidCounter(value)) {
      return { ok: false, reason: `usage.${key} is ${describe(value)}, not a token count` };
    }
    usage[key] = value;
  }

  return { ok: true, usage: Object.freeze(usage) };
}
