import { describe, expect, test } from "bun:test";
import { calculateDelta } from "../src/metering/delta.ts";
import {
  activeModel,
  counterInterpretationForAdapter,
  providerIdForAdapter,
} from "../src/metering/provider.ts";
import type { ConfigOptions } from "../src/config-options.ts";

function options(entries: Record<string, unknown>): ConfigOptions {
  const map: ConfigOptions = new Map();
  for (const [configId, currentValue] of Object.entries(entries)) {
    map.set(configId, { configId, type: "unknown", currentValue });
  }
  return map;
}

describe("adapter provider mapping", () => {
  test("maps only single-provider adapters with tested evidence", () => {
    expect(providerIdForAdapter("claude")).toBe("anthropic");
    expect(providerIdForAdapter("claudeCode")).toBe("anthropic");
    expect(providerIdForAdapter("codex")).toBe("openai");
  });

  test("a multiplexing harness resolves to null rather than a guess", () => {
    // OpenCode serves 200+ providers; picking one would engrave a wrong price.
    expect(providerIdForAdapter("opencode")).toBeNull();
    expect(providerIdForAdapter("kimi")).toBeNull();
    expect(providerIdForAdapter("anything-else")).toBeNull();
  });
});

describe("active model discovery", () => {
  test("reads the harness's advertised model config option", () => {
    expect(activeModel(options({ model: "gpt-5.6-terra" }))).toBe("gpt-5.6-terra");
    expect(activeModel(options({ model_id: "opus" }))).toBe("opus");
  });

  test("returns null rather than inventing a default", () => {
    // claude-code-acp 0.16.2 advertises no config options at all.
    expect(activeModel(options({}))).toBeNull();
    expect(activeModel(options({ mode: "agent" }))).toBeNull();
    expect(activeModel(options({ model: "" }))).toBeNull();
    expect(activeModel(options({ model: 42 }))).toBeNull();
  });
});

describe("counter interpretation evidence", () => {
  test("OpenCode is recorded as per-turn from measurement", () => {
    // Three turns each satisfied totalTokens === input + output + cachedRead within a
    // single report, and inputTokens fell 5897 -> 20 between turns.
    expect(counterInterpretationForAdapter("opencode")).toBe("per_turn");
  });

  test("Codex is recorded as per-turn from measurement", () => {
    // Two plain turns of one session: 17948/782/14/17152 then 18080/7059/13/11008 (total/input/output/cachedRead).
    // Read as cumulative, the second is a counter reset; as per-turn, both are attributable as reported.
    expect(counterInterpretationForAdapter("codex")).toBe("per_turn");
    const first = { totalTokens: 17948, inputTokens: 782, outputTokens: 14, cachedReadTokens: 17152, thoughtTokens: 0 };
    const second = { totalTokens: 18080, inputTokens: 7059, outputTokens: 13, cachedReadTokens: 11008, thoughtTokens: 0 };
    for (const report of [first, second]) {
      expect(report.totalTokens).toBe(report.inputTokens + report.outputTokens + report.cachedReadTokens);
    }
    expect(calculateDelta(first, second, { trustedZeroBaseline: false })).toMatchObject({ kind: "counter_reset" });
    expect(calculateDelta(first, second, { trustedZeroBaseline: false, interpretation: counterInterpretationForAdapter("codex") }))
      .toEqual({ kind: "attributable", delta: second });
  });

  test("everything else defaults to cumulative until measured", () => {
    for (const adapter of ["claude", "kimi", "pi", "unknown"]) {
      expect(counterInterpretationForAdapter(adapter)).toBe("cumulative");
    }
  });
});
