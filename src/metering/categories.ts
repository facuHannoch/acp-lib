// The token category set, stated once.
//
// Every part of the metering pipeline has to agree on what the categories ARE: pricing
// enumerates them to build schedules, rating maps them onto reported counters, state maps
// them onto persisted totals, the engine merges them across models, and normalization
// decides which are required versus optional. Each of those used to carry its own copy of
// the list — seven copies in three different spellings, two of them untyped inline arrays.
//
// That is the same defect `unitPriceFor` was created to remove: a mapping duplicated
// between validation and rating drifted the moment `billed_as_output` arrived. The copies
// here would fail more quietly still. An untyped `["total", "input", ...]` used to
// validate restored state accepts a sixth category silently, so a counter the library
// knows how to normalize would restore unvalidated and never be rated.
//
// So the list lives here, typed against TokenCategory, and every consumer imports it.
// Adding a category becomes a compile error at each site that must handle it rather than
// a silent undercount.

import type { TokenUsage } from "../types.ts";

/** The billable token categories, in canonical (pricing-facing) spelling. */
export type TokenCategory = "input" | "output" | "cached_read" | "cached_write" | "thought";


/**
 * The same categories in the camelCase spelling used for aggregates.
 *
 * `AttributableUsage` and `UsageTotals` both key their per-category members this way, so
 * one list serves merging and validation alike.
 */
export type TokenCategoryKey = "input" | "output" | "cachedRead" | "cachedWrite" | "thought";


/** Category → the TokenUsage counter carrying it. */
export const CATEGORY_FIELD: Readonly<Record<TokenCategory, keyof TokenUsage>> = Object.freeze({
  input: "inputTokens",
  output: "outputTokens",
  cached_read: "cachedReadTokens",
  cached_write: "cachedWriteTokens",
  thought: "thoughtTokens",
});

/** Category → the camelCase aggregate key carrying it. */
export const CATEGORY_TOTAL: Readonly<Record<TokenCategory, TokenCategoryKey>> = Object.freeze({
  input: "input",
  output: "output",
  cached_read: "cachedRead",
  cached_write: "cachedWrite",
  thought: "thought",
});

// Derived from the maps, not written out again. Both maps are `Record<TokenCategory, …>`,
// so the compiler already refuses an incomplete one; taking the lists from their keys
// makes an incomplete LIST unrepresentable too, which a second array literal typed
// `readonly TokenCategory[]` would not have caught.
export const TOKEN_CATEGORIES: readonly TokenCategory[] = Object.freeze(
  Object.keys(CATEGORY_FIELD) as TokenCategory[],
);

export const TOKEN_CATEGORY_KEYS: readonly TokenCategoryKey[] = Object.freeze(
  Object.values(CATEGORY_TOTAL),
);

/**
 * Required counters. A malformed one makes the whole report unavailable, because the
 * remaining ones cannot be checked against a total that is itself untrustworthy.
 */
export const REQUIRED_USAGE_KEYS = ["totalTokens", "inputTokens", "outputTokens"] as const;

/**
 * Optional counters, which may legitimately be absent — and, between two cumulative
 * reports, may legitimately appear and disappear.
 */
export const OPTIONAL_USAGE_KEYS = [
  "cachedReadTokens",
  "cachedWriteTokens",
  "thoughtTokens",
] as const;

/** Every TokenUsage counter, required first. */
export const USAGE_KEYS = [...REQUIRED_USAGE_KEYS, ...OPTIONAL_USAGE_KEYS] as const;

// The required/optional split cannot be derived from the type, so it is asserted instead:
// adding a field to TokenUsage without classifying it here is a compile error rather than
// a counter that normalizes and is then silently dropped from every delta.
type Assert<T extends true> = T;
type UsageKeysAreComplete = Assert<
  Exclude<keyof TokenUsage, (typeof USAGE_KEYS)[number]> extends never ? true : false
>;
export type { UsageKeysAreComplete };

/** A counter must be a finite, non-negative safe integer. Nothing else is a token count. */
export function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Per-category counts with absence preserved, as `disjointTokenUsage` accepts them. */
export interface DisjointTokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cachedRead: number | null;
  readonly cachedWrite: number | null;
  readonly thought: number | null;
}

/**
 * Build a TokenUsage from disjoint per-category counts.
 *
 * The categories do not overlap — measured across five providers, `input + output +
 * thought + cachedRead + cachedWrite` equals the provider's reported total exactly — so
 * `totalTokens` is DERIVED here rather than trusted from a separate field. That identity
 * is what lets the certified path check a provider's arithmetic instead of restating it,
 * and it was previously written out at each site that needed it, under two different
 * absence conventions.
 *
 * A null category is omitted, never zero-filled: "the provider did not report cache
 * writes" and "the provider wrote no cache" are different facts.
 */
export function disjointTokenUsage(counts: DisjointTokenCounts): TokenUsage {
  const { input, output, cachedRead, cachedWrite, thought } = counts;
  return Object.freeze({
    totalTokens: input + output + (cachedRead ?? 0) + (cachedWrite ?? 0) + (thought ?? 0),
    inputTokens: input,
    outputTokens: output,
    ...(cachedRead !== null ? { cachedReadTokens: cachedRead } : {}),
    ...(cachedWrite !== null ? { cachedWriteTokens: cachedWrite } : {}),
    ...(thought !== null ? { thoughtTokens: thought } : {}),
  });
}
