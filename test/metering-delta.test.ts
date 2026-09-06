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

describe("per-turn harnesses", () => {
  const perTurn = { trustedZeroBaseline: false, interpretation: "per_turn" as const };

  test("the report IS the delta — nothing is subtracted", () => {
    const report = usage(9996, 5897, 3, { cachedReadTokens: 4096 });
    expect(attributable(calculateDelta(null, report, perTurn))).toEqual(report);
  });

  test("needs no baseline at all", () => {
    // Each report already describes one operation, so there is nothing to trust.
    const result = calculateDelta(null, usage(100, 60, 40), perTurn);
    expect(result.kind).toBe("attributable");
  });

  test("a smaller turn is not a counter reset", () => {
    // OpenCode's inputTokens fell 5897 -> 20 between turns; under the cumulative reading
    // that is a reset, under the per-turn reading it just means a shorter turn.
    const previous = usage(9996, 5897, 3, { cachedReadTokens: 4096 });
    const next = usage(10024, 20, 20, { cachedReadTokens: 9984 });
    expect(calculateDelta(previous, next, { ...perTurn }).kind).toBe("attributable");
    // The same pair under the cumulative reading is a reset.
    expect(
      calculateDelta(previous, next, { trustedZeroBaseline: false }).kind,
    ).toBe("counter_reset");
  });

  test("successive turns each attribute their own usage", () => {
    // The three turns actually measured on opencode/big-pickle.
    const turns = [
      usage(9996, 5897, 3, { cachedReadTokens: 4096 }),
      usage(10024, 20, 20, { cachedReadTokens: 9984 }),
      usage(10035, 48, 3, { cachedReadTokens: 9984 }),
    ];
    let baseline: (typeof turns)[number] | null = null;
    const attributed: number[] = [];
    for (const turn of turns) {
      attributed.push(attributable(calculateDelta(baseline, turn, perTurn)).totalTokens);
      baseline = turn;
    }
    expect(attributed).toEqual([9996, 10024, 10035]);
  });
});
