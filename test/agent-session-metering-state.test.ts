import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { AgentSession, type AgentSessionEvent } from "../src/agent-session.ts";

function usageAdapter() {
  return { command: ["bun", resolve(import.meta.dir, "fixtures/usage-agent.ts")] };
}

/**
 * Wait for a value to appear.
 *
 * The fixture sends its out-of-turn usage_update after the session/new response, so
 * whether it has been processed by the time create() resolves is a genuine race — the
 * library never promises to have consumed a notification the agent sent afterwards.
 */
async function waitFor<T>(read: () => T | null, label: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function openSession() {
  const events: AgentSessionEvent[] = [];
  const session = await AgentSession.create({
    adapter: usageAdapter(),
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
      const contextWindow = await waitFor(() => session.contextWindow, "context window");
      expect(contextWindow).toEqual({
        internalSessionId: "usage-sess-1",
        usedTokens: 8,
        sizeTokens: 200_000,
        remainingTokens: 199_992,
        utilization: 8 / 200_000,
        observedAt: expect.any(Number),
      });
      const providerCost = await waitFor(() => session.providerCost, "provider cost");
      expect(providerCost.cumulative).toEqual({ amount: "0.001", currency: "USD" });
      // Whether this arrives before or after the caller subscribes is timing, so the
      // state getter — not an event count — is what proves it was not dropped.
      expect(events.every((e) => e.kind !== "turn_started")).toBe(true);
    } finally {
      await session.stop();
    }
  });

  test("a turn's usage_update replaces the previous snapshot and notifies", async () => {
    const { session, events } = await openSession();
    try {
      await session.prompt("hello");
      expect(session.contextWindow?.usedTokens).toBe(100);
      expect(session.contextWindow?.remainingTokens).toBe(199_900);
      // No cost on the in-turn update: an absent member must leave the previous snapshot
      // alone rather than clearing it.
      expect(session.providerCost?.cumulative.amount).toBe("0.001");

      // Assert the latest observation, not a count: the out-of-turn update may or may not
      // have landed before the subscription, and either is correct.
      const contextEvents = events.filter((e) => e.kind === "context_window_changed");
      expect(contextEvents.length).toBeGreaterThanOrEqual(1);
      const latest = contextEvents.at(-1);
      expect(latest?.kind === "context_window_changed" && latest.contextWindow?.usedTokens).toBe(100);
    } finally {
      await session.stop();
    }
  });

  test("the snapshot is a frozen value a listener cannot mutate for others", async () => {
    const { session } = await openSession();
    try {
      expect(Object.isFrozen(await waitFor(() => session.contextWindow, "context"))).toBe(true);
      expect(Object.isFrozen(await waitFor(() => session.providerCost, "cost"))).toBe(true);
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
