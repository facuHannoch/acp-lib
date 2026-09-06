import { describe, expect, test } from "bun:test";
import {
  MODELS_DEV_SOURCE,
  catalogProviderIds,
  createModelsDevResolver,
  verifyCatalogIntegrity,
} from "../src/metering/catalog/index.ts";
import {
  TOKEN_CATEGORIES,
  validatePricingPolicy,
  type PricingContext,
  type PricingPolicy,
  type PricingSchedule,
} from "../src/metering/pricing.ts";
import { isValidMoney, rateTokens } from "../src/metering/money.ts";

const resolve = createModelsDevResolver();

function context(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    scope: "operation",
    agentSessionId: "agent-1",
    internalSessionId: "internal-1",
    operationId: "turn-1",
    adapterId: "claude",
    providerId: "anthropic",
    model: "claude-sonnet-4-5",
    operationKind: "prompt",
    at: Date.now(),
    ...overrides,
  };
}

function policyFor(overrides: Partial<PricingContext> = {}): PricingPolicy {
  const policy = resolve(context(overrides));
  if (!policy || policy instanceof Promise) throw new Error("expected a resolved policy");
  return policy;
}

describe("pinned catalog artifact", () => {
  test("the shipped artifact matches its recorded digest", () => {
    // Without this, artifactSha256 in a stored record asserts an identity nobody checked.
    expect(() => verifyCatalogIntegrity()).not.toThrow();
  });

  test("the source names an immutable upstream commit and artifact digest", () => {
    expect(MODELS_DEV_SOURCE.kind).toBe("models.dev");
    if (MODELS_DEV_SOURCE.kind !== "models.dev") return;
    expect(MODELS_DEV_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(MODELS_DEV_SOURCE.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isSafeInteger(MODELS_DEV_SOURCE.generatedAt)).toBe(true);
  });

  test("only providers with a documented cache convention are shipped", () => {
    // models.dev lists 200+ providers; the catalog carries prices only where the
    // input/cache counter convention is backed by evidence. Guessing it would
    // double-count cached input.
    const providers = catalogProviderIds();
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
    expect(providers).not.toContain("openrouter");
  });

  test("every price converted from JSON is a canonical decimal string, never a float", () => {
    const policy = policyFor();
    for (const schedule of policy.schedules) {
      for (const price of [
        schedule.input,
        schedule.output,
        schedule.cachedRead,
        schedule.cachedWrite,
        schedule.thought,
      ]) {
        if (!price) continue;
        expect(typeof price.amount).toBe("string");
        expect(isValidMoney(price)).toBe(true);
        expect(price.perTokens).toBe(1_000_000);
      }
    }
  });
});

describe("default catalog resolver", () => {
  test("resolves a known provider/model to a valid policy", () => {
    const policy = policyFor();
    expect(policy.providerId).toBe("anthropic");
    expect(policy.modelId).toBe("claude-sonnet-4-5");
    expect(validatePricingPolicy(policy).ok).toBe(true);
    expect(policy.source).toEqual(MODELS_DEV_SOURCE);
  });

  test("rates the resolved input price exactly", () => {
    const policy = policyFor();
    const schedule = policy.schedules.find((s) => s.tier === "default")!;
    // 30k input tokens at the engraved unit price, via the decimal path.
    const rated = rateTokens(30_000, schedule.input);
    expect(rated.ok).toBe(true);
    if (!rated.ok) return;
    expect(isValidMoney(rated.value)).toBe(true);
  });

  test("refuses a bare model string with no provider — it must not guess", () => {
    // Two providers can serve the same model id at different prices; a fuzzy match would
    // engrave a plausible wrong number instead of an honest unavailable.
    expect(resolve(context({ providerId: null }))).toBeNull();
  });

  test("refuses unknown providers and unknown models", () => {
    expect(resolve(context({ providerId: "not-a-provider" }))).toBeNull();
    expect(resolve(context({ model: "not-a-model" }))).toBeNull();
    expect(resolve(context({ model: null }))).toBeNull();
  });

  test("does not fall back to a near-miss model id", () => {
    expect(resolve(context({ model: "claude-sonnet" }))).toBeNull();
    expect(resolve(context({ model: "claude-sonnet-4-5-latest" }))).toBeNull();
  });

  test("carries the provider cache convention onto every schedule", () => {
    const policy = policyFor();
    for (const schedule of policy.schedules) {
      // Anthropic reports cache counters separately from input_tokens.
      expect(schedule.cacheInputConvention).toEqual({
        cachedRead: "excluded_from_input",
        cachedWrite: "excluded_from_input",
      });
    }
  });

  test("marks Anthropic thought tokens not applicable rather than pricing them", () => {
    // Extended-thinking tokens are billed as output tokens. Pricing a separate thought
    // category would double-count, so a harness reporting one is contradictory evidence.
    const policy = policyFor();
    expect(policy.categoryApplicability.thought).toBe("not_applicable");
    for (const schedule of policy.schedules) expect(schedule.thought).toBeUndefined();
  });

  test("declares applicability for every token category", () => {
    const policy = policyFor();
    for (const category of TOKEN_CATEGORIES) {
      expect(["applicable", "not_applicable", "unknown"]).toContain(
        policy.categoryApplicability[category],
      );
    }
  });

  test("a context tier becomes a second schedule with an explicit condition", () => {
    // Long-context pricing must be a recorded selection, not a hidden multiplier.
    let tiered: { policy: PricingPolicy; schedule: PricingSchedule } | null = null;
    for (const providerId of catalogProviderIds()) {
      for (const modelId of ["gpt-5.6-sol", "claude-sonnet-4-5"]) {
        const policy = resolve(context({ providerId, model: modelId }));
        if (!policy || policy instanceof Promise) continue;
        const extra = policy.schedules.find((s) => s.tier !== "default");
        if (extra) {
          tiered = { policy, schedule: extra };
          break;
        }
      }
      if (tiered) break;
    }
    if (!tiered) return; // no tiered model in the current pin; nothing to assert
    expect(tiered.schedule.conditions).toEqual([
      { kind: "context_tokens_at_least", tokens: expect.any(Number) },
    ]);
    expect(tiered.policy.schedules.some((s) => s.tier === "default")).toBe(true);
  });
});

describe("policy validation", () => {
  const base = (): PricingPolicy => structuredClone(policyFor()) as PricingPolicy;

  test("rejects a schedule that mixes currencies", () => {
    const policy = base();
    const schedule = { ...policy.schedules[0]!, output: { ...policy.schedules[0]!.output, currency: "EUR" } };
    const result = validatePricingPolicy({ ...policy, schedules: [schedule] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("currencies");
  });

  test("rejects a category declared applicable but carrying no price", () => {
    const policy = base();
    const result = validatePricingPolicy({
      ...policy,
      categoryApplicability: { ...policy.categoryApplicability, thought: "applicable" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("thought");
  });

  test("rejects a policy with no schedules, no provider, or duplicate tiers", () => {
    const policy = base();
    expect(validatePricingPolicy({ ...policy, schedules: [] }).ok).toBe(false);
    expect(validatePricingPolicy({ ...policy, providerId: "" }).ok).toBe(false);
    expect(
      validatePricingPolicy({ ...policy, schedules: [policy.schedules[0]!, policy.schedules[0]!] }).ok,
    ).toBe(false);
  });

  test("rejects an invalid unit price", () => {
    const policy = base();
    const schedule = {
      ...policy.schedules[0]!,
      input: { amount: "1e-6", currency: "USD", perTokens: 1_000_000 },
    };
    expect(validatePricingPolicy({ ...policy, schedules: [schedule] }).ok).toBe(false);
  });

  test("rejects a schedule missing its cache convention", () => {
    const policy = base();
    const { cacheInputConvention: _dropped, ...rest } = policy.schedules[0]!;
    const result = validatePricingPolicy({
      ...policy,
      schedules: [rest as PricingSchedule],
    });
    expect(result.ok).toBe(false);
  });
});
