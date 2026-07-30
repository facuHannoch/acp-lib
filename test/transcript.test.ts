import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  describe("bounded tail read", () => {
    /** Enough lines, each big enough, that the tail spans many 64 KB chunks. */
    async function writeBulk(count: number, pad: number): Promise<void> {
      await mkdir(join(dir, "nested"), { recursive: true });
      const lines = [];
      for (let i = 1; i <= count; i++) {
        lines.push(
          JSON.stringify({ v: 1, t: "msg", role: "user", text: "x".repeat(pad), ts: i * 10 }),
        );
      }
      await appendFile(path, `${lines.join("\n")}\n`, "utf8");
    }

    test("equals the full read for any limit", async () => {
      await writeBulk(120, 900); // ~110 KB: at least two chunks
      const all = await readTranscriptLines(path);
      expect(all).toHaveLength(120);

      for (const limit of [0, 1, 2, 7, 119, 120, 500]) {
        const tail = await readTranscriptLines(path, { limit });
        expect(tail).toEqual(all.slice(Math.max(0, all.length - limit)));
      }
    });

    test("combines with the before cursor for pagination", async () => {
      await writeBulk(50, 2000); // ~100 KB
      const page1 = await readTranscriptLines(path, { limit: 10 });
      const page2 = await readTranscriptLines(path, { limit: 10, before: page1[0]!.ts });

      expect(page1.map((l) => l.ts)).toEqual([410, 420, 430, 440, 450, 460, 470, 480, 490, 500]);
      expect(page2.map((l) => l.ts)).toEqual([310, 320, 330, 340, 350, 360, 370, 380, 390, 400]);
    });

    test("a multi-byte character spanning a chunk boundary survives", async () => {
      await mkdir(join(dir, "nested"), { recursive: true });
      const text = `🙂${"é".repeat(1000)}`;

      // The read boundary is always 64 KB from EOF. Shim the LAST line one byte at a time
      // until that offset lands INSIDE a multi-byte character, so the test provably
      // exercises the case it names instead of hoping the padding happened to line up.
      let bytes = new Uint8Array(0);
      let shim = "";
      for (let attempt = 0; attempt < 8; attempt++) {
        const lines = [];
        for (let i = 1; i <= 40; i++) {
          const line: Record<string, unknown> = { v: 1, t: "msg", role: "user", text, ts: i * 10 };
          if (i === 40 && shim) line.shim = shim;
          lines.push(JSON.stringify(line));
        }
        await writeFile(path, `${lines.join("\n")}\n`, "utf8");
        bytes = new Uint8Array(await readFile(path));
        if ((bytes[bytes.length - 65536]! & 0xc0) === 0x80) break;
        shim += "-";
      }
      // A continuation byte at the boundary means a character is cut in half there.
      expect(bytes[bytes.length - 65536]! & 0xc0).toBe(0x80);

      const tail = await readTranscriptLines(path, { limit: 40 });
      expect(tail).toHaveLength(40);
      for (const line of tail) expect((line as { text: string }).text).toBe(text);
    });

    test("a single line longer than one chunk is read whole", async () => {
      await mkdir(join(dir, "nested"), { recursive: true });
      const huge = "z".repeat(200_000); // > 3 chunks in one line
      await appendFile(
        path,
        `${JSON.stringify({ v: 1, t: "msg", role: "user", text: huge, ts: 10 })}\n`,
        "utf8",
      );

      const tail = await readTranscriptLines(path, { limit: 1 });
      expect((tail[0] as { text: string }).text).toBe(huge);
    });

    test("a torn final line costs only that line", async () => {
      await writeBulk(5, 10);
      await appendFile(path, '{"v":1,"t":"msg","role":"user","te', "utf8");

      const tail = await readTranscriptLines(path, { limit: 3 });
      expect(tail.map((l) => l.ts)).toEqual([30, 40, 50]);
    });

    test("missing file reads as empty", async () => {
      expect(await readTranscriptLines(path, { limit: 5 })).toEqual([]);
    });
  });
});
