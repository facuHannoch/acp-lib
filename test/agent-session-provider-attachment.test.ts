import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession } from "../src/agent-session.ts";
import { scanTranscriptContinuation } from "../src/persistence/transcript-scanner.ts";

const AGENT = resolve(import.meta.dir, "../smoke-tests/test5-operations/operations-agent.ts");
const roots: string[] = [];
const live = new Set<AgentSession>();

afterEach(async () => {
  await Promise.allSettled([...live].map((session) => session.stop()));
  live.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `acp-attachment-${name}-`));
  roots.push(directory);
  return directory;
}

function track(session: AgentSession): AgentSession {
  live.add(session);
  return session;
}

async function create(directory: string, label: string, agentSessionId: string) {
  return track(await AgentSession.create({
    adapter: { command: ["bun", AGENT, label] },
    adapterId: "fake",
    agentSessionId,
    creationId: `${agentSessionId}-incarnation`,
    persistence: { root: directory, transcript: { preset: "activity" } },
  }));
}

function open(directory: string, label: string, agentSessionId: string) {
  return AgentSession.open({
    adapter: { command: ["bun", AGENT, label] },
    adapterId: "fake",
    agentSessionId,
    persistence: { root: directory, transcript: { preset: "activity" } },
  });
}

describe("direct transcript provider attachment", () => {
  test("creation leaves the thread slot empty until a turn completes on it", async () => {
    const directory = await root("create");
    const session = await create(directory, "attach", "attach-session");
    const created = session.internalSessionId;
    expect(created).not.toBeNull();

    // The live process can use the thread; nothing has yet justified selecting it as
    // what a later open should resume.
    const before = await scanTranscriptContinuation(session.transcriptPath!);
    expect(before.reduction.checkpoint.internalSessionId).toBeNull();
    expect(before.reduction.checkpoint.internalSessionActivatedAt).toBeNull();
    expect(before.reduction.checkpoint.adapterId).toBe("fake");

    const result = await session.prompt("the turn that earns the thread its place");
    expect(result.status).toBe("completed");

    const after = await scanTranscriptContinuation(session.transcriptPath!);
    expect(after.reduction.recovery).toEqual({ kind: "clean" });
    expect(after.reduction.checkpoint.internalSessionId).toBe(created);
    expect(after.reduction.checkpoint.internalSessionActivatedAt).not.toBeNull();
    // The response and the thread it came from land in the same terminal checkpoint.
    expect(after.reduction.checkpoint.boundary).toMatchObject({ status: "settled" });
  }, 20_000);

  test("a never-prompted conversation reopens on a fresh thread, not a reconstruction", async () => {
    const directory = await root("fresh");
    const session = await create(directory, "attach", "fresh-session");
    const abandoned = session.internalSessionId;
    await session.stop();
    live.delete(session);

    const reopened = await open(directory, "attach", "fresh-session");
    track(reopened.session);
    expect(reopened.continuation.outcome).toEqual({
      kind: "fresh",
      activeInternalSessionId: reopened.session.internalSessionId!,
    });
    expect(reopened.continuation.recordedInternalSessionId).toBeNull();
    // Nothing was continued because nothing was ever recorded to continue from.
    expect(reopened.continuation.attempts.every((attempt) => attempt.status === "skipped")).toBe(true);
    expect(reopened.session.internalSessionId).not.toBe(abandoned);
    expect(reopened.promptability).toEqual({ promptable: true, blockers: [] });

    // The fresh thread is itself unrecorded until it completes a turn.
    expect(reopened.session.providerAttachmentState.kind).toBe("runtime_only");
    const scan = await scanTranscriptContinuation(reopened.session.transcriptPath!);
    expect(scan.reduction.checkpoint.internalSessionId).toBeNull();
  }, 20_000);

  test("a prompted conversation reopens by loading the thread it recorded", async () => {
    const directory = await root("load");
    const session = await create(directory, "attach", "load-session");
    await session.prompt("the turn that earns the thread its place");
    const recorded = session.internalSessionId;
    await session.stop();
    live.delete(session);

    const reopened = await open(directory, "attach", "load-session");
    track(reopened.session);
    expect(reopened.continuation.outcome).toEqual({
      kind: "loaded",
      activeInternalSessionId: recorded!,
    });
    expect(reopened.session.internalSessionId).toBe(recorded!);
    // A loaded thread was established before this process ran, so it is already the
    // selected continuation rather than something a turn still has to earn.
    expect(reopened.session.providerAttachmentState).toMatchObject({
      kind: "recorded",
      descriptor: { internalSessionId: recorded! },
    });
  }, 20_000);

  test("a failed first prompt leaves the thread slot empty", async () => {
    const directory = await root("failed");
    const session = await create(directory, "fail-seed", "failed-session");

    // `FAIL_TARGET_PROMPT` makes the harness reject this turn outright.
    await expect(session.prompt("FAIL_TARGET_PROMPT")).rejects.toThrow();

    const scan = await scanTranscriptContinuation(session.transcriptPath!);
    expect(scan.reduction.checkpoint.internalSessionId).toBeNull();
    expect(scan.reduction.recovery).toEqual({ kind: "clean" });

    // A later successful turn can still record the same thread.
    const live_ = session.internalSessionId;
    await session.prompt("the turn that earns the thread its place");
    const after = await scanTranscriptContinuation(session.transcriptPath!);
    expect(after.reduction.checkpoint.internalSessionId).toBe(live_);
  }, 20_000);
});
