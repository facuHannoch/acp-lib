import { describe, expect, test } from "bun:test";
import { MeteringEngine } from "../src/metering/engine.ts";

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
