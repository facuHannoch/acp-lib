import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession, type AgentSessionNotification } from "../src/agent-session.ts";
import { AgentSessionHandoffError } from "../src/metering/record.ts";
import { FileSessionStore } from "../src/session-store.ts";
import { SessionManager } from "../src/session-manager.ts";
import { readTranscriptLines } from "../src/transcript.ts";
import { scanTranscriptContinuation } from "../src/persistence/transcript-scanner.ts";

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
  test("v2 persistence activates the replacement thread and retains canonical history", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-handoff-v2-"));
    const session = await AgentSession.create({
      adapter: { command: ["bun", AGENT, "handoff-v2"] },
      adapterId: "fake",
      agentSessionId: "stable-v2-id",
      creationId: "stable-v2-creation",
      persistence: { root, transcript: { preset: "activity" } },
    });
    live.add(session);
    const originalInternalSessionId = session.internalSessionId;
    // Only a completed turn selects the source thread, and only a selected thread can
    // become internal-session history when the target supersedes it.
    await session.prompt("establish the recorded thread");

    const result = await session.handoff({ summary: "portable v2 continuation" });
    expect(result.fromInternalSessionId).toBe(originalInternalSessionId);
    expect(result.toInternalSessionId).toBe(session.internalSessionId!);
    expect(result.toInternalSessionId).not.toBe(originalInternalSessionId);

    await session.stop();
    live.delete(session);
    const path = session.transcriptPath!;
    const scan = await scanTranscriptContinuation(path);
    expect(scan.reduction.recovery).toEqual({ kind: "clean" });
    expect(scan.reduction.checkpoint.internalSessionId).toBe(result.toInternalSessionId);
    expect(scan.reduction.internalSessionHistory.map((entry) => entry.internalSessionId))
      .toEqual([originalInternalSessionId]);

    const records = (await readFile(path, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.t === "transition").map((record) => record.event))
      .toEqual(["started", "target_created", "target_activated", "completed"]);
    expect(records.filter((record) => record.t === "operation").map((record) => record.operationKind))
      .toEqual(["prompt", "prompt", "handoff_seed", "handoff_seed"]);
  }, 20_000);

  test("v2 persistence retains the source when continuation seeding fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-handoff-v2-failure-"));
    const session = await AgentSession.create({
      adapter: { command: ["bun", AGENT, "fail-seed"] },
      adapterId: "fake",
      agentSessionId: "stable-v2-failure",
      creationId: "stable-v2-failure-creation",
      persistence: { root, transcript: { preset: "activity" } },
    });
    live.add(session);
    const originalInternalSessionId = session.internalSessionId;
    await session.prompt("establish the recorded thread");

    const caught = await session.handoff({ summary: "portable v2 continuation" })
      .then(() => null, (error: unknown) => error);
    expect(caught).toBeInstanceOf(AgentSessionHandoffError);
    expect(String(caught)).toContain("deterministic continuation seed failure");
    // The target never completed a provider turn, so it never earned the right to
    // supersede a source that is still perfectly usable.
    expect(session.internalSessionId).toBe(originalInternalSessionId);
    if (caught instanceof AgentSessionHandoffError) {
      expect(caught.activationCompleted).toBe(false);
      expect(caught.providerAttachment).toBe("runtime_only");
      expect(caught.toInternalSessionId).not.toBe(originalInternalSessionId);
    }
    await session.stop();
    live.delete(session);

    const scan = await scanTranscriptContinuation(session.transcriptPath!);
    expect(scan.reduction.recovery).toEqual({ kind: "clean" });
    expect(scan.reduction.checkpoint.internalSessionId).toBe(originalInternalSessionId);
    expect(scan.reduction.internalSessionHistory).toEqual([]);
    const records = (await readFile(session.transcriptPath!, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.t === "transition").map((record) => record.event))
      .toEqual(["started", "target_created", "failed"]);
    expect(records.filter((record) => record.t === "operation").map((record) => record.event))
      .toEqual(["started", "settled", "started", "failed"]);
  }, 20_000);

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
      providerAttachment: "recorded",
      // A supplied summary removes the generation operation, so only seeding is metered.
      meteringRecords: result.meteringRecords,
    });
    expect(result.meteringRecords.map((record) => record.operationKind)).toEqual(["handoff_seed"]);
    expect(result.meteringRecords[0]?.operationId).toBe(`${result.handoffId}:seed`);
    expect(Object.isFrozen(result)).toBe(true);
    expect(session.internalSessionId).not.toBe(fromInternalSessionId);
    expect(session.state.phase).toBe("idle");
    expect(busyAtStart).toBe(true);
    expect(session.internalSessionCommands.map((command) => command.name)).toContain("status");

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

  test("the catalog selects a thread only once a turn has completed on it", async () => {
    const { session, sessions } = await createSession("catalog");
    const created = session.internalSessionId;
    expect(created).not.toBeNull();
    // The live process is on the thread; nothing has yet made it what a restart returns to.
    expect((await sessions.get("stable-logical-id"))?.internalSessionId ?? null).toBeNull();

    await session.prompt("the turn that earns the thread its place");
    expect((await sessions.get("stable-logical-id"))?.internalSessionId).toBe(created!);

    // A promptless reset moves the live conversation without moving the fallback.
    const reset = await session.reset();
    expect(reset.providerAttachment).toBe("runtime_only");
    expect(session.internalSessionId).toBe(reset.toInternalSessionId);
    expect((await sessions.get("stable-logical-id"))?.internalSessionId).toBe(created!);

    await session.prompt("the turn that earns the reset target its place");
    expect((await sessions.get("stable-logical-id"))?.internalSessionId)
      .toBe(reset.toInternalSessionId);
  }, 20_000);

  test("a failed seed leaves the source thread live and the catalog unchanged", async () => {
    const { session, sessions, transcriptPath } = await createSession("fail-seed");
    const oldInternalSessionId = session.internalSessionId;
    // Only a completed turn puts the source in the catalog, which is what the failed
    // handoff must leave untouched.
    await session.prompt("establish the recorded thread");
    const notifications: AgentSessionNotification[] = [];
    session.subscribe((notification) => notifications.push(notification));

    const caught = await session.handoff({ summary: "portable continuation context" })
      .then(() => null, (error: unknown) => error);
    expect(String(caught)).toContain("deterministic continuation seed failure");

    expect(session.agentSessionId).toBe("stable-logical-id");
    expect(session.internalSessionId).toBe(oldInternalSessionId);
    expect(session.internalSessionId).toBe(session.connection.currentSessionId);
    expect((await sessions.get("stable-logical-id"))?.internalSessionId).toBe(oldInternalSessionId);
    // The failure still names the target it created, so a consumer can tell an unseeded
    // target apart from a handoff that never reached one.
    const failed = notifications.find((notification) =>
      notification.event.kind === "handoff_failed");
    expect(failed?.event.kind === "handoff_failed"
      && failed.event.toInternalSessionId !== oldInternalSessionId).toBe(true);

    const boundaries = (await readTranscriptLines(transcriptPath))
      .filter((line) => line.t === "handoff");
    expect(boundaries.map((line) => line.event)).toEqual(["start", "failed"]);
    expect(boundaries[1]).toMatchObject({
      fromInternalSessionId: oldInternalSessionId,
      error: expect.stringContaining("deterministic continuation seed failure"),
    });
    expect(boundaries[1]!.toInternalSessionId).not.toBe(oldInternalSessionId);
    expect(session.state.phase).toBe("idle");
  });

});
