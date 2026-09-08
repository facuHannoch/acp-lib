import { describe, expect, test } from "bun:test";
import { rateDelta, selectSchedule, unpricedUsage } from "../src/metering/rating.ts";
import { soleAmount } from "../src/metering/money.ts";
import type {
  CacheInputConvention,
  CategoryApplicability,
  PricingPolicy,
  PricingSchedule,
  TokenCategory,
} from "../src/metering/pricing.ts";
import type { TokenUsage } from "../src/types.ts";

const price = (amount: string) => ({ amount, currency: "USD", perTokens: 1_000_000 });

const EXCLUDED: CacheInputConvention = {
  cachedRead: "excluded_from_input",
  cachedWrite: "excluded_from_input",
};
const INCLUDED: CacheInputConvention = {
  cachedRead: "included_in_input",
  cachedWrite: "included_in_input",
};

function schedule(overrides: Partial<PricingSchedule> = {}): PricingSchedule {
  return {
    tier: "default",
    conditions: [{ kind: "default" }],
    cacheInputConvention: EXCLUDED,
    input: price("3"),
    output: price("15"),
    cachedRead: price("0.3"),
    cachedWrite: price("3.75"),
    ...overrides,
  };
}

function policy(overrides: Partial<PricingPolicy> = {}): PricingPolicy {
  const applicability: Record<TokenCategory, CategoryApplicability> = {
    input: "applicable",
    output: "applicable",
    cached_read: "applicable",
    cached_write: "applicable",
    thought: "not_applicable",
  };
  return {
    source: { kind: "consumer_override", version: "test-1" },
    providerId: "anthropic",
    modelId: "claude-test",
    categoryApplicability: applicability,
    schedules: [schedule()],
    ...overrides,
  };
}

const delta = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  totalTokens: 1_000_000,
  inputTokens: 1_000_000,
  outputTokens: 0,
  ...over,
});

