import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession } from "../src/agent-session.ts";
import { createWireLog } from "../src/wire-log.ts";
import type { WireEntry } from "../src/types.ts";

describe("wire log", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "acp-wire-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function runTurn(wire: (entry: WireEntry) => void): Promise<void> {
    const session = await AgentSession.create({
      adapter: { command: ["bun", resolve(import.meta.dir, "fixtures/terminal-agent.ts")] },
      adapterId: "fake",
      agentSessionId: "wire",
      wire,
    });
    try {
      await session.prompt("run it");
    } finally {
      await session.stop();
    }
  }

  test("captures both directions, verbatim", async () => {
    const entries: WireEntry[] = [];
    await runTurn((e) => entries.push(e));

    const out = entries.filter((e) => e.dir === "out").map((e) => JSON.parse(e.line));
    const inbound = entries.filter((e) => e.dir === "in").map((e) => JSON.parse(e.line));

    // What we asked for.
    expect(out.map((m) => m.method)).toEqual(
      expect.arrayContaining(["initialize", "session/new", "session/prompt"]),
    );
    // What came back — including the notifications the transport takes off the wire
    // itself, which is the whole reason this exists: they never reach the SDK, so no
    // other hook can see them.
    expect(inbound.filter((m) => m.method === "session/update").length).toBeGreaterThan(0);
    // And our own answers to the agent's terminal/* requests.
    expect(out.some((m) => m.result?.terminalId)).toBe(true);

    // Verbatim: every line is exactly what JSON.parse round-trips, no re-indentation.
    for (const entry of entries) {
      if (entry.dir === "err") continue;
      expect(entry.line).not.toContain("\n");
      expect(entry.ts).toBeGreaterThan(0);
    }
  });

  test("interleaving reflects the real request/response order", async () => {
    const entries: WireEntry[] = [];
    await runTurn((e) => entries.push(e));

    const order = entries
      .filter((e) => e.dir !== "err")
      .map((e) => {
        const m = JSON.parse(e.line);
        return `${e.dir}:${m.method ?? (m.error ? "error" : "result")}`;
      });

    // initialize must be answered before session/new goes out — this is the sequence a
    // reader of the log needs to trust.
    expect(order.indexOf("in:result")).toBeGreaterThan(order.indexOf("out:initialize"));
    expect(order.indexOf("out:session/new")).toBeGreaterThan(order.indexOf("in:result"));
  });

  test("writes ndjson to a file, one entry per line", async () => {
    const path = join(dir, "nested", "wire.jsonl");
    const sink = createWireLog({ path });
    await runTurn(sink);

    // The sink chains its writes; give the tail of the chain a turn to land.
    await Bun.sleep(50);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines.length).toBeGreaterThan(5);

    const parsed = lines.map((l) => JSON.parse(l) as WireEntry);
    expect(new Set(parsed.map((e) => e.dir)).size).toBeGreaterThan(1);
    // Every entry's `line` is itself valid JSON — the log is nested ndjson, not mangled.
    for (const entry of parsed) {
      if (entry.dir !== "err") expect(() => JSON.parse(entry.line)).not.toThrow();
    }
  });

  test("a fresh run truncates the file rather than appending to the last one", async () => {
    const path = join(dir, "wire.jsonl");
    await runTurn(createWireLog({ path }));
    await Bun.sleep(50);
    const first = (await readFile(path, "utf8")).trim().split("\n").length;

    await runTurn(createWireLog({ path }));
    await Bun.sleep(50);
    const second = (await readFile(path, "utf8")).trim().split("\n").length;

    // Two runs of the same size: if it appended, the second read would be ~double.
    expect(second).toBeLessThan(first * 2);
  });

  test("maxLineBytes clips a long line and says how much it dropped", async () => {
    const seen: string[] = [];
    const sink = createWireLog({ path: join(dir, "clipped.jsonl"), maxLineBytes: 40 });
    await runTurn((entry) => {
      sink(entry);
      seen.push(entry.line);
    });
    await Bun.sleep(50);

    const lines = (await readFile(join(dir, "clipped.jsonl"), "utf8")).trim().split("\n");
    const clipped = lines.map((l) => (JSON.parse(l) as WireEntry).line);
    expect(clipped.some((l) => /… \[\+\d+B\]$/.test(l))).toBe(true);
    // The tap itself is never lossy — clipping is the sink's policy.
    expect(seen.some((l) => l.length > 40)).toBe(true);
    for (const line of clipped) expect(line.length).toBeLessThan(80);
  });

  test("no wire handler means no overhead and no behaviour change", async () => {
    const session = await AgentSession.create({
      adapter: { command: ["bun", resolve(import.meta.dir, "fixtures/terminal-agent.ts")] },
      adapterId: "fake",
      agentSessionId: "no-wire",
    });
    try {
      const result = await session.prompt("run it");
      expect(result.status).toBe("completed");
      expect(result.text).toBe("done");
    } finally {
      await session.stop();
    }
  });
});
