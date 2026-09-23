import { describe, expect, test } from "bun:test";
import { MeteringEngine } from "../src/metering/engine.ts";
import type { PricingPolicy, PricingResolver } from "../src/metering/pricing.ts";

const FOLD_POLICY: PricingPolicy = {
  source: { kind: "consumer_override", version: "fold-1" },
  providerId: "anthropic",
  modelId: "claude-sonnet-4-5",
  categoryApplicability: {
    input: "applicable",
    output: "applicable",
    cached_read: "applicable",
    cached_write: "unknown",
    thought: "not_applicable",
  },
  schedules: [
    {
      tier: "default",
      conditions: [{ kind: "default" }],
      cacheInputConvention: {
        cachedRead: "excluded_from_input",
        cachedWrite: "excluded_from_input",
      },
      input: { amount: "3", currency: "USD", perTokens: 1_000_000 },
      output: { amount: "15", currency: "USD", perTokens: 1_000_000 },
      cachedRead: { amount: "0.3", currency: "USD", perTokens: 1_000_000 },
    },
  ],
};

const foldPricing: PricingResolver = () => FOLD_POLICY;

describe("detached metering", () => {
  test("accrues disposable-session usage without replacing the visible baseline", async () => {
    const engine = new MeteringEngine({
      agentSessionId: "agent-detached",
      adapterId: "test",
      enforcement: "best_effort",
      pricing: false,
      createdActiveThread: true,
      counterInterpretation: "cumulative",
    });
    const visible = await engine.open({
      operationId: "visible",
      operationKind: "prompt",
      internalSessionId: "visible-session",
      providerId: null,
      model: null,
      degraded: false,
    });
    await engine.close(visible, {
      outcome: "completed",
      reportedCumulative: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
      contextAfter: null,
      providerCostAfter: null,
    });
    const visibleBaseline = engine.currentState.activeBaseline;

    const detached = await engine.openDetached({
      operationId: "checkpoint",
      operationKind: "conversation_checkpoint",
      internalSessionId: "disposable-session",
      providerId: null,
      model: null,
    });
    const record = await engine.closeDetached(detached, {
      outcome: "completed",
      reportedCumulative: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      contextAfter: null,
      providerCostAfter: null,
    });

    expect(record.usage.status).toBe("metered");
    expect(engine.currentState.operationCount).toBe(2);
    expect(engine.currentState.totals.total.knownTokens).toBe(15);
    expect(engine.currentState.activeBaseline).toEqual(visibleBaseline);
    expect(engine.currentState.activeBaseline?.internalSessionId).toBe("visible-session");
  });
});

describe("adopting a discarded engine's accounting", () => {
  async function meteredEngine(agentSessionId: string, enforcement: "best_effort" | "telemetry_required") {
    return new MeteringEngine({
      agentSessionId,
      adapterId: "test",
      enforcement,
      pricing: foldPricing,
      createdActiveThread: true,
      counterInterpretation: "cumulative",
    });
  }

  async function settle(
    engine: MeteringEngine,
    operationId: string,
    internalSessionId: string,
    reportedCumulative: { inputTokens: number; outputTokens: number; totalTokens: number } | null,
  ) {
    const open = await engine.open({
      operationId,
      operationKind: "prompt",
      internalSessionId,
      providerId: null,
      model: null,
      degraded: false,
    });
    return await engine.close(open, { outcome: "completed", reportedCumulative });
  }

  test("takes the totals but not the baseline, and never clears a block", async () => {
    const source = await meteredEngine("agent-fold", "telemetry_required");
    await settle(source, "source-1", "source-session", { inputTokens: 6, outputTokens: 4, totalTokens: 10 });
    // A missing usage report blocks a session that asked for telemetry-grade metering.
    await settle(source, "source-2", "source-session", null);
    expect(source.blocked).toBe(true);
    const sourceBaseline = source.currentState.activeBaseline;
    expect(sourceBaseline).toMatchObject({ internalSessionId: "source-session" });

    // A transition meters its target on a separate engine seeded from the source's totals.
    const target = await meteredEngine("agent-fold", "telemetry_required");
    target.adoptAccounting(source.currentState);
    await settle(target, "target-1", "target-session", { inputTokens: 5, outputTokens: 5, totalTokens: 10 });
    expect(target.currentState.operationCount).toBeGreaterThan(source.currentState.operationCount);

    const before = source.currentState;
    source.adoptAccounting(target.currentState);

    // The target's settled work is real spend and survives the transition failing.
    expect(source.currentState.operationCount).toBe(target.currentState.operationCount);
    expect(source.currentState.totals.total.knownTokens)
      .toBeGreaterThan(before.totals.total.knownTokens);
    // An accounting fold is not a correction: the source's own baseline and block stand.
    expect(source.currentState.activeBaseline).toEqual(sourceBaseline);
    expect(source.blocked).toBe(true);

    // `reconcile`, by contrast, is a correction and deliberately clears the block.
    source.reconcile(target.currentState);
    expect(source.blocked).toBe(false);
  });
});
