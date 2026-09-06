import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession, type AgentSessionConfig } from "../src/agent-session.ts";
import {
  foldFrame,
  wireFrames,
  type ActivitySnapshot,
  type AggregatedRecord,
  type ApplyResult,
} from "../src/activity.ts";
import {
  appendTranscriptLine,
  readActivityRecords,
  readTranscript,
  readTranscriptLines,
  toActivityRecord,
  type TranscriptActivityLine,
} from "../src/transcript.ts";

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
      expect(result.messages).toEqual([{ text: "fake reply to: hello" }]);
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
        messages: [{ text: "fake reply to: hello" }],
        ts: expect.any(Number),
        usage: { totalTokens: 6, inputTokens: 2, outputTokens: 4 },
        stopReason: "end_turn",
        status: "completed",
      },
    ]);
  });
  test("records settled activity records, not raw deltas", async () => {
    const path = await runTerminalTurn({ transcriptActivity: true });
    const activity = await activityLines(path);

    // One tool call, one line per lifecycle step — announced → input → settled. The raw
    // stream carried three tool notifications plus two more updates behind them; what
    // matters is that `tool_update` is not a persisted kind any more: it folded in.
    expect(activity.map((l) => l.kind)).toEqual(["tool", "tool", "tool", "unknown", "usage"]);
    const calls = activity.filter((l) => l.kind === "tool");
    expect(calls.map((l) => l.reason)).toEqual(["announced", "input", "settled"]);
    expect(new Set(calls.map((l) => l.recordId))).toEqual(new Set(["call-1"]));

    // Every line is self-contained: the settled one carries the whole call, including the
    // fields that arrived on separate updates (R2).
    const settled = calls[2] as Record<string, unknown>;
    expect(settled.status).toBe("completed");
    expect(settled.title).toBe("Terminal"); // set on announce, never resent
    expect(settled.rawInput).toEqual({ command: "printf 'hello from terminal'" });
    expect(settled.content).toEqual([
      { type: "content", content: { type: "text", text: "hello from terminal" }, text: "hello from terminal" },
    ]);

    // The message projection stays clean — activity lines are not messages.
    expect((await readTranscript(path)).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("a settled transcript folds back to one record per thing", async () => {
    const path = await runTerminalTurn({ transcriptActivity: true });
    const folded = await readActivityRecords(path);

    // Three lines for the call, one record — last wins on `recordId`.
    expect([...folded.keys()].filter((id) => id === "call-1")).toEqual(["call-1"]);
    const call = folded.get("call-1")!;
    expect(call.reason).toBe("settled");
    expect((call.event as { status: string }).status).toBe("completed");
    expect((call.event as { title: string }).title).toBe("Terminal");
  });

  test("0.2.x raw activity lines are not foldable, and say so", async () => {
    const path = join(dir, "legacy.jsonl");
    // What 0.2.0 wrote: a raw delta with no recordId/reason. Those two fields are the
    // discriminator, which is why the format version did not have to change.
    await appendTranscriptLine(path, {
      v: 1,
      t: "activity",
      ts: 1,
      kind: "tool",
      toolCallId: "t1",
    });
    const line = (await activityLines(path))[0]!;
    expect(toActivityRecord(line)).toBeNull();
    expect(await readActivityRecords(path)).toEqual(new Map());
  });

  test("writes no activity lines by default", async () => {
    const path = await runTerminalTurn({});
    expect(await activityLines(path)).toEqual([]);
    expect((await readTranscript(path)).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("kinds filters what is persisted", async () => {
    const path = await runTerminalTurn({ transcriptActivity: { kinds: ["usage"] } });
    expect((await activityLines(path)).map((l) => l.kind)).toEqual(["usage"]);
  });

  test("checkpointOnInput off drops the mid-call checkpoint", async () => {
    const path = await runTerminalTurn({ transcriptActivity: { checkpointOnInput: false } });
    const calls = (await activityLines(path)).filter((l) => l.kind === "tool");
    expect(calls.map((l) => l.reason)).toEqual(["announced", "settled"]);
  });

  test("maxBytes caps individual fields and marks the line", async () => {
    const path = await runTerminalTurn({ transcriptActivity: { maxBytes: 5 } });
    const settled = (await activityLines(path)).filter((l) => l.kind === "tool").at(-1)!;

    expect(settled.truncated).toBe(true);
    const content = settled.content as Array<{ text: string; content: { text: string } }>;
    expect(content[0]!.text).toBe("hello… [truncated 14 bytes]");
    // The nested block holds the same string and is capped too, or the cap saves nothing.
    expect(content[0]!.content.text).toBe("hello… [truncated 14 bytes]");
    // An oversized rawInput object becomes its truncated serialization — lossy, and the
    // `truncated` flag is what says so.
    expect(typeof settled.rawInput).toBe("string");
    // Structure survives: the line is still parseable JSON with its envelope intact.
    expect(settled.status).toBe("completed");
  });

  test("activity records reach onRecord, whether or not a transcript exists", async () => {
    const session = await AgentSession.create({
      adapter: terminalAdapter(),
      adapterId: "fake",
      agentSessionId: "no-transcript",
    });
    const results: ApplyResult[] = [];
    try {
      await session.prompt("run it", { onRecord: (r) => results.push(r) });
      // The turn is over: nothing to replay, and `active` says so.
      expect(session.activitySnapshot()).toEqual({ active: false, seq: expect.any(Number), records: [] });
    } finally {
      await session.stop();
    }

    // `current` is full state on every call, and `seq` is strictly increasing across them.
    const seqs = results.flatMap((r) => (r.current ? [r.current.seq] : []));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    const live = new Map<string, AggregatedRecord>();
    for (const result of results) for (const frame of wireFrames(result)) foldFrame(live, frame);
    const call = live.get("call-1")!;
    expect((call.event as { status: string }).status).toBe("completed");
    expect((call.event as { rawInput: unknown }).rawInput).toEqual({
      command: "printf 'hello from terminal'",
    });
  });

  test("thinking streams to a live subscriber, and lands as ONE transcript line", async () => {
    // The regression this pins: `wireFrames` used to open a block with a delta, which
    // `foldFrame` drops for want of a base — so a browser client saw nothing until the
    // block closed and the settled record went out. Final state was right, which is
    // exactly why the round-trip tests missed it. Assert the intermediate states.
    const session = await AgentSession.create({
      adapter: terminalAdapter(),
      adapterId: "fake",
      agentSessionId: "thinking",
      transcriptDir: dir,
      transcriptActivity: true,
    });
    const live = new Map<string, AggregatedRecord>();
    const seen: string[] = [];
    try {
      await session.prompt("think, then run it", {
        onRecord: (result) => {
          for (const frame of wireFrames(result)) foldFrame(live, frame);
          const block = [...live.values()].find((r) => r.event.kind === "thinking");
          if (block) seen.push((block.event as { text: string }).text);
        },
      });
    } finally {
      await session.stop();
    }

    // Four chunks from the fixture, so the subscriber saw four growing prefixes.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).toBe("let ");
    expect(seen.at(-1)).toBe("let me check that");
    expect(seen.every((text, i) => i === 0 || text.startsWith(seen[i - 1]!))).toBe(true);

    // …and the file has one line for the block, not one per chunk.
    const thinking = (await activityLines(join(dir, "thinking.jsonl"))).filter(
      (l) => l.kind === "thinking",
    );
    expect(thinking).toHaveLength(1);
    expect(thinking[0]!.text).toBe("let me check that");
    expect(thinking[0]!.reason).toBe("settled");
  });

  test("a snapshot mid-turn replays the turn so far", async () => {
    const session = await AgentSession.create({
      adapter: terminalAdapter(),
      adapterId: "fake",
      agentSessionId: "mid-turn",
    });
    let mid: ActivitySnapshot | null = null;
    try {
      await session.prompt("run it", {
        onRecord: () => {
          mid ??= session.activitySnapshot();
        },
      });
    } finally {
      await session.stop();
    }

    // Taken on the first record, so the turn is in flight and the announced call is there.
    expect(mid?.active).toBe(true);
    expect(mid?.records.map((r) => r.recordId)).toEqual(["call-1"]);
    expect(mid!.seq).toBeGreaterThan(0);
  });

  test("each turn scopes its own minted record ids", async () => {
    const session = await AgentSession.create({
      adapter: terminalAdapter(),
      adapterId: "fake",
      agentSessionId: "two-turns",
      transcriptDir: dir,
      transcriptActivity: true,
    });
    try {
      await session.prompt("run it");
      await session.prompt("run it again");
    } finally {
      await session.stop();
    }

    // `usage` is a MINTED id, so without a per-turn prefix both turns would write
    // `recordId: "usage"` and folding a two-turn file would collapse them into one.
    const usage = (await activityLines(join(dir, "two-turns.jsonl"))).filter(
      (l) => l.kind === "usage",
    );
    expect(usage.length).toBe(2);
    expect(new Set(usage.map((l) => l.recordId)).size).toBe(2);
    for (const line of usage) expect(line.recordId).toMatch(/:usage$/);
  });

  test("activity stays inside the msg fences that delimit a turn", async () => {
    const session = await AgentSession.create({
      adapter: terminalAdapter(),
      adapterId: "fake",
      agentSessionId: "ordering",
      transcriptDir: dir,
      transcriptActivity: true,
    });
    try {
      await session.prompt("run it");
    } finally {
      await session.stop();
    }

    const shape = (await readTranscriptLines(join(dir, "ordering.jsonl")))
      .map((l) => (l.t === "msg" ? `msg:${l.role}` : l.t))
      .filter((t) => t !== "meta");
    expect(shape[0]).toBe("msg:user");
    expect(shape.at(-1)).toBe("msg:assistant");
    expect(shape.slice(1, -1).every((t) => t === "activity")).toBe(true);
  });

  async function runTerminalTurn(
    config: Partial<AgentSessionConfig>,
  ): Promise<string> {
    const session = await AgentSession.create({
      adapter: terminalAdapter(),
      adapterId: "fake",
      agentSessionId: "activity",
      transcriptDir: dir,
      ...config,
    });
    try {
      await session.prompt("run it");
    } finally {
      await session.stop();
    }
    return join(dir, "activity.jsonl");
  }

  async function activityLines(path: string): Promise<TranscriptActivityLine[]> {
    const lines = await readTranscriptLines(path);
    return lines.filter((l): l is TranscriptActivityLine => l.t === "activity");
  }
});

function terminalAdapter() {
  return { command: ["bun", resolve(import.meta.dir, "fixtures/terminal-agent.ts")] };
}

function fakeAdapter() {
  return {
    command: [
      "bun",
      resolve(import.meta.dir, "../smoke-tests/test1/transcript-smoke.ts"),
      "--fake-agent",
    ],
  };
}
