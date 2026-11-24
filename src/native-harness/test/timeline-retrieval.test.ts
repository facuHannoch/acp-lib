import { expect, spyOn, test } from "bun:test";
import { CONTEXT_LIMITS } from "../src/capabilities/context/session.ts";
import { Database } from "bun:sqlite";
import { createSession } from "../src/index.ts";
import type { ManagedConfig } from "../src/contracts/config-permissions.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";
import type { StorageResult } from "../src/contracts/storage.ts";

const value = <T>(result: StorageResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const identity = { sessionId: "retrieval", compatibilityKey: "test" };
for (const kind of ["memory", "sqlite"] as const) {
  test(`${kind}: timeline search ranks, validates casing, and reads a frozen window`, () => {
    const directory = mkdtempSync(join(tmpdir(), "timeline-retrieval-"));
    const open = (name: string) => kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(directory, name));
    const adapter = open("a.db");
    let storage = value(adapter.open({ mode: "create", identity }));
    function append(id: string, text: string, reply: string, channel = "alpha") {
      value(storage.acceptItem({ itemId: id, channelId: channel, text, kind: "participant_message", senderId: "Rin" }));
      const { turn } = value(storage.beginTurn(channel))!;
      const entry = value(storage.appendMessage(turn.turnId, { role: "assistant", content: reply, calls: [] }));
      value(storage.finishTurn(turn.turnId, { status: "completed" }));
      return entry;
    }
    try {
      append("first", "TODO, cafe\u0301 東京 red red blue", "a a a");
      append("second", "todo cafe red blue blue blue", "a a");
      append("variant", "TODOS cafe red blue", "another reply", "beta");
      expect(value(storage.searchTimeline({ query: "TODO", case_sensitive: true })).hits.map(hit => hit.message_id)).toEqual(["item:first"]);
      expect(value(storage.searchTimeline({ query: "café 東京" })).hits.map(hit => hit.message_id)).toEqual(["item:first"]);
      expect(value(storage.searchTimeline({ query: "red blue" })).hits.map(hit => hit.message_id))
        .toEqual(["item:second", "item:first", "item:variant"]);
      expect(value(storage.searchTimeline({ query: "a a", match: "phrase" })).hits.map(hit => hit.excerpt)).toEqual(["a a a", "a a"]);
      expect(value(storage.searchTimeline({ query: "red", channel: "beta" })).hits.map(hit => hit.message_id)).toEqual(["item:variant"]);
      expect(value(storage.searchTimeline({ query: "absent" })).hits).toEqual([]);
      expect(storage.searchTimeline({ query: "!!!" }).ok).toBe(false);
      const long = "🙂".repeat(12000);
      const entry = append("long", "before", long);
      let page = value(storage.readMessage({ message_id: String(entry.seq), before: 1, after: 1 }));
      const revision = page.revision;
      append("future", "must stay outside window", "future");
      const messages = [...page.messages];
      while (page.next) {
        page = value(storage.readMessage({ message_id: String(entry.seq), cursor: page.next }));
        expect(page.revision).toBe(revision);
        messages.push(...page.messages);
      }
      expect(messages.filter(row => row.message_id === String(entry.seq)).map(row => row.text).join("")).toBe(long);
      expect(messages.map(row => row.message_id)).toContain("item:long");
      expect(messages.every(row => row.channel === "alpha" && row.message_id !== "item:future")).toBe(true);

      const exactBudget = "needle " + " ".repeat(2 * 1024 * 1024 - 7);
      append("budget", "budget item", exactBudget);
      expect(value(storage.searchTimeline({ query: "needle" }))).toMatchObject({ partial: false, hits: [{ channel: "alpha" }] });
      append("oversized", "over budget", exactBudget + " ");
      expect(value(storage.searchTimeline({ query: "needle" }))).toEqual({ hits: [], partial: true });

      const archive = value(storage.exportArchive());
      value(storage.close());
      storage = value(adapter.open({ mode: "open", identity }));
      expect(value(storage.readMessage({ message_id: "item:first" })).messages[0]!.sender).toBe("Rin");
      const restored = open("b.db");
      value(restored.importArchive(archive));
      const copy = value(restored.open({ mode: "open", identity }));
      try {
        expect(value(copy.searchTimeline({ query: "café" })).hits.map(hit => hit.message_id)).toEqual(["item:first"]);
      } finally { copy.close(); }
    } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
}

test("SQLite finds a message by point and bounds latest-first candidate verification over 10,000 entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "long-timeline-"));
  const path = join(dir, "s.db"), adapter = createSqliteStorageAdapter(path);
  let storage = value(adapter.open({ mode: "create", identity }));
  try {
    value(storage.acceptItem({ itemId: "target", channelId: "alpha", senderId: "Rin", kind: "participant_message", text: "TODO" }));
    const { turn } = value(storage.beginTurn("alpha"))!;
    value(storage.appendMessage(turn.turnId, { role: "assistant", content: "seed reply", calls: [] }));
    value(storage.finishTurn(turn.turnId, { status: "completed" }));
    value(storage.close());
    {
      using db = new Database(path);
      db.exec(`WITH RECURSIVE nums(n) AS (SELECT 100 UNION ALL SELECT n + 1 FROM nums WHERE n < 10099)
        INSERT INTO entries(seq, at, channel_id, turn_id, sender, message)
        SELECT n, 'time', 'alpha', 1, 'assistant', '{"role":"assistant","content":"todo","calls":[]}' FROM nums;
        UPDATE meta SET value = '10099' WHERE key = 'revision';`);
    }
    storage = value(adapter.open({ mode: "open", identity }));
    const snapshot = spyOn(storage, "snapshot").mockImplementation(() => { throw new Error("Unexpected snapshot"); });
    const sql: string[] = [], plans: string[] = [];
    const original = Database.prototype.query;
    const queries = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, statement: string) {
      sql.push(statement);
      if (statement.includes("FROM timeline_retrieval_v1 WHERE")) {
        const explain = this.prepare("EXPLAIN QUERY PLAN " + statement);
        try { plans.push(JSON.stringify(explain.all("x746f646f", 1001))); }
        finally { explain.finalize(); }
      }
      return original.call(this, statement);
    } as typeof Database.prototype.query);
    try {
      expect(value(storage.searchTimeline({ query: "TODO", case_sensitive: true }))).toEqual({ hits: [], partial: true });
      const page = value(storage.searchTimeline({ query: "TODO" }));
      expect(page.hits[0]?.seq).toBe(10099);
      expect(page.hits).toHaveLength(20);
      expect(value(storage.readMessage({ message_id: "item:target" })).messages[0]).toMatchObject({ text: "TODO", sender: "Rin" });
      expect(plans[0]).toContain("VIRTUAL TABLE INDEX");
      expect(plans[0]).not.toContain("TEMP B-TREE");
      expect(sql.some(statement => /FROM entries AS e WHERE e.seq = \?/.test(statement))).toBe(true);
      expect(snapshot).not.toHaveBeenCalled();
    } finally { queries.mockRestore(); snapshot.mockRestore(); }
  } finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

for (const [enabled, rule, query, expected] of [
  [false, "ask", "word", "tool_unavailable"],
  [true, "ask", "!!!", "invalid_arguments"],
  [true, "deny", "word", "policy_denied"],
] as const) test(`checked retrieval rejects ${expected} before approval and execution`, async () => {
  const config: ManagedConfig = { version: 1, system: "Test", model: { protocol: "scripted", script: "test" },
    defaultPolicy: "policy", policies: { policy: { fallback: rule, tools: {} } }, timelineTools: enabled };
  const storage = value(createMemoryStorageAdapter().open({ mode: "create", identity, config }));
  const search = spyOn(storage, "searchTimeline");
  let modelCalls = 0, approvals = 0;
  const session = createSession({ storage, config, systemPrompt: config.system, configureTurn: () => ({
    tools: [], executeTool: async () => { throw new Error("Unexpected executor"); },
    model: async () => ++modelCalls === 1
      ? { role: "assistant", content: null, calls: [{ id: "lookup", name: "search_timeline", arguments: JSON.stringify({ query }) }] }
      : { role: "assistant", content: "Done", calls: [] },
  }) });
  const ended = new Promise<void>(resolve => session.subscribe(({ event }) => {
    if (event.type === "approval_requested") approvals++;
    if (event.type === "turn_ended") resolve();
  }));
  try {
    session.start();
    expect(session.agent.send({ channelId: "alpha", participantId: "Rin", text: "word" }).accepted).toBe(true);
    await ended;
    const results = value(storage.snapshot()).timeline.flatMap(entry => entry.message.role === "tool" ? [entry.message] : []);
    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toMatchObject({ status: "skipped", code: expected });
    expect(approvals).toBe(0);
    expect(search).not.toHaveBeenCalled();
  } finally { session.stop("test finished"); storage.close(); }
});

test("retrieval cancellation before dispatch performs no read and stores one paired result", async () => {
  const config: ManagedConfig = { version: 1, system: "Test", model: { protocol: "scripted", script: "test" },
    defaultPolicy: "ask", policies: { ask: { fallback: "ask", tools: {} } }, timelineTools: true };
  const storage = value(createMemoryStorageAdapter().open({ mode: "create", identity, config }));
  const search = spyOn(storage, "searchTimeline");
  const session = createSession({
    storage, config, systemPrompt: config.system,
    configureTurn: () => ({
      tools: [], executeTool: async () => { throw new Error("Unexpected executor"); },
      model: async () => ({ role: "assistant", content: null, calls: [{ id: "lookup", name: "search_timeline", arguments: '{"query":"word"}' }] }),
    }),
  });
  session.approvals.setConsumer(true);
  const ended = new Promise<void>(resolve => session.subscribe(({ event }) => {
    if (event.type === "approval_requested") queueMicrotask(() => session.channels.interrupt("alpha", 1));
    if (event.type === "turn_ended") resolve();
  }));
  try {
    session.start();
    session.agent.send({ channelId: "alpha", participantId: "Rin", text: "word" });
    await ended;
    expect(search).not.toHaveBeenCalled();
    const results = value(storage.snapshot()).timeline.flatMap(entry => entry.message.role === "tool" ? [entry.message] : []);
    expect(results).toHaveLength(1);
    expect(results[0]?.callId).toBe("lookup");
  } finally { session.stop("test finished"); storage.close(); }
});

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: mixed historical messages retain text and unrelated calls`, () => {
  const dir = mkdtempSync(join(tmpdir(), "mixed-retrieval-"));
  const adapter = kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(dir, "s.db"));
  const storage = value(adapter.open({ mode: "create", identity }));
  try {
    const take = (id: string, channelId = "alpha") => {
      value(storage.acceptItem({ itemId: id, channelId, kind: "participant_message", senderId: "Rin", text: "message" }));
      return value(storage.beginTurn(channelId))!.turn.turnId;
    };
    const original = take("original");
    value(storage.appendMessage(original, { role: "assistant", content: "Text survives", calls: [
      { id: "discarded", name: "search_timeline", arguments: "{}" },
      { id: "kept", name: "echo", arguments: "{}" },
    ] }));
    value(storage.appendMessage(original, { role: "tool", callId: "discarded", content: "Retrieved material" }));
    value(storage.appendMessage(original, { role: "tool", callId: "kept", content: "Other output" }));
    const active = value(storage.readInferenceContext({ channelId: "alpha", turnId: original, limits: CONTEXT_LIMITS }));
    expect(JSON.stringify(active)).toContain("Retrieved material");
    value(storage.appendMessage(original, { role: "assistant", content: "Final", calls: [] }));
    value(storage.finishTurn(original, { status: "completed" }));
    const next = take("next", "beta");
    const historical = JSON.stringify(value(storage.readInferenceContext({ channelId: "beta", turnId: next,
      limits: { ...CONTEXT_LIMITS, maxSharedCandidates: 4 } })));
    expect(historical).toContain("Text survives");
    expect(historical).toContain("kept");
    expect(historical).not.toContain("discarded");
    expect(historical).not.toContain("Retrieved material");
    expect(JSON.stringify(value(storage.snapshot()).timeline)).toContain("Retrieved material");
  } finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
});
