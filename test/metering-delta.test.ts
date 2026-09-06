import { describe, expect, test } from "bun:test";
import { baselineMatches, calculateDelta } from "../src/metering/delta.ts";
import type { TokenUsage } from "../src/types.ts";

const usage = (
  totalTokens: number,
  inputTokens: number,
  outputTokens: number,
  optional: Partial<TokenUsage> = {},
): TokenUsage => ({ totalTokens, inputTokens, outputTokens, ...optional });

function attributable(result: ReturnType<typeof calculateDelta>): TokenUsage {
  if (result.kind !== "attributable") throw new Error(`expected a delta, got ${result.kind}`);
  return result.delta;
}

describe("attributable delta calculation", () => {
  test("a library-created thread uses a trusted zero baseline", () => {
    const delta = attributable(
      calculateDelta(null, usage(50_000, 40_000, 10_000), { trustedZeroBaseline: true }),
    );
    expect(delta).toEqual(usage(50_000, 40_000, 10_000));
  });

  test("consecutive cumulative reports produce per-category deltas", () => {
    // The spec's worked example: cumulative 50k → 100k → 130k yields 50k, 50k, 30k.
    const first = usage(50_000, 40_000, 10_000);
    const second = usage(100_000, 80_000, 20_000);
    const third = usage(130_000, 100_000, 30_000);

    expect(attributable(calculateDelta(null, first, { trustedZeroBaseline: true })).totalTokens).toBe(
      50_000,
    );
    expect(attributable(calculateDelta(first, second, { trustedZeroBaseline: false })).totalTokens).toBe(
      50_000,
    );
    expect(attributable(calculateDelta(second, third, { trustedZeroBaseline: false })).totalTokens).toBe(
      30_000,
    );
  });

  test("subtracts optional categories when both reports carry them", () => {
    const delta = attributable(
      calculateDelta(
        usage(100, 60, 40, { cachedReadTokens: 10, thoughtTokens: 5 }),
        usage(250, 150, 100, { cachedReadTokens: 30, thoughtTokens: 9 }),
        { trustedZeroBaseline: false },
      ),
    );
    expect(delta.cachedReadTokens).toBe(20);
    expect(delta.thoughtTokens).toBe(4);
  });

  test("without a trusted baseline nothing is attributable", () => {
    // Reporting the whole cumulative figure would claim one operation incurred all of it.
    const result = calculateDelta(null, usage(130_000, 100_000, 30_000), {
      trustedZeroBaseline: false,
    });
    expect(result.kind).toBe("baseline_required");
  });

  test("a decreasing counter is a reset, never a negative delta", () => {
    const result = calculateDelta(usage(100, 60, 40), usage(30, 20, 10), {
      trustedZeroBaseline: false,
    });
    expect(result.kind).toBe("counter_reset");
    if (result.kind !== "counter_reset") return;
    expect(result.reason).toContain("decreased");
  });

  test("a decreasing optional counter is also a reset", () => {
    const result = calculateDelta(
      usage(100, 60, 40, { cachedReadTokens: 50 }),
      usage(200, 120, 80, { cachedReadTokens: 10 }),
      { trustedZeroBaseline: false },
    );
    expect(result.kind).toBe("counter_reset");
  });

  test("an optional category appearing after an unknown prior value is omitted, not guessed", () => {
    const delta = attributable(
      calculateDelta(usage(100, 60, 40), usage(200, 120, 80, { cachedReadTokens: 25 }), {
        trustedZeroBaseline: false,
      }),
    );
    // 25 is cumulative; the prior value is unknown, so no exact delta exists.
    expect("cachedReadTokens" in delta).toBe(false);
  });

  test("an optional category from a known-zero baseline is attributable in full", () => {
    const delta = attributable(
      calculateDelta(null, usage(200, 120, 80, { cachedReadTokens: 25 }), {
        trustedZeroBaseline: true,
      }),
    );
    expect(delta.cachedReadTokens).toBe(25);
  });

  test("an optional category that disappears contributes nothing rather than a negative", () => {
    const delta = attributable(
      calculateDelta(usage(100, 60, 40, { cachedReadTokens: 10 }), usage(200, 120, 80), {
        trustedZeroBaseline: false,
      }),
    );
    expect("cachedReadTokens" in delta).toBe(false);
  });

  test("an unchanged counter yields an explicit zero delta, not an absent one", () => {
    const baseline = usage(100, 60, 40, { cachedReadTokens: 10 });
    const delta = attributable(
      calculateDelta(baseline, usage(150, 110, 40, { cachedReadTokens: 10 }), {
        trustedZeroBaseline: false,
      }),
    );
    expect(delta.outputTokens).toBe(0);
    expect(delta.cachedReadTokens).toBe(0);
  });

  test("the delta is frozen", () => {
    const result = calculateDelta(null, usage(1, 1, 0), { trustedZeroBaseline: true });
    expect(Object.isFrozen(attributable(result))).toBe(true);
  });
});

describe("restored baseline matching", () => {
  const baseline = { adapterId: "claude", internalSessionId: "sess-1" };

  test("matches only when adapter and provider thread both agree", () => {
    expect(baselineMatches(baseline, { adapterId: "claude", internalSessionId: "sess-1" })).toBe(true);
    expect(baselineMatches(baseline, { adapterId: "codex", internalSessionId: "sess-1" })).toBe(false);
    expect(baselineMatches(baseline, { adapterId: "claude", internalSessionId: "sess-2" })).toBe(false);
    expect(baselineMatches(baseline, { adapterId: "claude", internalSessionId: null })).toBe(false);
  });
});
