import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession, type AgentSessionNotification } from "../src/agent-session.ts";
import { FileSessionStore } from "../src/session-store.ts";
import { SessionManager } from "../src/session-manager.ts";
import { readTranscriptLines } from "../src/transcript.ts";

const AGENT = resolve(import.meta.dir, "../smoke-tests/test5-operations/operations-agent.ts");
const live = new Set<AgentSession>();

afterEach(async () => {
  await Promise.allSettled([...live].map((session) => session.stop()));
  live.clear();
});

async function createSession(label = "handoff-test"): Promise<{
  session: AgentSession;
  sessions: SessionManager;
  transcriptPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "acp-handoff-test-"));
  const sessions = new SessionManager(new FileSessionStore(join(root, "catalog")));
  const transcriptDir = join(root, "transcripts");
  const session = await AgentSession.create({
    adapter: { command: ["bun", AGENT, label] },
    adapterId: "fake",
    agentSessionId: "stable-logical-id",
    sessions,
    transcriptDir,
  });
  live.add(session);
  return {
    session,
    sessions,
    transcriptPath: join(transcriptDir, "stable-logical-id.jsonl"),
  };
}

describe("AgentSession handoff", () => {
  test("replaces only the internal thread and records one logical transcript boundary", async () => {
    const { session, sessions, transcriptPath } = await createSession();
    const originalObject = session;
    const fromInternalSessionId = session.internalSessionId;
    const notifications: AgentSessionNotification[] = [];
    let busyAtStart = false;
    session.subscribe((notification) => {
      notifications.push(notification);
      if (notification.event.kind === "handoff_started") {
        busyAtStart = session.isBusy && session.state.phase === "handoff";
      }
    });

    const result = await session.handoff({ summary: "portable continuation context" });

    expect(session).toBe(originalObject);
    expect(session.agentSessionId).toBe("stable-logical-id");
    expect(result).toEqual({
      handoffId: result.handoffId,
      agentSessionId: "stable-logical-id",
      fromInternalSessionId,
      toInternalSessionId: session.internalSessionId,
      summary: "portable continuation context",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(session.internalSessionId).not.toBe(fromInternalSessionId);
    expect(session.state.phase).toBe("idle");
    expect(busyAtStart).toBe(true);
    expect(session.agentCommands.map((command) => command.name)).toContain("status");

    const record = await sessions.get("stable-logical-id");
    expect(record?.internalSessionId).toBe(session.internalSessionId);
    expect(record?.transcriptPath).toBe(transcriptPath);

    const lines = await readTranscriptLines(transcriptPath);
    const boundaries = lines.filter((line) => line.t === "handoff");
    expect(boundaries.map((line) => line.event)).toEqual(["start", "complete"]);
    expect(boundaries[0]).toMatchObject({
      handoffId: result.handoffId,
      fromInternalSessionId,
    });
    expect(boundaries[1]).toMatchObject({
      handoffId: result.handoffId,
      fromInternalSessionId,
      toInternalSessionId: session.internalSessionId,
      summary: "portable continuation context",
    });
    expect(lines.filter((line) => line.t === "msg")).toEqual([]);

    const kinds = notifications.map((notification) => notification.event.kind);
    expect(kinds).toContain("handoff_started");
    expect(kinds).toContain("handoff_completed");
    expect(kinds.indexOf("handoff_started")).toBeLessThan(kinds.indexOf("handoff_completed"));
  });

  test("generates context on the old thread and serializes handoff behind active work", async () => {
    const { session } = await createSession();
    const events: string[] = [];
    let handoff: Promise<unknown> | null = null;
    const oldInternalSessionId = session.internalSessionId;

    session.subscribe((notification) => {
      events.push(notification.event.kind);
      if (notification.event.kind === "turn_started" && !handoff) {
        handoff = session.handoff();
        expect(session.queuedOperationCount).toBe(1);
      }
    });

    await session.prompt("finish this turn first");
    const result = await handoff as Awaited<ReturnType<AgentSession["handoff"]>>;

    expect(result.summary.trim().length).toBeGreaterThan(0);
    expect(result.fromInternalSessionId).toBe(oldInternalSessionId);
    expect(result.toInternalSessionId).toBe(session.internalSessionId!);
    expect(events.indexOf("turn_completed")).toBeLessThan(events.indexOf("handoff_started"));
    expect(session.state.phase).toBe("idle");
  });

  test("reports a post-switch seed failure without lying about the active internal id", async () => {
    const { session, sessions, transcriptPath } = await createSession("fail-seed");
    const oldInternalSessionId = session.internalSessionId;
    const notifications: AgentSessionNotification[] = [];
    session.subscribe((notification) => notifications.push(notification));

    await expect(session.handoff({ summary: "portable continuation context" })).rejects.toThrow(
      "deterministic continuation seed failure",
    );

    expect(session.agentSessionId).toBe("stable-logical-id");
    expect(session.internalSessionId).not.toBe(oldInternalSessionId);
    expect(session.internalSessionId).toBe(session.connection.currentSessionId);
    expect((await sessions.get("stable-logical-id"))?.internalSessionId).toBe(
      session.internalSessionId,
    );
    expect(notifications.some((notification) =>
      notification.event.kind === "handoff_failed" &&
      notification.event.toInternalSessionId === session.internalSessionId)).toBe(true);

    const boundaries = (await readTranscriptLines(transcriptPath))
      .filter((line) => line.t === "handoff");
    expect(boundaries.map((line) => line.event)).toEqual(["start", "failed"]);
    expect(boundaries[1]).toMatchObject({
      fromInternalSessionId: oldInternalSessionId,
      toInternalSessionId: session.internalSessionId,
      error: expect.stringContaining("deterministic continuation seed failure"),
    });
    expect(session.state.phase).toBe("idle");
  });

});
