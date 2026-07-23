import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession } from "../src/agent-session.ts";
import { readTranscript } from "../src/transcript.ts";

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
});

function fakeAdapter() {
  return {
    command: [
      "bun",
      resolve("local/test1/transcript-smoke.ts"),
      "--fake-agent",
    ],
  };
}
