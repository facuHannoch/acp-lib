import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { AgentSession, type AgentSessionEvent } from "../src/agent-session.ts";

function terminalAdapter() {
  return { command: ["bun", resolve(import.meta.dir, "fixtures/terminal-agent.ts")] };
}

async function openSession() {
  const events: AgentSessionEvent[] = [];
  const session = await AgentSession.create({
    adapter: terminalAdapter(),
    adapterId: "fake",
    agentSessionId: "agent-metering-1",
  });
  session.subscribe((notification) => events.push(notification.event));
  return { session, events };
}

describe("AgentSession context-window and provider-cost state", () => {
  test("observes a usage_update that arrives outside any turn", async () => {
    // The fixture emits this right after session/new, before a prompt exists. Routing
    // usage updates only through per-turn handlers would lose it.
    const { session, events } = await openSession();
    try {
      expect(session.contextWindow).toEqual({
        internalSessionId: "sess-1",
        usedTokens: 8,
        sizeTokens: 200_000,
        remainingTokens: 199_992,
        utilization: 8 / 200_000,
        observedAt: expect.any(Number),
      });
      expect(session.providerCost?.cumulative).toEqual({ amount: "0.001", currency: "USD" });
      // The observation is applied during create(), before a caller can subscribe, so the
      // state getter — not an event — is what proves it was not dropped.
      expect(events).toEqual([]);
    } finally {
      await session.stop();
    }
  });

  test("a turn's usage_update replaces the previous snapshot and notifies", async () => {
    const { session, events } = await openSession();
    try {
      await session.prompt("hello");
      expect(session.contextWindow?.usedTokens).toBe(120);
      expect(session.contextWindow?.remainingTokens).toBe(199_880);
      expect(session.providerCost?.cumulative.amount).toBe("0.0125");

      const contextEvents = events.filter((e) => e.kind === "context_window_changed");
      expect(contextEvents).toHaveLength(1);
      const latest = contextEvents.at(-1);
      expect(latest?.kind === "context_window_changed" && latest.contextWindow?.usedTokens).toBe(120);
    } finally {
      await session.stop();
    }
  });

  test("the snapshot is a frozen value a listener cannot mutate for others", async () => {
    const { session } = await openSession();
    try {
      expect(Object.isFrozen(session.contextWindow)).toBe(true);
      expect(Object.isFrozen(session.providerCost)).toBe(true);
    } finally {
      await session.stop();
    }
  });

  test("context and cost are null before any observation", async () => {
    // The fake agent in the transcript smoke test never sends usage_update.
    const session = await AgentSession.create({
      adapter: {
        command: [
          "bun",
          resolve(import.meta.dir, "../smoke-tests/test1/transcript-smoke.ts"),
          "--fake-agent",
        ],
      },
      adapterId: "fake",
      agentSessionId: "agent-metering-2",
    });
    try {
      expect(session.contextWindow).toBeNull();
      expect(session.providerCost).toBeNull();
      await session.prompt("hello");
      // Absence of a report is not a zero-token context window.
      expect(session.contextWindow).toBeNull();
      expect(session.providerCost).toBeNull();
    } finally {
      await session.stop();
    }
  });
});