describe("rating a delta", () => {
  test("prices each category at its own rate and engraves the unit price", () => {
    const result = rateDelta(
      delta({ totalTokens: 1_200_000, inputTokens: 1_000_000, outputTokens: 200_000 }),
      policy(),
      schedule(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.input.pricing?.ratedCost).toEqual({ amount: "3", currency: "USD" });
    expect(result.usage.output.pricing?.ratedCost).toEqual({ amount: "3", currency: "USD" });
    expect(result.usage.input.pricing?.unitPrice).toEqual(price("3"));
    expect(soleAmount(result.usage.ratedTotal)).toEqual({ amount: "6", currency: "USD" });
  });

  test("the total is exactly the sum of the engraved subtotals", () => {
    const result = rateDelta(
      delta({
        totalTokens: 36_200,
        inputTokens: 25_000,
        outputTokens: 1_200,
        cachedReadTokens: 10_000,
      }),
      policy(),
      schedule(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const subtotals = [
      result.usage.input.pricing!.ratedCost.amount,
      result.usage.output.pricing!.ratedCost.amount,
      result.usage.cachedRead!.pricing!.ratedCost.amount,
    ];
    expect(subtotals).toEqual(["0.075", "0.018", "0.003"]);
    expect(soleAmount(result.usage.ratedTotal)?.amount).toBe("0.096");
  });

  describe("cache-input convention", () => {
    test("excluded: ordinary input is priced unchanged", () => {
      const result = rateDelta(
        delta({ inputTokens: 30_000, cachedReadTokens: 5_000 }),
        policy(),
        schedule({ cacheInputConvention: EXCLUDED }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.usage.input.reportedTokens).toBe(30_000);
      expect(result.usage.input.pricedTokens).toBe(30_000);
    });

    test("included: cached tokens are subtracted before input is priced", () => {
      // Without this, the 5k cached tokens are charged twice — once at the input rate and
      // once at the cache rate.
      const result = rateDelta(
        delta({ inputTokens: 30_000, cachedReadTokens: 5_000 }),
        policy(),
        schedule({ cacheInputConvention: INCLUDED }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.usage.input.reportedTokens).toBe(30_000);
      expect(result.usage.input.pricedTokens).toBe(25_000);
      expect(result.usage.cachedRead?.reportedTokens).toBe(5_000);
      expect(result.usage.cachedRead?.pricedTokens).toBe(5_000);
    });

    test("the applied convention is engraved on the record", () => {
      const result = rateDelta(delta(), policy(), schedule({ cacheInputConvention: INCLUDED }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.usage.cacheInputConvention).toEqual(INCLUDED);
    });

    test("cached tokens exceeding the input they are declared inside is invalid, not clamped", () => {
      const result = rateDelta(
        delta({ inputTokens: 1_000, cachedReadTokens: 5_000 }),
        policy(),
        schedule({ cacheInputConvention: INCLUDED }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("exceed");
    });
  });

  test("a reported category the policy calls not_applicable invalidates the record", () => {
    // Anthropic bills thinking as output; a separate thought counter would double-count,
    // so contradictory evidence fails loudly rather than inflating the total.
    const result = rateDelta(delta({ thoughtTokens: 500 }), policy(), schedule());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not applicable");
  });

  test("a reported category with no unit price makes rating unavailable", () => {
    const result = rateDelta(
      delta({ cachedWriteTokens: 100 }),
      policy(),
      schedule({ cachedWrite: undefined }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("cached_write");
  });

  test("an unreported category is neither priced nor zero-filled", () => {
    const result = rateDelta(delta(), policy(), schedule());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.cachedRead).toBeUndefined();
    expect(result.usage.thought).toBeUndefined();
  });

  test("records the pricing source and lookup key for reproducibility", () => {
    const result = rateDelta(delta(), policy(), schedule({ tier: "context_over_200000" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.pricingSource).toEqual({ kind: "consumer_override", version: "test-1" });
    expect(result.usage.pricingKey).toEqual({
      providerId: "anthropic",
      modelId: "claude-test",
      tier: "context_over_200000",
    });
  });

  test("preserves the raw delta beside the priced view", () => {
    const raw = delta({ inputTokens: 30_000, cachedReadTokens: 5_000 });
    const result = rateDelta(raw, policy(), schedule({ cacheInputConvention: INCLUDED }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.reportedDelta).toEqual(raw);
  });
});

describe("unpriced usage", () => {
  test("reports real token counts with explicitly null pricing", () => {
    // Best effort must not imply the operation was free.
    const usage = unpricedUsage(delta({ inputTokens: 100, outputTokens: 20, cachedReadTokens: 5 }));
    expect(usage.input.reportedTokens).toBe(100);
    expect(usage.input.pricedTokens).toBeNull();
    expect(usage.input.pricing).toBeNull();
    // Nothing rated: an unaccounted contribution, not a zero total.
    expect(soleAmount(usage.ratedTotal)).toBeNull();
    expect(usage.ratedTotal.unaccounted).toBe(1);
    expect(usage.pricingSource).toBeNull();
    expect(usage.pricingKey).toBeNull();
    expect(usage.cachedRead?.reportedTokens).toBe(5);
    expect(usage.thought).toBeUndefined();
  });
});

describe("schedule selection", () => {
  const tiered = (): PricingPolicy =>
    policy({
      schedules: [
        schedule(),
        schedule({
          tier: "context_over_200000",
          conditions: [{ kind: "context_tokens_at_least", tokens: 200_000 }],
          input: price("6"),
        }),
      ],
    });

  test("falls back to the default schedule when no condition matches", () => {
    const result = selectSchedule(tiered(), { contextTokens: 1_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule.tier).toBe("default");
  });

  test("selects the tier when its condition is met", () => {
    const result = selectSchedule(tiered(), { contextTokens: 250_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule.tier).toBe("context_over_200000");
  });

  test("refuses when the backend cannot supply the fact a condition needs", () => {
    // §7: the ACP-derived backend must not substitute a cumulative delta or contextAfter
    // for real context size.
    const result = selectSchedule(tiered(), {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("proxy measurement");
  });

  test("a policy with only a default schedule needs no facts", () => {
    const result = selectSchedule(policy(), {});
    expect(result.ok).toBe(true);
  });

  test("two equally applicable schedules is ambiguous, not an arbitrary pick", () => {
    const ambiguous = policy({
      schedules: [
        schedule({ tier: "a", conditions: [{ kind: "batch", value: true }] }),
        schedule({ tier: "b", conditions: [{ kind: "batch", value: true }] }),
      ],
    });
    const result = selectSchedule(ambiguous, { batch: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("equally applicable");
  });

  test("no applicable schedule at all is unavailable", () => {
    const noDefault = policy({
      schedules: [schedule({ tier: "batch-only", conditions: [{ kind: "batch", value: true }] })],
    });
    const result = selectSchedule(noDefault, { batch: false });
    expect(result.ok).toBe(false);
  });
});

describe("thought convention", () => {
  const kimi = (): PricingSchedule =>
    schedule({
      // opencode-go/kimi-k2.6 as models.dev prices it: no `reasoning` entry at all.
      input: price("0.95"),
      output: price("4"),
      cachedRead: price("0.16"),
      cachedWrite: undefined,
      thought: undefined,
      thoughtConvention: "billed_as_output",
    });

  const applicable = (): PricingPolicy =>
    policy({
      categoryApplicability: {
        input: "applicable",
        output: "applicable",
        cached_read: "applicable",
        cached_write: "unknown",
        thought: "applicable",
      },
      schedules: [kimi()],
    });

  test("reproduces the provider's own cost exactly on a live billed turn", () => {
    // Measured on opencode-go/kimi-k2.6. OpenCode reported cumulative cost 0.00348629
    // after this turn, from zero. Reasoning is reported as a disjoint counter but billed
    // at the output rate; pricing it any other way misses by exactly 35 * 4/1M.
    const result = rateDelta(
      delta({ totalTokens: 8657, inputTokens: 2475, outputTokens: 3, cachedReadTokens: 6144, thoughtTokens: 35 }),
      applicable(),
      kimi(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(soleAmount(result.usage.ratedTotal)?.amount).toBe("0.00348629");
  });

  test("and on the following turn", () => {
    const result = rateDelta(
      delta({ totalTokens: 8664, inputTokens: 443, outputTokens: 3, cachedReadTokens: 8192, thoughtTokens: 26 }),
      applicable(),
      kimi(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(soleAmount(result.usage.ratedTotal)?.amount).toBe("0.00184757");
  });

  test("engraves the output price as the rate actually applied to thought", () => {
    // The record must show WHICH rate was used, not merely that a rate was used.
    const result = rateDelta(delta({ thoughtTokens: 40 }), applicable(), kimi());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.thought?.pricing?.unitPrice).toEqual(price("4"));
  });

  test("without the convention, an unpriced reported thought category refuses to rate", () => {
    // The honest default: we do not know what reasoning costs, so we do not guess.
    const noConvention = kimi();
    const result = rateDelta(
      delta({ thoughtTokens: 40 }),
      applicable(),
      { ...noConvention, thoughtConvention: undefined },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("thought");
  });

  test("a model with its own reasoning price uses that, not the output rate", () => {
    const withOwnPrice = { ...kimi(), thought: price("0.5"), thoughtConvention: "separate_price" as const };
    const result = rateDelta(delta({ thoughtTokens: 1_000_000 }), applicable(), withOwnPrice);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.thought?.pricing?.ratedCost.amount).toBe("0.5");
  });
});

describe("unpriced zero categories", () => {
  test("an explicit zero needs no price and does not block the operation", () => {
    // OpenCode reports cache.write on every inference, usually 0, and most catalog entries
    // carry no cache-write price. Zero tokens cost zero at any rate.
    const result = rateDelta(
      delta({ inputTokens: 100, cachedWriteTokens: 0 }),
      policy(),
      schedule({ cachedWrite: undefined }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.cachedWrite?.reportedTokens).toBe(0);
    // Reported, but explicitly not priced — no rate was invented for it.
    expect(result.usage.cachedWrite?.pricing).toBeNull();
    expect(result.usage.cachedWrite?.pricedTokens).toBeNull();
  });

  test("a non-zero unpriced category still refuses to rate", () => {
    const result = rateDelta(
      delta({ cachedWriteTokens: 1 }),
      policy(),
      schedule({ cachedWrite: undefined }),
    );
    expect(result.ok).toBe(false);
  });
});
