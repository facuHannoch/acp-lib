import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTranscriptLine,
  readActivityRecords,
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

  describe("limit counts what you asked for", () => {
    /** A turn: user msg, some activity, assistant msg — the real interleaving. */
    async function writeTurns(count: number, activityPerTurn: number): Promise<void> {
      let ts = 0;
      for (let turn = 1; turn <= count; turn++) {
        await appendTranscriptLine(path, {
          v: 1,
          t: "msg",
          role: "user",
          text: `q${turn}`,
          ts: ++ts,
        });
        for (let i = 0; i < activityPerTurn; i++) {
          await appendTranscriptLine(path, {
            v: 1,
            t: "activity",
            ts: ++ts,
            kind: "tool",
            recordId: `t${turn}-${i}`,
            reason: "settled",
          });
        }
        await appendTranscriptLine(path, {
          v: 1,
          t: "msg",
          role: "assistant",
          text: `a${turn}`,
          ts: ++ts,
        });
      }
    }

    test("readTranscript's limit is MESSAGES, not lines", async () => {
      // The regression. `TranscriptEntry` is a message, and `limit` says "at most this
      // many entries" — but it used to count lines, so activity in between ate the budget
      // and you got a fraction of what you asked for.
      await writeTurns(5, 8); // 50 lines, 10 messages
      expect(await readTranscriptLines(path)).toHaveLength(50);

      for (const limit of [1, 2, 4, 10]) {
        const msgs = await readTranscript(path, { limit });
        expect(msgs).toHaveLength(limit);
        expect(msgs.every((m) => m.t === "msg")).toBe(true);
      }
      // Asking for more than exists still returns everything, never an error.
      expect(await readTranscript(path, { limit: 99 })).toHaveLength(10);
    });

    test("readTranscript keeps the NEWEST messages, in order", async () => {
      await writeTurns(3, 4);
      expect((await readTranscript(path, { limit: 3 })).map((m) => m.text)).toEqual([
        "a2",
        "q3",
        "a3",
      ]);
    });

    test("types narrows what the budget is spent on", async () => {
      await writeTurns(4, 5); // 28 lines: 8 msg, 20 activity
      expect(await readTranscriptLines(path, { types: ["msg"] })).toHaveLength(8);
      expect(await readTranscriptLines(path, { types: ["activity"] })).toHaveLength(20);
      expect(await readTranscriptLines(path, { types: ["msg", "activity"] })).toHaveLength(28);

      // The interleaved chat view: ten things a renderer would actually draw.
      const page = await readTranscriptLines(path, { types: ["msg", "activity"], limit: 10 });
      expect(page).toHaveLength(10);
      expect(page.map((l) => l.ts)).toEqual([...page.map((l) => l.ts)].sort((a, b) => a - b));
    });

    test("meta and raw lines never consume the budget", async () => {
      await appendTranscriptLine(path, { v: 1, t: "meta", event: "open", ts: 1 });
      await appendTranscriptLine(path, {
        v: 1,
        t: "raw",
        ts: 2,
        protocol: "acp",
        event: "x",
        data: {},
      });
      await appendTranscriptLine(path, { v: 1, t: "msg", role: "user", text: "hi", ts: 3 });

      expect(await readTranscript(path, { limit: 1 })).toHaveLength(1);
      // Without a filter they are still returned — `types` is opt-in, not a new default.
      expect(await readTranscriptLines(path, { limit: 3 })).toHaveLength(3);
    });

    test("readActivityRecords' limit is activity lines", async () => {
      await writeTurns(3, 4);
      const all = await readActivityRecords(path);
      expect(all.size).toBe(12);
      expect((await readActivityRecords(path, { limit: 5 })).size).toBe(5);
    });

    test("tail and full read agree once types is applied", async () => {
      await writeTurns(6, 7);
      for (const types of [["msg"], ["activity"], ["msg", "activity"]] as const) {
        const full = await readTranscriptLines(path, { types: [...types] });
        for (const limit of [0, 1, 3, 20, 200]) {
          const tail = await readTranscriptLines(path, { types: [...types], limit });
          expect(tail).toEqual(full.slice(Math.max(0, full.length - limit)));
        }
      }
    });

    test("before + limit paginates messages without gaps or repeats", async () => {
      await writeTurns(6, 5); // 12 messages
      const seen: string[] = [];
      let before: number | undefined;
      for (let page = 0; page < 4; page++) {
        const msgs = await readTranscript(path, { limit: 3, before });
        if (msgs.length === 0) break;
        seen.unshift(...msgs.map((m) => m.text));
        before = msgs[0]!.ts;
      }
      // Every message exactly once, oldest-first, nothing dropped between pages.
      expect(seen).toEqual(["q1", "a1", "q2", "a2", "q3", "a3", "q4", "a4", "q5", "a5", "q6", "a6"]);
    });

    test("scans past a long activity run to find its messages", async () => {
      // The cost the contract warns about: 20 messages can span thousands of activity
      // lines. It has to keep reading rather than stop at a chunk boundary.
      await writeTurns(2, 3000); // ~6000 activity lines, well past several 64 KB chunks
      const msgs = await readTranscript(path, { limit: 4 });
      expect(msgs.map((m) => m.text)).toEqual(["q1", "a1", "q2", "a2"]);
    });
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
