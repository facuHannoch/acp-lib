// Turning an attributable delta into a priced, engraved record. See §6, §7, §8.
//
// The subtle part is the cache-input convention. Providers disagree about whether
// `inputTokens` already contains cached reads/writes. Pricing ordinary input at the full
// reported figure when the provider folds cache into it charges the cached tokens twice —
// once at the input rate, once at the cache rate. So the schedule declares the convention,
// the adjustment is applied before rating, and BOTH the raw delta and the adjusted
// quantity are engraved, so a later reader can see which interpretation produced the
// number.

import type { TokenUsage } from "../types.ts";
import { addMoney, rateTokens, type Money, type TokenUnitPrice } from "./money.ts";
import {
  TOKEN_CATEGORIES,
  unitPriceFor,
  type PricingPolicy,
  type PricingSchedule,
  type PricingSource,
  type TokenCategory,
} from "./pricing.ts";

export interface PricedTokenAmount {
  /** Attributable counter delta reported for this category. */
  readonly reportedTokens: number;
  /** Tokens to which this category's unit price was applied. */
  readonly pricedTokens: number | null;
  readonly pricing:
    | {
        readonly unitPrice: TokenUnitPrice;
        readonly ratedCost: Money;
      }
    | null;
}

export interface AttributableUsage {
  /** Unpriced attributable usage before cache-convention adjustment. */
  readonly reportedDelta: TokenUsage;
  readonly pricingSource: PricingSource | null;
  readonly pricingKey:
    | { readonly providerId: string; readonly modelId: string; readonly tier: string }
    | null;
  readonly cacheInputConvention: PricingSchedule["cacheInputConvention"] | null;
  readonly totalTokens: number;
  readonly input: PricedTokenAmount;
  readonly output: PricedTokenAmount;
  readonly cachedRead?: PricedTokenAmount;
  readonly cachedWrite?: PricedTokenAmount;
  readonly thought?: PricedTokenAmount;
  readonly ratedTotal: Money | null;
}

export type RatingResult =
  | { readonly ok: true; readonly usage: AttributableUsage }
  | { readonly ok: false; readonly reason: string };

/** Facts observed about an operation, used to select one schedule from the frozen policy. */
export interface BillingFacts {
  /** Context size in tokens, when the backend can supply it as a trusted fact. */
  readonly contextTokens?: number;
  readonly serviceTier?: string;
  readonly batch?: boolean;
  readonly consumer?: Readonly<Record<string, string>>;
}

const DELTA_KEY: Readonly<Record<TokenCategory, keyof TokenUsage>> = Object.freeze({
  input: "inputTokens",
  output: "outputTokens",
  cached_read: "cachedReadTokens",
  cached_write: "cachedWriteTokens",
  thought: "thoughtTokens",
});

export type ScheduleSelection =
  | { readonly ok: true; readonly schedule: PricingSchedule }
  | { readonly ok: false; readonly reason: string };

/**
 * Select exactly one schedule from the frozen policy.
 *
 * A condition may only be evaluated from a fact the backend actually supplies. When a
 * schedule needs a fact we do not have, the whole selection is unavailable rather than
 * being resolved against a proxy measurement — §7 is explicit that the ACP-derived
 * backend cannot substitute a cumulative delta or `contextAfter` for real context size.
 *
 * Ambiguity is also unavailable: two equally applicable non-default schedules is a
 * catalog problem, and picking one arbitrarily would engrave an arbitrary price.
 */
export function selectSchedule(policy: PricingPolicy, facts: BillingFacts): ScheduleSelection {
  const matched: PricingSchedule[] = [];
  let fallback: PricingSchedule | null = null;

  for (const schedule of policy.schedules) {
    let applies = true;
    let isDefault = false;
    for (const condition of schedule.conditions) {
      switch (condition.kind) {
        case "default":
          isDefault = true;
          break;
        case "context_tokens_at_least":
          if (facts.contextTokens === undefined) {
            return {
              ok: false,
              reason:
                `schedule ${schedule.tier} needs a context size this metering backend ` +
                `cannot supply; core will not substitute a proxy measurement`,
            };
          }
          if (facts.contextTokens < condition.tokens) applies = false;
          break;
        case "service_tier":
          if (facts.serviceTier === undefined) {
            return { ok: false, reason: `schedule ${schedule.tier} needs a service tier fact` };
          }
          if (facts.serviceTier !== condition.value) applies = false;
          break;
        case "batch":
          if (facts.batch === undefined) {
            return { ok: false, reason: `schedule ${schedule.tier} needs a batch fact` };
          }
          if (facts.batch !== condition.value) applies = false;
          break;
        case "consumer": {
          const value = facts.consumer?.[condition.name];
          if (value === undefined) {
            return {
              ok: false,
              reason: `schedule ${schedule.tier} needs consumer fact ${condition.name}`,
            };
          }
          if (value !== condition.value) applies = false;
          break;
        }
      }
      if (!applies) break;
    }
    if (!applies) continue;
    if (isDefault) fallback = schedule;
    else matched.push(schedule);
  }

  if (matched.length > 1) {
    return {
      ok: false,
      reason: `schedules ${matched.map((s) => s.tier).sort().join(", ")} are equally applicable`,
    };
  }
  const selected = matched[0] ?? fallback;
  if (!selected) return { ok: false, reason: "no applicable schedule" };
  return { ok: true, schedule: selected };
}

