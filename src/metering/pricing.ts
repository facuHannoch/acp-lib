// Pricing policy types and validation. See 9-6-SPEC-metering.md §7.
//
// A pricing POLICY is everything the library froze before dispatching a rating unit: the
// catalog identity it came from, which provider/model keys were actually matched, which
// categories that model even uses, and every schedule that could apply. Exactly one
// schedule is selected AFTER the operation, from recorded billing facts — never by
// fetching a new price, and never by picking arbitrarily when the choice is ambiguous.

import { isValidMoney, type TokenUnitPrice } from "./money.ts";

export type TokenCategory = "input" | "output" | "cached_read" | "cached_write" | "thought";

export const TOKEN_CATEGORIES: readonly TokenCategory[] = Object.freeze([
  "input",
  "output",
  "cached_read",
  "cached_write",
  "thought",
]);

/** Applicability is independent from whether a price happens to be present. */
export type CategoryApplicability = "applicable" | "not_applicable" | "unknown";

/**
 * Immutable identity of the price data. A record engraves this so its cost can be
 * recomputed without consulting the library's current catalog.
 */
export type PricingSource =
  | {
      readonly kind: "models.dev";
      /** Immutable upstream Git commit used to produce the artifact. */
      readonly commit: string;
      /** SHA-256 of the exact generated catalog artifact shipped by the library. */
      readonly artifactSha256: string;
      readonly generatedAt: number;
    }
  | {
      readonly kind: "consumer_override";
      /** Stable identifier meaningful to the consumer, not a mutable display label. */
      readonly version: string;
    };

export interface CacheInputConvention {
  readonly cachedRead: "included_in_input" | "excluded_from_input";
  readonly cachedWrite: "included_in_input" | "excluded_from_input";
}

/**
 * How a harness's separately-reported reasoning tokens are charged.
 *
 * The counterpart to `cacheInputConvention` for the output side, and the same trap: a
 * harness can report `thoughtTokens` as a disjoint counter while the provider bills them
 * at the ordinary output rate. Pricing them at a separate rate — or refusing to price
 * them — both get the total wrong.
 *
 * `billed_as_output` applies the schedule's OUTPUT unit price to thought tokens, and
 * engraves that price, so a record shows exactly what rate was applied.
 */
export type ThoughtConvention = "separate_price" | "billed_as_output";

export interface PricingSchedule {
  /** Stable identifier for this schedule within its policy. */
  readonly tier: string;
  /** Machine-evaluable catalog conditions selecting this schedule. */
  readonly conditions: readonly PricingCondition[];
  /** Provider/harness counter convention used to avoid pricing cached input twice. */
  readonly cacheInputConvention: CacheInputConvention;
  /**
   * How separately-reported reasoning tokens are charged. Defaults to `separate_price`,
   * which requires a `thought` unit price and otherwise makes rating unavailable.
   */
  readonly thoughtConvention?: ThoughtConvention;
  readonly input: TokenUnitPrice;
  readonly output: TokenUnitPrice;
  readonly cachedRead?: TokenUnitPrice;
  readonly cachedWrite?: TokenUnitPrice;
  readonly thought?: TokenUnitPrice;
}

export type PricingCondition =
  | { readonly kind: "default" }
  | { readonly kind: "context_tokens_at_least"; readonly tokens: number }
  | { readonly kind: "service_tier"; readonly value: string }
  | { readonly kind: "batch"; readonly value: boolean }
  | {
      /** Versioned consumer condition for a schedule core does not model natively. */
      readonly kind: "consumer";
      readonly name: string;
      readonly value: string;
    };

export interface PricingPolicy {
  readonly source: PricingSource;
  /** Provider and model keys actually selected from the source. */
  readonly providerId: string;
  readonly modelId: string;
  /** Applicability is independent from whether a price happens to be present. */
  readonly categoryApplicability: Readonly<Record<TokenCategory, CategoryApplicability>>;
  readonly schedules: readonly PricingSchedule[];
}

export interface PricingContext {
  readonly scope: "operation" | "inference";
  readonly agentSessionId: string;
  readonly internalSessionId: string | null;
  readonly operationId: string;
  readonly inferenceId?: string;
  readonly adapterId: string;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly operationKind: string;
  readonly at: number;
}

export type PricingResolver = (
  context: PricingContext,
) => PricingPolicy | null | Promise<PricingPolicy | null>;

/** `false` means the consumer intentionally wants no local rating (§7). */
export type PricingConfiguration = PricingResolver | false;

export type PolicyValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

