import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  AgentSession,
  type AgentSessionNotification,
} from "../src/agent-session.ts";

const AGENT = resolve(import.meta.dir, "../smoke-tests/test1/transcript-smoke.ts");
const live = new Set<AgentSession>();

afterEach(async () => {
  await Promise.allSettled([...live].map((session) => session.stop()));
  live.clear();
});

async function createSession(): Promise<AgentSession> {
  const session = await AgentSession.create({
    adapter: { command: ["bun", AGENT, "--fake-agent"] },
    adapterId: "fake",
  });
  live.add(session);
  return session;
}

describe("AgentSession state and notifications", () => {
  test("publishes ordered turn lifecycle around an authoritative state snapshot", async () => {
    const session = await createSession();
    const notifications: AgentSessionNotification[] = [];
    let busyAtStart = false;
    const unsubscribe = session.subscribe((notification) => {
      notifications.push(notification);
      if (notification.event.kind === "turn_started") busyAtStart = session.isBusy;
    });

    expect(session.state).toEqual({
      phase: "idle",
      isBusy: false,
      queuedOperationCount: 0,
      agentSessionId: session.agentSessionId,
      internalSessionId: session.internalSessionId,
      adapterId: "fake",
      mode: "normal",
    });
    expect(Object.isFrozen(session.state)).toBe(true);

    const result = await session.prompt("hello state");
    unsubscribe();

    expect(result.text).toBe("fake reply to: hello state");
    expect(busyAtStart).toBe(true);
    expect(session.isBusy).toBe(false);
    expect(session.queuedOperationCount).toBe(0);
    expect(session.state.phase).toBe("idle");

    const kinds = notifications.map((notification) => notification.event.kind);
    expect(kinds).toContain("turn_started");
    expect(kinds).toContain("turn_completed");
    expect(notifications.every((notification, index) =>
      notification.agentSessionId === session.agentSessionId &&
      notification.ts > 0 &&
      (index === 0 || notification.seq > notifications[index - 1]!.seq))).toBe(true);

    const completed = notifications.find((notification) =>
      notification.event.kind === "turn_completed");
    expect(completed?.event).toMatchObject({ kind: "turn_completed", result });
    if (completed?.event.kind === "turn_completed") {
      expect(Object.isFrozen(completed.event.result)).toBe(true);
      expect(Object.isFrozen(completed.event.result.usage!)).toBe(true);
    }
  });

  test("reports queued work without a false idle transition between turns", async () => {
    const session = await createSession();
    const notifications: AgentSessionNotification[] = [];
    let second: Promise<unknown> | null = null;
    let started = 0;

    session.subscribe((notification) => {
      notifications.push(notification);
      if (notification.event.kind === "turn_started" && started++ === 0) {
        second = session.prompt("second");
        expect(session.isBusy).toBe(true);
        expect(session.queuedOperationCount).toBe(1);
      }
    });

    await session.prompt("first");
    await second;

    const startedIndexes = notifications
      .map((notification, index) => notification.event.kind === "turn_started" ? index : -1)
      .filter((index) => index >= 0);
    expect(startedIndexes).toHaveLength(2);
    const between = notifications.slice(startedIndexes[0]! + 1, startedIndexes[1]);
    expect(between.some((notification) =>
      notification.event.kind === "state_changed" && notification.event.state.phase === "idle"))
      .toBe(false);
    expect(session.state.phase).toBe("idle");
  });

  test("isolates listener failures and unsubscribe stops delivery", async () => {
    const session = await createSession();
    let delivered = 0;
    session.subscribe(() => {
      throw new Error("observer broke");
    });
    const unsubscribe = session.subscribe(() => delivered++);

    await expect(session.prompt("still works")).resolves.toMatchObject({ status: "completed" });
    expect(delivered).toBeGreaterThan(0);

    const before = delivered;
    unsubscribe();
    await expect(session.prompt("after unsubscribe")).resolves.toMatchObject({ status: "completed" });
    expect(delivered).toBe(before);
  });

  test("emits turn_failed and exposes stopped as a terminal state", async () => {
    const session = await createSession();
    const kinds: string[] = [];
    session.subscribe((notification) => kinds.push(notification.event.kind));

    // Simulate loss of the live leaf while the stable AgentSession object remains.
    await session.connection.stop();
    await expect(session.prompt("cannot run")).rejects.toThrow();
    expect(kinds).toContain("turn_started");
    expect(kinds).toContain("turn_failed");

    await session.stop();
    expect(session.state.phase).toBe("stopped");
    expect(session.isBusy).toBe(false);
    await expect(session.prompt("after stop")).rejects.toThrow("AgentSession is stopped");
  });

  test("stop clears queued work and cannot transition back out of stopped", async () => {
    const session = await createSession();
    let queued: Promise<unknown> | null = null;
    let stopping: Promise<void> | null = null;

    session.subscribe((notification) => {
      if (notification.event.kind !== "turn_started" || stopping) return;
      queued = session.prompt("must never start");
      stopping = session.stop();
    });

    await Promise.allSettled([session.prompt("active"), queued, stopping].filter(Boolean));
    // Give the interrupted pump a microtask boundary to run its finally block.
    await Promise.resolve();

    expect(session.state.phase).toBe("stopped");
    expect(session.isBusy).toBe(false);
    expect(session.queuedOperationCount).toBe(0);
    await expect(session.prompt("still stopped")).rejects.toThrow("AgentSession is stopped");
  });
});