/**
 * Rate an attributable delta under one schedule.
 *
 * Every category the delta reports is either priced or makes the whole rating
 * unavailable: silently omitting a reported category would understate cost while looking
 * complete. A category the policy declares `not_applicable` but the harness reported is
 * contradictory evidence and invalidates the record (§7) rather than being ignored.
 */
export function rateDelta(
  delta: TokenUsage,
  policy: PricingPolicy,
  schedule: PricingSchedule,
): RatingResult {
  const convention = schedule.cacheInputConvention;
  const amounts: Partial<Record<TokenCategory, PricedTokenAmount>> = {};
  const subtotals: Money[] = [];

  // Cached tokens folded into the input counter must come out before input is rated.
  let adjustedInput = delta.inputTokens;
  if (convention.cachedRead === "included_in_input") adjustedInput -= delta.cachedReadTokens ?? 0;
  if (convention.cachedWrite === "included_in_input") adjustedInput -= delta.cachedWriteTokens ?? 0;
  if (adjustedInput < 0) {
    return {
      ok: false,
      reason:
        `cached tokens (${delta.cachedReadTokens ?? 0} read, ${delta.cachedWriteTokens ?? 0} write) ` +
        `exceed the ${delta.inputTokens} input tokens they are declared to be included in`,
    };
  }

  for (const category of TOKEN_CATEGORIES) {
    const reportedTokens = delta[DELTA_KEY[category]];
    if (reportedTokens === undefined) continue; // not reported → not rated, not zeroed

    if (policy.categoryApplicability[category] === "not_applicable") {
      return {
        ok: false,
        reason: `harness reported ${category} tokens for a model where it is not applicable`,
      };
    }
    const unitPrice = unitPriceFor(schedule, category);
    if (!unitPrice) {
      return { ok: false, reason: `schedule ${schedule.tier} has no ${category} unit price` };
    }
    const pricedTokens = category === "input" ? adjustedInput : reportedTokens;
    const rated = rateTokens(pricedTokens, unitPrice);
    if (!rated.ok) return { ok: false, reason: `rating ${category}: ${rated.reason}` };

    amounts[category] = Object.freeze({
      reportedTokens,
      pricedTokens,
      pricing: Object.freeze({ unitPrice, ratedCost: rated.value }),
    });
    subtotals.push(rated.value);
  }

  // The total is the exact sum of the already-rounded engraved subtotals, so a reader can
  // add up what the record shows and land on what the record says.
  let ratedTotal: Money | null = null;
  for (const subtotal of subtotals) {
    if (!ratedTotal) {
      ratedTotal = subtotal;
      continue;
    }
    const sum = addMoney(ratedTotal, subtotal);
    if (!sum.ok) return { ok: false, reason: sum.reason };
    ratedTotal = sum.value;
  }

  return {
    ok: true,
    usage: Object.freeze({
      reportedDelta: delta,
      pricingSource: policy.source,
      pricingKey: Object.freeze({
        providerId: policy.providerId,
        modelId: policy.modelId,
        tier: schedule.tier,
      }),
      cacheInputConvention: convention,
      totalTokens: delta.totalTokens,
      input: amounts.input!,
      output: amounts.output!,
      ...(amounts.cached_read ? { cachedRead: amounts.cached_read } : {}),
      ...(amounts.cached_write ? { cachedWrite: amounts.cached_write } : {}),
      ...(amounts.thought ? { thought: amounts.thought } : {}),
      ratedTotal,
    }),
  };
}

/**
 * Represent an attributable delta with no pricing applied.
 *
 * Best-effort metering reports real token counts even when no price is available; the
 * null pricing says so explicitly rather than implying the operation was free.
 */
export function unpricedUsage(delta: TokenUsage): AttributableUsage {
  const amount = (reportedTokens: number): PricedTokenAmount =>
    Object.freeze({ reportedTokens, pricedTokens: null, pricing: null });
  return Object.freeze({
    reportedDelta: delta,
    pricingSource: null,
    pricingKey: null,
    cacheInputConvention: null,
    totalTokens: delta.totalTokens,
    input: amount(delta.inputTokens),
    output: amount(delta.outputTokens),
    ...(delta.cachedReadTokens !== undefined ? { cachedRead: amount(delta.cachedReadTokens) } : {}),
    ...(delta.cachedWriteTokens !== undefined
      ? { cachedWrite: amount(delta.cachedWriteTokens) }
      : {}),
    ...(delta.thoughtTokens !== undefined ? { thought: amount(delta.thoughtTokens) } : {}),
    ratedTotal: null,
  });
}
