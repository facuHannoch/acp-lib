import { describe, expect, test } from "bun:test";
import {
  contextWindowChanged,
  parseContextWindow,
  parseProviderCost,
  providerCostChanged,
} from "../src/metering/context.ts";

const AT = 1_700_000_000_000;
const SESSION = "internal-1";

describe("context-window parsing", () => {
  test("derives remaining and utilization from used/size", () => {
    const status = parseContextWindow({ used: 50_000, size: 200_000 }, SESSION, AT);
    expect(status).toEqual({
      internalSessionId: SESSION,
      usedTokens: 50_000,
      sizeTokens: 200_000,
      remainingTokens: 150_000,
      utilization: 0.25,
      observedAt: AT,
    });
  });

  test("utilization is a ratio in [0,1], not a percentage", () => {
    const status = parseContextWindow({ used: 1, size: 4 }, SESSION, AT);
    expect(status?.utilization).toBe(0.25);
  });

  test("a zero size produces no snapshot rather than Infinity utilization", () => {
    expect(parseContextWindow({ used: 10, size: 0 }, SESSION, AT)).toBeNull();
  });

  test("clamps remaining at zero but preserves the reported used verbatim", () => {
    const status = parseContextWindow({ used: 250_000, size: 200_000 }, SESSION, AT);
    expect(status?.remainingTokens).toBe(0);
    expect(status?.usedTokens).toBe(250_000);
  });

  test("rejects malformed counters instead of coercing them to zero", () => {
    for (const raw of [
      { used: -1, size: 100 },
      { used: 10.5, size: 100 },
      { used: "10", size: 100 },
      { used: 10, size: null },
      { size: 100 },
      { used: 10 },
      {},
      null,
      "usage",
    ]) {
      expect(parseContextWindow(raw, SESSION, AT)).toBeNull();
    }
  });

  test("the snapshot is frozen", () => {
    const status = parseContextWindow({ used: 1, size: 2 }, SESSION, AT);
    expect(Object.isFrozen(status)).toBe(true);
  });

  test("change detection ignores observedAt but catches thread and counter changes", () => {
    const a = parseContextWindow({ used: 10, size: 100 }, SESSION, AT)!;
    const sameLater = parseContextWindow({ used: 10, size: 100 }, SESSION, AT + 5_000)!;
    expect(contextWindowChanged(a, sameLater)).toBe(false);
    expect(contextWindowChanged(a, parseContextWindow({ used: 11, size: 100 }, SESSION, AT))).toBe(true);
    expect(contextWindowChanged(a, parseContextWindow({ used: 10, size: 100 }, "other", AT))).toBe(true);
    expect(contextWindowChanged(a, null)).toBe(true);
    expect(contextWindowChanged(null, null)).toBe(false);
  });
});

describe("provider-cost parsing", () => {
  test("an absent cost member leaves the previous value unchanged", () => {
    // The distinction that a `!= null` check would destroy: a context-only update says
    // nothing about cost and must not clear it.
    expect(parseProviderCost({ used: 1, size: 2 })).toEqual({ kind: "unchanged" });
    expect(parseProviderCost({ used: 1, size: 2, cost: undefined })).toEqual({ kind: "unchanged" });
  });

  test("an explicit null cost clears the value", () => {
    expect(parseProviderCost({ used: 1, size: 2, cost: null })).toEqual({ kind: "cleared" });
  });

  test("a valid cost is converted to canonical decimal money", () => {
    expect(parseProviderCost({ cost: { amount: 1.25, currency: "USD" } })).toEqual({
      kind: "observed",
      cumulative: { amount: "1.25", currency: "USD" },
    });
  });

  test("preserves the float the harness reported rather than tidying it", () => {
    const result = parseProviderCost({ cost: { amount: 0.1 + 0.2, currency: "USD" } });
    expect(result.kind).toBe("observed");
    if (result.kind !== "observed") return;
    expect(result.cumulative.amount).toBe("0.30000000000000004");
  });

  test("expands exponent notation into plain decimal form", () => {
    const result = parseProviderCost({ cost: { amount: 1e-7, currency: "USD" } });
    expect(result.kind).toBe("observed");
    if (result.kind !== "observed") return;
    expect(result.cumulative.amount).toBe("0.0000001");
  });

  test("malformed cost is invalid — distinct from cleared, so it never clears silently", () => {
    for (const cost of [
      { amount: "1.25", currency: "USD" },
      { amount: 1.25 },
      { amount: 1.25, currency: "" },
      { amount: Number.NaN, currency: "USD" },
      { amount: -1, currency: "USD" },
      42,
    ]) {
      const result = parseProviderCost({ cost });
      expect(result.kind).toBe("invalid");
    }
  });

  test("change detection compares amount, currency, and thread", () => {
    const snapshot = (amount: string, currency = "USD", internalSessionId = SESSION) => ({
      internalSessionId,
      cumulative: { amount, currency },
      observedAt: AT,
    });
    expect(providerCostChanged(snapshot("1"), snapshot("1"))).toBe(false);
    expect(providerCostChanged(snapshot("1"), snapshot("2"))).toBe(true);
    expect(providerCostChanged(snapshot("1"), snapshot("1", "EUR"))).toBe(true);
    expect(providerCostChanged(snapshot("1"), snapshot("1", "USD", "other"))).toBe(true);
    expect(providerCostChanged(snapshot("1"), null)).toBe(true);
    expect(providerCostChanged(null, null)).toBe(false);
  });
});
