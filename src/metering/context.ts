// Context-window and provider-cost observations from ACP `usage_update`.
// See 9-6-SPEC-metering.md §5 and §13.
//
// These are the two quantities most easily confused with token usage, and with each
// other:
//
//   - Context window is what currently OCCUPIES the model's context. It does not
//     aggregate across provider threads and is not a prediction of the next request's
//     input. A handoff resets it to null.
//   - Provider cost is the harness's own cumulative figure for the provider session. It
//     is not an invoice — a subscription harness may report an API-equivalent number —
//     and it is never merged with locally rated cost.
//
// ACP delivers both in one `usage_update`, but they have different lifecycles, so they
// are parsed and stored separately: a cost-only change must not make a context value look
// newly observed.

import { isTokenCount } from "./categories.ts";
import { decimalFromNumber, type Money } from "./money.ts";

export interface ContextWindowStatus {
  readonly internalSessionId: string;
  /** Tokens currently in context per the harness — not billed usage, not the last message. */
  readonly usedTokens: number;
  readonly sizeTokens: number;
  readonly remainingTokens: number;
  /** A ratio in [0, 1], not a percentage in [0, 100]. */
  readonly utilization: number;
  readonly observedAt: number;
}

export interface ProviderCostSnapshot {
  readonly internalSessionId: string;
  readonly cumulative: Money;
  readonly observedAt: number;
}

/**
 * How a `usage_update` changes provider cost.
 *
 * ACP's absent-versus-null distinction is meaningful and must survive parsing: an update
 * that simply does not mention cost says nothing about it, while an explicit null clears
 * it. Collapsing the two — as a `!= null` check does — would silently drop a value on
 * every context-only update.
 */
export type ProviderCostUpdate =
  | { readonly kind: "unchanged" }
  | { readonly kind: "cleared" }
  | { readonly kind: "observed"; readonly cumulative: Money }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Parse the context-window half of a `usage_update`.
 *
 * Returns null when the update cannot describe a context window. A zero `size` produces
 * no snapshot rather than an `Infinity` utilization, and malformed counters are never
 * coerced to zero.
 */
export function parseContextWindow(
  update: unknown,
  internalSessionId: string,
  observedAt: number,
): ContextWindowStatus | null {
  if (typeof update !== "object" || update === null) return null;
  const raw = update as Record<string, unknown>;
  const usedTokens = raw.used;
  const sizeTokens = raw.size;
  if (!isTokenCount(usedTokens) || !isTokenCount(sizeTokens)) return null;
  if (sizeTokens === 0) return null;

  return Object.freeze({
    internalSessionId,
    usedTokens,
    sizeTokens,
    // A harness may report more used than the window holds; remaining is clamped, but the
    // reported `used` is preserved verbatim rather than being clamped to match.
    remainingTokens: Math.max(0, sizeTokens - usedTokens),
    utilization: usedTokens / sizeTokens,
    observedAt,
  });
}

/** Parse the cost half of a `usage_update`, preserving absent-versus-null. */
export function parseProviderCost(update: unknown): ProviderCostUpdate {
  if (typeof update !== "object" || update === null) return { kind: "unchanged" };
  const raw = update as Record<string, unknown>;
  if (!("cost" in raw) || raw.cost === undefined) return { kind: "unchanged" };
  if (raw.cost === null) return { kind: "cleared" };

  const cost = raw.cost;
  if (typeof cost !== "object") return { kind: "invalid", reason: `cost is ${typeof cost}` };
  const { amount, currency } = cost as Record<string, unknown>;
  if (typeof currency !== "string" || currency.length === 0) {
    return { kind: "invalid", reason: "cost.currency is missing or empty" };
  }
  if (typeof amount !== "number") {
    return { kind: "invalid", reason: `cost.amount is ${typeof amount}, not a number` };
  }
  const decimal = decimalFromNumber(amount);
  if (!decimal.ok) return { kind: "invalid", reason: `cost.amount ${decimal.reason}` };

  return {
    kind: "observed",
    cumulative: Object.freeze({ amount: decimal.value, currency }),
  };
}

/** True when two context snapshots differ in anything a consumer would render. */
export function contextWindowChanged(
  previous: ContextWindowStatus | null,
  next: ContextWindowStatus | null,
): boolean {
  if (previous === next) return false;
  if (!previous || !next) return true;
  return (
    previous.internalSessionId !== next.internalSessionId ||
    previous.usedTokens !== next.usedTokens ||
    previous.sizeTokens !== next.sizeTokens
  );
}

/** True when two cost snapshots differ in anything a consumer would render. */
export function providerCostChanged(
  previous: ProviderCostSnapshot | null,
  next: ProviderCostSnapshot | null,
): boolean {
  if (previous === next) return false;
  if (!previous || !next) return true;
  return (
    previous.internalSessionId !== next.internalSessionId ||
    previous.cumulative.amount !== next.cumulative.amount ||
    previous.cumulative.currency !== next.cumulative.currency
  );
}
