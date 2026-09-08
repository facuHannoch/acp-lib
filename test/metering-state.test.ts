import { describe, expect, test } from "bun:test";
import {
  METERING_STATE_VERSION,
  accrueOperation,
  accumulateByCurrency,
  emptyMeteringState,
  restoreMeteringState,
  type AgentSessionMeteringState,
} from "../src/metering/state.ts";
import { unpricedUsage } from "../src/metering/rating.ts";
import type { CategoryApplicability, TokenCategory } from "../src/metering/pricing.ts";
import type { TokenUsage } from "../src/types.ts";

const APPLICABLE: Record<TokenCategory, CategoryApplicability> = {
  input: "applicable",
  output: "applicable",
  cached_read: "applicable",
  cached_write: "applicable",
  thought: "applicable",
};

const NO_THOUGHT: Record<TokenCategory, CategoryApplicability> = {
  ...APPLICABLE,
  thought: "not_applicable",
};

const delta = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  totalTokens: 100,
  inputTokens: 60,
  outputTokens: 40,
  ...over,
});

function accrue(
  state: AgentSessionMeteringState,
  usage: TokenUsage | null,
  applicability = APPLICABLE,
) {
  return accrueOperation(state, {
    attributable: usage ? unpricedUsage(usage) : null,
    applicability,
    baseline: null,
  });
}

describe("totals accumulation", () => {
  test("sums attributable deltas across operations", () => {
    let state = emptyMeteringState("agent-1");
    state = accrue(state, delta());
    state = accrue(state, delta({ totalTokens: 50, inputTokens: 30, outputTokens: 20 }));
    expect(state.totals.total.knownTokens).toBe(150);
    expect(state.totals.input.knownTokens).toBe(90);
    expect(state.operationCount).toBe(2);
    expect(state.meteredOperationCount).toBe(2);
  });

  test("an unmeasured operation counts without inflating totals", () => {
    let state = emptyMeteringState("agent-1");
    state = accrue(state, delta());
    state = accrue(state, null);
    expect(state.totals.total.knownTokens).toBe(100); // unchanged, not zero-padded
    expect(state.operationCount).toBe(2);
    expect(state.meteredOperationCount).toBe(1);
    expect(state.unmeteredOperationCount).toBe(1);
    expect(state.totals.total.coverage).toBe("partial");
  });

  test("coverage is per category — reported input/output, never-reported cache", () => {
    let state = emptyMeteringState("agent-1");
    state = accrue(state, delta());
    state = accrue(state, delta());
    expect(state.totals.input.coverage).toBe("complete");
    expect(state.totals.output.coverage).toBe("complete");
    // Two operations, neither mentioning cache: unmeasured, not zero.
    expect(state.totals.cachedRead.coverage).toBe("none");
    expect(state.totals.cachedRead.knownTokens).toBe(0);
    expect(state.totals.cachedRead.unavailableOperationCount).toBe(2);
  });

  test("a category nobody uses reads not_applicable, not a metering gap", () => {
    // A non-reasoning model never reports thought tokens; that must not look like failure.
    let state = emptyMeteringState("agent-1");
    state = accrue(state, delta(), NO_THOUGHT);
    state = accrue(state, delta(), NO_THOUGHT);
    expect(state.totals.thought.coverage).toBe("not_applicable");
    expect(state.totals.thought.notApplicableOperationCount).toBe(2);
    expect(state.totals.thought.unavailableOperationCount).toBe(0);
  });

  test("a category reported by some operations and not others is partial", () => {
    let state = emptyMeteringState("agent-1");
    state = accrue(state, delta({ cachedReadTokens: 10 }));
    state = accrue(state, delta());
    expect(state.totals.cachedRead.coverage).toBe("partial");
    expect(state.totals.cachedRead.knownTokens).toBe(10);
    expect(state.totals.cachedRead.attributedOperationCount).toBe(1);
    expect(state.totals.cachedRead.unavailableOperationCount).toBe(1);
  });

  test("an explicit reported zero is a measurement, unlike an absent counter", () => {
    let state = emptyMeteringState("agent-1");
    state = accrue(state, delta({ cachedReadTokens: 0 }));
    expect(state.totals.cachedRead.attributedOperationCount).toBe(1);
    expect(state.totals.cachedRead.unavailableOperationCount).toBe(0);
    expect(state.totals.cachedRead.coverage).toBe("complete");
  });

  test("knownTokens is always a lower bound, never padded for missing reports", () => {
    let state = emptyMeteringState("agent-1");
    state = accrue(state, delta({ cachedReadTokens: 7 }));
    state = accrue(state, null);
    expect(state.totals.cachedRead.knownTokens).toBe(7);
    expect(state.totals.cachedRead.coverage).toBe("partial");
  });

  test("the aggregate total never reads not_applicable", () => {
    let state = emptyMeteringState("agent-1");
    state = accrue(state, delta(), NO_THOUGHT);
    expect(["complete", "partial", "none"]).toContain(state.totals.total.coverage);
  });

  test("state is frozen and the previous value is untouched", () => {
    const first = emptyMeteringState("agent-1");
    const second = accrue(first, delta());
    expect(Object.isFrozen(second)).toBe(true);
    expect(first.operationCount).toBe(0);
    expect(second.operationCount).toBe(1);
  });
});