function isUnitPrice(value: unknown): value is TokenUnitPrice {
  if (typeof value !== "object" || value === null) return false;
  const price = value as TokenUnitPrice;
  return (
    // isValidMoney also enforces the canonical decimal form, so a syntactically
    // string-shaped amount like "1e-6" is rejected at preflight rather than at rating.
    isValidMoney(price) &&
    Number.isSafeInteger(price.perTokens) &&
    price.perTokens > 0
  );
}

/**
 * The unit price a schedule applies to a category, or undefined when it has none.
 *
 * The single source of truth for that mapping. It used to be duplicated between
 * validation and rating, and the copies drifted the moment `billed_as_output` was added.
 */
export function unitPriceFor(
  schedule: PricingSchedule,
  category: TokenCategory,
): TokenUnitPrice | undefined {
  switch (category) {
    case "input":
      return schedule.input;
    case "output":
      return schedule.output;
    case "cached_read":
      return schedule.cachedRead;
    case "cached_write":
      return schedule.cachedWrite;
    case "thought":
      // Reasoning billed at the ordinary output rate is still priced — by the output
      // price, which is what reproduces the provider's own figure.
      if (schedule.thoughtConvention === "billed_as_output") return schedule.output;
      return schedule.thought;
  }
}

/** Categories a schedule carries a price for, in TokenCategory terms. */
export function pricedCategories(schedule: PricingSchedule): ReadonlySet<TokenCategory> {
  const priced = new Set<TokenCategory>();
  for (const category of TOKEN_CATEGORIES) {
    if (unitPriceFor(schedule, category)) priced.add(category);
  }
  return priced;
}

/**
 * Validate a resolved policy before it is frozen onto a rating unit.
 *
 * Enforces the invariants §7 states as hard errors rather than warnings: one currency per
 * schedule, and every category the policy declares applicable actually carries a price. A
 * schedule that silently omits an applicable category would drop real cost from the total.
 */
export function validatePricingPolicy(policy: PricingPolicy): PolicyValidation {
  if (typeof policy?.providerId !== "string" || policy.providerId.length === 0) {
    return { ok: false, reason: "policy has no providerId" };
  }
  if (typeof policy.modelId !== "string" || policy.modelId.length === 0) {
    return { ok: false, reason: "policy has no modelId" };
  }
  if (!Array.isArray(policy.schedules) || policy.schedules.length === 0) {
    return { ok: false, reason: `policy ${policy.providerId}/${policy.modelId} has no schedules` };
  }

  for (const category of TOKEN_CATEGORIES) {
    const applicability = policy.categoryApplicability?.[category];
    if (applicability !== "applicable" && applicability !== "not_applicable" && applicability !== "unknown") {
      return { ok: false, reason: `categoryApplicability.${category} is missing or invalid` };
    }
  }

  const seenTiers = new Set<string>();
  for (const schedule of policy.schedules) {
    if (typeof schedule?.tier !== "string" || schedule.tier.length === 0) {
      return { ok: false, reason: "schedule has no tier identifier" };
    }
    if (seenTiers.has(schedule.tier)) {
      return { ok: false, reason: `duplicate schedule tier ${schedule.tier}` };
    }
    seenTiers.add(schedule.tier);

    if (!Array.isArray(schedule.conditions) || schedule.conditions.length === 0) {
      return { ok: false, reason: `schedule ${schedule.tier} has no conditions` };
    }
    const convention = schedule.cacheInputConvention;
    for (const key of ["cachedRead", "cachedWrite"] as const) {
      const value = convention?.[key];
      if (value !== "included_in_input" && value !== "excluded_from_input") {
        return { ok: false, reason: `schedule ${schedule.tier} has no ${key} cache convention` };
      }
    }

    const priced = pricedCategories(schedule);
    for (const category of TOKEN_CATEGORIES) {
      const price = unitPriceFor(schedule, category);
      if (price !== undefined && !isUnitPrice(price)) {
        return { ok: false, reason: `schedule ${schedule.tier} has an invalid ${category} unit price` };
      }
      // Applicable but unpriced would silently exclude the category from cost (§7).
      if (policy.categoryApplicability[category] === "applicable" && !priced.has(category)) {
        return {
          ok: false,
          reason: `schedule ${schedule.tier} declares ${category} applicable but carries no price`,
        };
      }
    }

    // Mixed currency is invalid rather than partially summed (§7).
    const currencies = new Set<string>();
    for (const category of priced) {
      currencies.add(unitPriceFor(schedule, category)!.currency);
    }
    if (currencies.size > 1) {
      return {
        ok: false,
        reason: `schedule ${schedule.tier} mixes currencies: ${[...currencies].sort().join(", ")}`,
      };
    }
  }

  return { ok: true };
}
