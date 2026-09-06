import { describe, expect, test } from "bun:test";
import { normalizeTokenUsage } from "../src/metering/usage.ts";
import type { TokenUsage } from "../src/types.ts";

/** The full ACP shape, all six counters populated. */
const FULL = {
  totalTokens: 1500,
  inputTokens: 1000,
  outputTokens: 200,
  cachedReadTokens: 250,
  cachedWriteTokens: 50,
  thoughtTokens: 0,
};

describe("ACP usage normalization", () => {
  test("normalizes all ACP fields, including totalTokens and the cached* names", () => {
    const result = normalizeTokenUsage(FULL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Pins the runtime object shape, not just the static type: an implementation that
    // renamed a field or dropped one would still typecheck against TokenUsage.
    expect(result.usage).toEqual(FULL);
    expect(Object.keys(result.usage).sort()).toEqual([
      "cachedReadTokens",
      "cachedWriteTokens",
      "inputTokens",
      "outputTokens",
      "thoughtTokens",
      "totalTokens",
    ]);
  });

  test("does not accept the pre-rename cacheReadTokens / cacheWriteTokens names", () => {
    const result = normalizeTokenUsage({
      totalTokens: 10,
      inputTokens: 6,
      outputTokens: 4,
      cacheReadTokens: 99,
      cacheWriteTokens: 99,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.cachedReadTokens).toBeUndefined();
    expect(result.usage.cachedWriteTokens).toBeUndefined();
    expect(result.usage).not.toHaveProperty("cacheReadTokens");
  });

  test("an explicit zero is preserved and is not confused with absence", () => {
    const result = normalizeTokenUsage({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.cachedReadTokens).toBe(0);
    expect("cachedReadTokens" in result.usage).toBe(true);
    expect("cachedWriteTokens" in result.usage).toBe(false);
  });

  describe("required counters", () => {
    for (const key of ["totalTokens", "inputTokens", "outputTokens"] as const) {
      test(`a missing ${key} makes the report unavailable rather than zero`, () => {
        const raw: Record<string, unknown> = { ...FULL };
        delete raw[key];
        const result = normalizeTokenUsage(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toContain(key);
      });
    }

    const malformed: ReadonlyArray<readonly [string, unknown]> = [
      ["negative", -1],
      ["fractional", 12.5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["beyond safe integer range", Number.MAX_SAFE_INTEGER + 2],
      ["a numeric string", "1000"],
      ["null", null],
      ["a boolean", true],
    ];
    for (const [label, value] of malformed) {
      test(`${label} inputTokens makes the report unavailable rather than zero`, () => {
        const result = normalizeTokenUsage({ ...FULL, inputTokens: value });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toContain("inputTokens");
      });
    }
  });

  describe("optional counters", () => {
    test("absent optional counters stay absent — absence is never zero", () => {
      const result = normalizeTokenUsage({
        totalTokens: 300,
        inputTokens: 200,
        outputTokens: 100,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.usage).toEqual({ totalTokens: 300, inputTokens: 200, outputTokens: 100 });
      for (const key of ["cachedReadTokens", "cachedWriteTokens", "thoughtTokens"]) {
        expect(key in result.usage).toBe(false);
      }
    });

    test("null optional counters are treated as absent, matching ACP's number|null typing", () => {
      const result = normalizeTokenUsage({
        totalTokens: 300,
        inputTokens: 200,
        outputTokens: 100,
        cachedReadTokens: null,
        cachedWriteTokens: null,
        thoughtTokens: null,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.usage).toEqual({ totalTokens: 300, inputTokens: 200, outputTokens: 100 });
    });

    test("a present-but-malformed optional counter makes the report unavailable", () => {
      // Dropping it would assert the harness never reported the category, which is the
      // fabrication §4 forbids. Corruption is not absence.
      const result = normalizeTokenUsage({ ...FULL, cachedWriteTokens: -5 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("cachedWriteTokens");
    });
  });

  describe("absent and non-object reports", () => {
    test("undefined and null report as unavailable, not as zeroed usage", () => {
      for (const raw of [undefined, null]) {
        const result = normalizeTokenUsage(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe("harness reported no usage");
      }
    });

    test("a non-object usage value is unavailable", () => {
      for (const raw of [42, "usage", true]) {
        expect(normalizeTokenUsage(raw).ok).toBe(false);
      }
    });
  });

  test("the returned report is frozen so callers cannot mutate a shared observation", () => {
    const result = normalizeTokenUsage(FULL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.usage)).toBe(true);
  });

  test("normalization reports counters verbatim and infers no per-turn semantics", () => {
    // Two consecutive cumulative reports. Normalization must pass both through
    // untouched; delta calculation belongs to AgentSession, not here.
    const first = normalizeTokenUsage({ totalTokens: 50, inputTokens: 40, outputTokens: 10 });
    const second = normalizeTokenUsage({ totalTokens: 130, inputTokens: 100, outputTokens: 30 });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.usage.totalTokens).toBe(50);
    expect(second.usage.totalTokens).toBe(130);
  });

  test("the normalized value satisfies the public TokenUsage type", () => {
    const result = normalizeTokenUsage(FULL);
    if (!result.ok) throw new Error("expected a normalized report");
    const usage: TokenUsage = result.usage;
    expect(usage.totalTokens).toBe(1500);
  });
});
