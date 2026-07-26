import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession } from "../src/agent-session.ts";
import { readTranscript, readTranscriptLines } from "../src/transcript.ts";

describe("AgentSession transcript config", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "acp-agent-session-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("rejects transcriptPath and transcriptDir together", async () => {
    await expect(
      AgentSession.create({
        adapter: fakeAdapter(),
        adapterId: "fake",
        agentSessionId: "agent-session-1",
        transcriptPath: join(dir, "one.jsonl"),
        transcriptDir: dir,
      }),
    ).rejects.toThrow("cannot specify both transcriptPath and transcriptDir");
  });

  test("uses transcriptDir with agentSessionId as the file name", async () => {
    const session = await AgentSession.create({
      adapter: fakeAdapter(),
      adapterId: "fake",
      agentSessionId: "agent/session:1",
      transcriptDir: dir,
    });

    try {
      const result = await session.prompt("hello");
      expect(result.text).toBe("fake reply to: hello");
    } finally {
      await session.stop();
    }

    const transcriptPath = join(dir, `${encodeURIComponent("agent/session:1")}.jsonl`);
    expect(await readTranscript(transcriptPath)).toEqual([
      { v: 1, t: "msg", role: "user", text: "hello", ts: expect.any(Number) },
      {
        v: 1,
        t: "msg",
        role: "assistant",
        text: "fake reply to: hello",
        ts: expect.any(Number),
        usage: { inputTokens: 2, outputTokens: 4 },
        stopReason: "end_turn",
        status: "completed",
      },
    ]);
  });
  test("records activity lines only when asked", async () => {
    const session = await AgentSession.create({
      adapter: { command: ["bun", resolve(import.meta.dir, "fixtures/terminal-agent.ts")] },
      adapterId: "fake",
      agentSessionId: "with-activity",
      transcriptDir: dir,
      transcriptActivity: true,
    });
    try {
      await session.prompt("run it");
    } finally {
      await session.stop();
    }

    const path = join(dir, "with-activity.jsonl");
    const lines = await readTranscriptLines(path);
    const activity = lines.filter((l) => l.t === "activity");
    expect(activity.map((l) => (l as { kind: string }).kind)).toContain("tool");
    expect(activity.map((l) => (l as { kind: string }).kind)).toContain("tool_update");

    // The message projection stays clean — activity lines are not messages.
    expect((await readTranscript(path)).map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

function fakeAdapter() {
  return {
    command: [
      "bun",
      resolve(import.meta.dir, "../smoke-tests/test1/transcript-smoke.ts"),
      "--fake-agent",
    ],
  };
}
