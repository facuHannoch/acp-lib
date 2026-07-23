import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTranscriptLine,
  readTranscript,
  readTranscriptLines,
} from "../src/transcript.ts";

describe("transcript", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "acp-transcript-"));
    path = join(dir, "nested", "chat.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("append and read message entries", async () => {
    await appendTranscriptLine(path, {
      v: 1,
      t: "msg",
      role: "user",
      text: "hello",
      ts: 100,
    });
    await appendTranscriptLine(path, {
      v: 1,
      t: "msg",
      role: "assistant",
      text: "hi",
      ts: 200,
      usage: { inputTokens: 1, outputTokens: 2 },
      stopReason: "end_turn",
      status: "completed",
    });

    expect(await readTranscript(path)).toEqual([
      { v: 1, t: "msg", role: "user", text: "hello", ts: 100 },
      {
        v: 1,
        t: "msg",
        role: "assistant",
        text: "hi",
        ts: 200,
        usage: { inputTokens: 1, outputTokens: 2 },
        stopReason: "end_turn",
        status: "completed",
      },
    ]);
  });

  test("message projection skips meta and keeps all recognized lines available", async () => {
    await appendTranscriptLine(path, {
      v: 1,
      t: "meta",
      event: "open",
      ts: 50,
      internalSessionId: "internal-1",
      adapter: "codex",
    });
    await appendTranscriptLine(path, {
      v: 1,
      t: "msg",
      role: "user",
      text: "hello",
      ts: 100,
    });

    expect(await readTranscript(path)).toEqual([
      { v: 1, t: "msg", role: "user", text: "hello", ts: 100 },
    ]);
    expect(await readTranscriptLines(path)).toHaveLength(2);
  });

  test("reader skips malformed and unknown lines", async () => {
    await mkdir(join(dir, "nested"), { recursive: true });
    await appendFile(
      path,
      [
        "{ nope",
        JSON.stringify({ v: 1, t: "unknown", ts: 100 }),
        JSON.stringify({ v: 1, t: "msg", role: "assistant", text: "ok", ts: 200 }),
        "",
      ].join("\n"),
      "utf8",
    );

    expect(await readTranscript(path)).toEqual([
      { v: 1, t: "msg", role: "assistant", text: "ok", ts: 200 },
    ]);
  });

  test("missing file reads as an empty transcript", async () => {
    expect(await readTranscript(path)).toEqual([]);
  });

  test("supports before cursor and newest limit", async () => {
    for (const ts of [100, 200, 300, 400]) {
      await appendTranscriptLine(path, {
        v: 1,
        t: "msg",
        role: "user",
        text: String(ts),
        ts,
      });
    }

    expect(await readTranscript(path, { before: 400, limit: 2 })).toEqual([
      { v: 1, t: "msg", role: "user", text: "200", ts: 200 },
      { v: 1, t: "msg", role: "user", text: "300", ts: 300 },
    ]);
  });
});