describe("rated cost accumulation", () => {
  test("sums same-currency amounts exactly without re-rounding", () => {
    const first = accumulateByCurrency([], { amount: "0.000000000001", currency: "USD" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = accumulateByCurrency(first.value, { amount: "0.000000000002", currency: "USD" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toEqual([{ amount: "0.000000000003", currency: "USD" }]);
  });

  test("keeps one amount per currency and never merges them", () => {
    let totals: readonly { amount: string; currency: string }[] = [];
    for (const addition of [
      { amount: "1", currency: "USD" },
      { amount: "2", currency: "EUR" },
      { amount: "0.5", currency: "USD" },
    ]) {
      const result = accumulateByCurrency(totals, addition);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      totals = result.value;
    }
    expect(totals).toEqual([
      { amount: "1.5", currency: "USD" },
      { amount: "2", currency: "EUR" },
    ]);
  });

  test("canonicalizes a first-seen amount", () => {
    const result = accumulateByCurrency([], { amount: "1.50", currency: "USD" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.amount).toBe("1.5");
  });
});

describe("state restoration", () => {
  test("absent state is not an error", () => {
    expect(restoreMeteringState(undefined, "agent-1")).toEqual({ status: "not_provided" });
  });

  test("matching state restores", () => {
    const state = emptyMeteringState("agent-1");
    const result = restoreMeteringState(state, "agent-1");
    expect(result.status).toBe("restored");
    if (result.status !== "restored") return;
    expect(result.version).toBe(METERING_STATE_VERSION);
    expect(result.state).toBe(state);
  });

  test("a mismatched agentSessionId is refused", () => {
    const result = restoreMeteringState(emptyMeteringState("other"), "agent-1");
    expect(result).toEqual({ status: "ignored", reason: "initial_state_identity_mismatch" });
  });

  test("a foreign version is refused wholesale, never partially read", () => {
    // Fields that happen to line up between versions are the dangerous near-match: the
    // restore would look successful.
    const future = { ...emptyMeteringState("agent-1"), version: 4 } as unknown as AgentSessionMeteringState;
    const result = restoreMeteringState(future, "agent-1");
    expect(result).toEqual({
      status: "ignored",
      reason: "initial_state_version_unsupported",
      providedVersion: 4,
    });
  });

  test("a missing version is refused", () => {
    const legacy = { agentSessionId: "agent-1" } as unknown as AgentSessionMeteringState;
    const result = restoreMeteringState(legacy, "agent-1");
    expect(result.status).toBe("ignored");
    if (result.status !== "ignored") return;
    expect(result.reason).toBe("initial_state_version_unsupported");
  });
});

describe("structural validation of restored state", () => {
  const corrupt = (mutate: (state: Record<string, any>) => void) => {
    const state = structuredClone(emptyMeteringState("agent-1")) as Record<string, any>;
    mutate(state);
    return restoreMeteringState(state as AgentSessionMeteringState, "agent-1");
  };

  test("a matching version and id is not proof the rest survived", () => {
    // This state comes back from a consumer's database and feeds totals a bill is drawn
    // from, so a truncated write must be refused rather than absorbed.
    for (const mutate of [
      (s: Record<string, any>) => delete s.totals,
      (s: Record<string, any>) => (s.totals.input = undefined),
      (s: Record<string, any>) => (s.totals.total.knownTokens = -5),
      (s: Record<string, any>) => (s.totals.output.knownTokens = "many"),
      (s: Record<string, any>) => (s.operationCount = 1.5),
      (s: Record<string, any>) => (s.ratedCosts = [{ amount: "1e6", currency: "USD" }]),
      (s: Record<string, any>) => (s.activeBaseline = { adapterId: "x" }),
      (s: Record<string, any>) =>
        (s.activeBaseline = {
          adapterId: "x",
          internalSessionId: "y",
          reportedUsage: { totalTokens: -1, inputTokens: 0, outputTokens: 0 },
        }),
    ]) {
      const result = corrupt(mutate);
      expect(result.status).toBe("ignored");
      if (result.status !== "ignored") continue;
      expect(result.reason).toBe("initial_state_malformed");
    }
  });

  test("a well-formed state with a valid baseline still restores", () => {
    const result = corrupt((state) => {
      state.activeBaseline = {
        adapterId: "claude",
        internalSessionId: "sess-1",
        reportedUsage: { totalTokens: 100, inputTokens: 60, outputTokens: 40 },
      };
    });
    expect(result.status).toBe("restored");
  });
});

describe("unallocated cost that cannot be represented", () => {
  const accrueUnallocated = (
    state: AgentSessionMeteringState,
    entries: readonly { usage: TokenUsage; ratedCost: { amount: string; currency: string } | null }[],
  ) =>
    accrueOperation(state, {
      attributable: null,
      applicability: null,
      baseline: null,
      unallocated: entries.map((entry) => ({ ...entry, reason: "test" })),
    });

  test("a record with no usable cost is counted, not silently skipped", () => {
    // Otherwise an empty total with a non-zero record count is indistinguishable from work
    // that genuinely cost nothing — a partial total that looks complete.
    const state = accrueUnallocated(emptyMeteringState("agent-1"), [
      { usage: delta(), ratedCost: null },
    ]);
    expect(state.unallocatedUsage.recordCount).toBe(1);
    expect(state.unallocatedUsage.ratedCosts.amounts).toEqual([]);
    expect(state.unallocatedUsage.ratedCosts.unaccounted).toBe(1);
  });

  test("an unusable cost is counted, not dropped", () => {
    let state = accrueUnallocated(emptyMeteringState("agent-1"), [
      { usage: delta(), ratedCost: { amount: "0.5", currency: "USD" } },
    ]);
    state = accrueUnallocated(state, [
      { usage: delta(), ratedCost: { amount: "bogus", currency: "USD" } },
    ]);
    // A lower bound, and the total itself says by how many contributions.
    expect(state.unallocatedUsage.ratedCosts.amounts).toEqual([{ amount: "0.5", currency: "USD" }]);
    expect(state.unallocatedUsage.ratedCosts.unaccounted).toBe(1);
  });

  test("different currencies coexist rather than one being dropped", () => {
    const state = accrueUnallocated(emptyMeteringState("agent-1"), [
      { usage: delta(), ratedCost: { amount: "10", currency: "USD" } },
      { usage: delta(), ratedCost: { amount: "10", currency: "EUR" } },
    ]);
    expect(state.unallocatedUsage.ratedCosts.amounts).toEqual([
      { amount: "10", currency: "USD" },
      { amount: "10", currency: "EUR" },
    ]);
    expect(state.unallocatedUsage.ratedCosts.unaccounted).toBe(0);
  });

  test("fully costed records leave nothing unaccounted", () => {
    const state = accrueUnallocated(emptyMeteringState("agent-1"), [
      { usage: delta(), ratedCost: { amount: "0.25", currency: "USD" } },
      { usage: delta(), ratedCost: { amount: "0.25", currency: "USD" } },
    ]);
    expect(state.unallocatedUsage.ratedCosts).toEqual({
      amounts: [{ amount: "0.5", currency: "USD" }],
      unaccounted: 0,
    });
  });

  test("tokens are still recorded even when the cost is not", () => {
    const state = accrueUnallocated(emptyMeteringState("agent-1"), [
      { usage: delta(), ratedCost: null },
    ]);
    expect(state.unallocatedUsage.knownTokens.totalTokens).toBe(100);
    expect(state.totals.total.knownTokens).toBe(0);
  });
});
