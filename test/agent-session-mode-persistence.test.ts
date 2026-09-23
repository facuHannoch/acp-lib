import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession } from "../src/agent-session.ts";
import { scanTranscriptContinuation } from "../src/persistence/transcript-scanner.ts";

const roots: string[] = [];
const ACP_AGENT = resolve(import.meta.dir, "../smoke-tests/test1/transcript-smoke.ts");
const PTY_AGENT = resolve(import.meta.dir, "fixtures/idle-pty-agent.ts");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createPersistentSession(name: string): Promise<AgentSession> {
  const root = await mkdtemp(join(tmpdir(), `acp-mode-v2-${name}-`));
  roots.push(root);
  return await AgentSession.create({
    adapter: {
      command: ["bun", ACP_AGENT, "--fake-agent"],
      ptyCommand: ["bun", PTY_AGENT],
    },
    adapterId: "fake",
    agentSessionId: name,
    creationId: `${name}-incarnation`,
    persistence: { root, transcript: { preset: "activity" } },
  });
}

describe("AgentSession mode and reconciliation persistence", () => {
  test("mode replacement is a durable transition retaining the prior ACP thread", async () => {
    const session = await createPersistentSession("mode-session");
    const previousInternalSessionId = session.internalSessionId;
    // Only a completed turn selects the ACP thread, and only a selected thread can be
    // retained as history when the mode transition replaces it.
    await session.prompt("establish the recorded thread");
    const result = await session.setMode("degraded");
    expect(result.sessionId).toBe("");
    expect(session.mode).toBe("degraded");
    expect(session.internalSessionId).toBeNull();
    await session.stop();

    const scan = await scanTranscriptContinuation(session.transcriptPath!);
    expect(scan.reduction.recovery).toEqual({ kind: "clean" });
    expect(scan.reduction.checkpoint.mode).toBe("degraded");
    expect(scan.reduction.checkpoint.protocol).toEqual({ name: "pty" });
    expect(scan.reduction.internalSessionHistory.map((entry) => entry.internalSessionId))
      .toEqual([previousInternalSessionId]);
    const records = (await readFile(session.transcriptPath!, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.t === "transition").map((record) => record.event))
      .toEqual(["started", "target_created", "target_activated", "completed"]);
  }, 25_000);

  test("metering reconciliation advances the durable checkpoint without an operation", async () => {
    const session = await createPersistentSession("reconcile-session");
    const prompt = await session.prompt("meter this");
    const before = await scanTranscriptContinuation(session.transcriptPath!);
    const beforeOperationCount = before.reduction.checkpoint.metering?.operationCount;

    await session.reconcileMetering({
      state: prompt.metering!.nextState,
      reason: "consumer persisted accounting reconciliation",
      reference: "ledger-1",
    });
    await session.stop();

    const after = await scanTranscriptContinuation(session.transcriptPath!);
    expect(after.reduction.checkpoint.stateRevision).toBe(before.reduction.checkpoint.stateRevision + 1);
    expect(after.reduction.checkpoint.metering).toEqual(prompt.metering!.nextState);
    expect(after.reduction.checkpoint.metering?.operationCount).toBe(beforeOperationCount);
    const records = (await readFile(session.transcriptPath!, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.t === "operation")).toHaveLength(2);
  }, 25_000);
});
