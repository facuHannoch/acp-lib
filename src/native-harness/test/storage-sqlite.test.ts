import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";
import { storageConformance } from "./conformance/storage.ts";
import { FORMAT2_SCHEMA } from "./fixtures/format2-schema.ts";

const dir = mkdtempSync(join(tmpdir(), "harness-storage-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(dir, `session-${++n}.sqlite`);
const identity = { sessionId: "s1", compatibilityKey: "k1" };

storageConformance("sqlite", () => createSqliteStorageAdapter(fresh()));

async function owner(path: string, mode = "running") {
  const child = Bun.spawn(["bun", new URL("./fixtures/storage-owner.ts", import.meta.url).pathname, path, mode], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  let out = "";
  while (!out.includes("\n")) { const { value, done } = await reader.read(); if (done) break; out += new TextDecoder().decode(value); }
  expect(out.trim()).toBe("ready");
  return child;
}

test("a live owner in another process excludes this one; its death releases the session", async () => {
  const path = fresh(), adapter = createSqliteStorageAdapter(path);
  const child = await owner(path);
  const refused = adapter.open({ mode: "open", identity });
  expect(refused.ok ? "ok" : refused.error.code).toBe("owner_conflict");
  const create = adapter.open({ mode: "create", identity });
  expect(create.ok ? "ok" : create.error.code).toBe("already_exists");
  child.kill("SIGKILL"); await child.exited;
  expect(adapter.open({ mode: "open", identity }).ok).toBe(true);
});

for (const mode of ["running", "suspending"]) {
  test(`SIGKILL while ${mode}: taken input stays on an interrupted turn, untaken input stays pending, nothing replays`, async () => {
    const path = fresh();
    const child = await owner(path, mode);
    child.kill("SIGKILL"); await child.exited;
    const opened = createSqliteStorageAdapter(path).open({ mode: "open", identity });
    if (!opened.ok) throw new Error(opened.error.message);
    const s = opened.value, view = s.snapshot();
    if (!view.ok) throw new Error(view.error.message);
    expect(view.value.session.lifecycle).toBe("running");
    expect(view.value.turns).toHaveLength(1);
    expect(view.value.turns[0]).toMatchObject({ turnId: 1, itemIds: ["taken"], state: { status: "interrupted", uncertainCallIds: ["effect"] } });
    expect(view.value.items.map(item => [item.itemId, item.milestone, item.turnId])).toEqual([["taken", "taken", 1], ["pending", "received", undefined]]);
    expect(view.value.timeline.map(entry => entry.message.role)).toEqual(["user", "assistant", "tool"]);
    // Retries after the crash resolve to the original records, and the channel runs new work.
    const retry = s.acceptItem({ itemId: "taken", kind: "participant_message", channelId: "c1", senderId: "ana", text: "run the tool" });
    expect(retry.ok && retry.value).toMatchObject({ duplicate: true, item: { milestone: "taken", turnId: 1 } });
    const late = s.appendMessage(1, { role: "tool", callId: "effect", content: "late" });
    expect(late.ok ? "ok" : late.error.code).toBe("invalid_state");
    const next = s.beginTurn("c1");
    expect(next.ok && next.value?.turn).toMatchObject({ turnId: 2, itemIds: ["pending"] });
    s.close();
  });
}

test("unreadable or unsupported files are refused without being modified", () => {
  const junk = fresh();
  writeFileSync(junk, "this is not a database ".repeat(200));
  const foreign = fresh();
  { const db = new Database(foreign); db.exec("CREATE TABLE notes (body TEXT)"); db.close(); }
  const future = fresh();
  { const first = createSqliteStorageAdapter(future).open({ mode: "create", identity }); if (first.ok) first.value.close(); }
  { const db = new Database(future); db.exec("UPDATE meta SET value = '7' WHERE key = 'formatVersion'"); db.close(); }
  for (const path of [junk, foreign, future]) {
    const before = readFileSync(path);
    const adapter = createSqliteStorageAdapter(path);
    const opened = adapter.open({ mode: "open", identity });
    expect(opened.ok ? "ok" : opened.error.code).toBe("incompatible");
    const created = adapter.open({ mode: "create", identity });
    expect(created.ok ? "ok" : created.error.code).toBe("already_exists");
    const imported = adapter.importArchive({} as never);
    expect(imported.ok ? "ok" : imported.error.code).toBe("invalid_archive");
    expect(readFileSync(path).equals(before)).toBe(true);
  }
});

test("failed creates and imports leave no stray files; a refused open releases nothing it did not own", () => {
  const before = readdirSync(dir).length;
  const path = fresh(), adapter = createSqliteStorageAdapter(path);
  expect(adapter.importArchive({ format: "harness-session" } as never).ok).toBe(false);
  expect(adapter.open({ mode: "open", identity }).ok).toBe(false);
  expect(readdirSync(dir).length).toBe(before);
  const opened = adapter.open({ mode: "create", identity });
  if (!opened.ok) throw new Error(opened.error.message);
  // Only the database itself remains: no draft and no leftover journal.
  expect(readdirSync(dir).filter(name => name.startsWith(`session-${n}.`))).toEqual([`session-${n}.sqlite`]);
  expect(adapter.open({ mode: "open", identity }).ok).toBe(false);
  // The failed second open did not disturb the first owner.
  expect(opened.value.acceptItem({ kind: "participant_message", channelId: "c1", senderId: "ana", text: "still mine" }).ok).toBe(true);
  opened.value.close();
});

test("a constraint the engine did not anticipate rolls the whole operation back", () => {
  const path = fresh(), adapter = createSqliteStorageAdapter(path);
  const opened = adapter.open({ mode: "create", identity });
  if (!opened.ok) throw new Error(opened.error.message);
  const s = opened.value;
  s.acceptItem({ itemId: "a", kind: "participant_message", channelId: "c1", senderId: "ana", text: "a" });
  s.acceptItem({ itemId: "b", kind: "participant_message", channelId: "c1", senderId: "ana", text: "b" });
  s.close();
  // Make the second item of the take violate a schema check after the turn and first item were written.
  { const db = new Database(path); db.exec("CREATE TRIGGER break_take BEFORE UPDATE ON items WHEN new.item_id = 'b' BEGIN SELECT RAISE(ABORT, 'injected'); END"); db.close(); }
  const again = adapter.open({ mode: "open", identity });
  if (!again.ok) throw new Error(again.error.message);
  const before = JSON.stringify(again.value.snapshot());
  const failed = again.value.beginTurn("c1");
  expect(failed.ok ? "ok" : failed.error.code).toBe("storage_failure");
  expect(JSON.stringify(again.value.snapshot())).toBe(before);
  again.value.close();
});

/** A database as the persistence revision wrote it: format 2, no channel state.
 * Channel `c1` has a taken item and a turn in the given state; `c2` has one
 * pending item. Rows follow the old engine's layout exactly. */
function format2(path: string, lifecycle: "running" | "suspended", turn: "running" | "suspended") {
  const db = new Database(path, { create: true, readwrite: true });
  db.exec(FORMAT2_SCHEMA);
  const meta = { sessionId: "s1", formatVersion: "2", createdAt: "2026-11-01T00:00:00.000Z", compatibilityKey: "k1", lifecycle,
    revision: "5", nextTurnId: "2", nextItemNumber: "3" };
  for (const [key, value] of Object.entries(meta)) db.query("INSERT INTO meta VALUES (?, ?)").run(key, value);
  db.exec(`INSERT INTO channels VALUES ('c1', 0), ('c2', 1); INSERT INTO participants VALUES ('ana', 0)`);
  const state = turn === "running" ? { status: "running" } : { status: "suspended", checkpoint: { nextStep: "inference", afterSeq: 3 } };
  db.query("INSERT INTO turns VALUES (1, 'c1', 2, 't', 'k1', ?, ?)").run(turn, JSON.stringify(state));
  db.query("INSERT INTO entries VALUES (3, 't', 'c1', 1, 'ana', 'participant_message', NULL, 'i1', ?)")
    .run(JSON.stringify({ role: "user", content: 'Participant: "ana"\n\nhello' }));
  const sig = (id: string, channel: string, text: string) => new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(["participant_message", channel, "ana", null, text])).digest("hex");
  db.query("INSERT INTO items VALUES ('i1', 'participant_message', 'c1', 'ana', NULL, 'hello', ?, 1, 't', 'taken', 1, 3)").run(sig("i1", "c1", "hello"));
  db.query("INSERT INTO items VALUES ('i2', 'participant_message', 'c2', 'ana', NULL, 'waiting', ?, 4, 't', 'received', NULL, NULL)").run(sig("i2", "c2", "waiting"));
  db.close();
}
const rawFormat = (path: string) => { const db = new Database(path); const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'formatVersion'").get(); db.close(); return row!.value; };
const must = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

test("a format 2 database with a session-wide suspension opens, upgrades once and resumes as before", () => {
  const path = fresh(); format2(path, "suspended", "suspended");
  const adapter = createSqliteStorageAdapter(path);
  const s = must(adapter.open({ mode: "open", identity }));
  const view = must(s.snapshot());
  expect(view.session).toMatchObject({ formatVersion: 6, lifecycle: "suspended" });
  expect(view.channels).toEqual([{ channelId: "c1", lifecycle: "open", participantIds: ["ana"] }, { channelId: "c2", lifecycle: "open", participantIds: [] }]);
  expect(view.turns[0]!.state.status).toBe("suspended"); // untouched by the upgrade
  expect(view.items.map(item => [item.itemId, item.milestone])).toEqual([["i1", "taken"], ["i2", "received"]]);
  expect(must(s.resume()).turns.map(turn => turn.turnId)).toEqual([1]);
  // New records work on upgraded tables, including the rebuilt items constraints.
  expect(must(s.withdrawItem("c2", "i2")).outcome).toBe("withdrawn");
  expect(must(s.beginChannelSuspend("c2")).lifecycle).toBe("suspended");
  s.close();
  expect(rawFormat(path)).toBe("6"); // upgraded durably, readable only by this revision from now on
  const again = must(adapter.open({ mode: "open", identity }));
  expect(must(again.snapshot()).items.find(item => item.itemId === "i2")!.milestone).toBe("withdrawn");
  again.close();
});

test("a format 2 database that was not cleanly suspended is recovered as before the upgrade", () => {
  const path = fresh(); format2(path, "running", "running");
  const s = must(createSqliteStorageAdapter(path).open({ mode: "open", identity }));
  const view = must(s.snapshot());
  expect(view.turns[0]!.state).toMatchObject({ status: "interrupted" });
  expect(view.channels.every(channel => channel.lifecycle === "open")).toBe(true);
  expect(view.items.find(item => item.itemId === "i2")!.milestone).toBe("received");
  expect(must(s.acceptItem({ kind: "participant_message", channelId: "c1", senderId: "ana", text: "next" })).duplicate).toBe(false);
  s.close();
});

test("a failed upgrade leaves the format 2 file untouched", () => {
  const path = fresh(); format2(path, "suspended", "suspended");
  { const db = new Database(path); db.exec("CREATE TABLE items_v2 (x)"); db.close(); } // makes the rebuild fail midway
  const before = readFileSync(path);
  const opened = createSqliteStorageAdapter(path).open({ mode: "open", identity });
  expect(opened.ok).toBe(false);
  expect(readFileSync(path).equals(before)).toBe(true);
  expect(rawFormat(path)).toBe("2");
});

test("a retired channel that still holds a checkpoint is left alone by session resume", () => {
  const path = fresh(), adapter = createSqliteStorageAdapter(path);
  const s = must(adapter.open({ mode: "create", identity }));
  s.acceptItem({ kind: "participant_message", channelId: "c1", senderId: "ana", text: "a", itemId: "a" });
  s.acceptItem({ kind: "participant_message", channelId: "c2", senderId: "ana", text: "b", itemId: "b" });
  const t1 = must(s.beginTurn("c1"))!.turn.turnId, t2 = must(s.beginTurn("c2"))!.turn.turnId;
  must(s.beginSuspend()); must(s.checkpointTurn(t1)); must(s.checkpointTurn(t2)); must(s.completeSuspend());
  s.close();
  // Only reachable through damaged data: the API never retires a channel with a checkpoint.
  { const db = new Database(path); db.exec("UPDATE channels SET lifecycle = 'retired' WHERE channel_id = 'c1'"); db.close(); }
  const again = must(adapter.open({ mode: "open", identity: { ...identity, compatibilityKey: "k1" } }));
  const resumed = must(again.resume());
  expect(resumed.turns.map(turn => turn.turnId)).toEqual([t2]); // the retired channel's turn never runs
  const view = must(again.snapshot());
  expect(view.turns.find(turn => turn.turnId === t1)!.state.status).toBe("suspended");
  expect(view.session.lifecycle).toBe("running");
  // And it does not block resume under another configuration either, so long as it is the only one.
  again.close();
});

test("focused SQLite reads use bounded ranges and skip the model history blob", () => {
  const path = fresh(), adapter = createSqliteStorageAdapter(path);
  const created = adapter.open({ mode: "create", identity });
  if (!created.ok) throw new Error(created.error.message);
  const s = created.value;
  expect(s.acceptItem({ itemId: "a", kind: "participant_message", channelId: "c1", senderId: "ana", text: "hello" }).ok).toBe(true);
  const begun = s.beginTurn("c1");
  if (!begun.ok || !begun.value) throw new Error("No turn");
  const turn = begun.value.turn.turnId;
  const reply = s.appendMessage(turn, { role: "assistant", content: "answer", calls: [] });
  if (!reply.ok) throw new Error(reply.error.message);
  expect(s.finishTurn(turn, { status: "completed" }).ok).toBe(true);
  expect(s.close().ok).toBe(true);

  const db = new Database(path);
  const history = JSON.stringify({ nextCall: 10_001, calls: Array.from({ length: 10_000 }, (_, i) => ({
    callId: String(i + 1), outcome: "succeeded",
  })), itemIds: {}, scriptPositions: {}, entryIds: { [reply.value.seq]: "reserved-reply" } });
  // Simulate a write by a prior revision, which updates the blob alone.
  db.run("INSERT OR REPLACE INTO meta VALUES ('modelState', ?)", [history]);
  db.close();
  const migrated = adapter.open({ mode: "open", identity });
  if (!migrated.ok) throw new Error(migrated.error.message);
  expect(migrated.value.close().ok).toBe(true);

  const plans: string[][] = [];
  const prepare = Database.prototype.prepare;
  const rangeStatements = spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database, sql: string) {
    if (sql.includes("AS reply_id FROM entries")) {
      const explain = prepare.call(this, "EXPLAIN QUERY PLAN " + sql);
      const parameters = sql.includes("turn_id = ?") ? [turn, "c1"] : sql.includes("channel_id = ?") ? ["c1"] : [];
      try { plans.push(explain.all(...parameters, 100, 101, 51).map(row => String((row as {detail: string}).detail))); }
      finally { explain.finalize(); }
    }
    return prepare.call(this, sql);
  } as typeof Database.prototype.prepare);
  const queries = spyOn(Database.prototype, "query");
  try {
    const opened = adapter.open({ mode: "open", identity });
    if (!opened.ok) throw new Error(opened.error.message);
    const read = opened.value;
    try {
      expect(read.readSession().ok).toBe(true);
      expect(read.readChannel("c1").ok).toBe(true);
      expect(read.readTracked("c1", [], [turn]).ok).toBe(true);
      const bounds = { direction: "older" as const, throughRevision: opened.revision, limit: 50 };
      const conversation = read.readTimeline({ ...bounds, kind: "conversation", channel: "c1" });
      expect(conversation.ok && conversation.value.entries[0]?.messageId).toBe("reserved-reply");
      expect(read.readTimeline({ ...bounds, kind: "replies", channel: "c1", turnIds: [turn] }).ok).toBe(true);
      expect(read.readTimeline({ ...bounds, kind: "timeline" }).ok).toBe(true);
    } finally { read.close(); }
    expect(plans.map(plan => plan[0])).toEqual([
      expect.stringContaining("USING INDEX entries_conversation"),
      expect.stringContaining("USING INDEX entries_replies"),
      expect.stringContaining("USING INTEGER PRIMARY KEY"),
    ]);
    expect(plans.flat().filter(detail => detail.includes("SCAN entries"))).toEqual([]);
    const metadataQueries = queries.mock.calls.map(([sql]) => sql).filter(sql => sql.includes("FROM meta"));
    expect(metadataQueries.length).toBeGreaterThan(0);
    expect(metadataQueries.every(sql => sql.startsWith("SELECT key, value FROM meta WHERE key IN") && !sql.includes("modelState") && !sql.includes("importedConfig"))).toBe(true);
    expect(rangeStatements.mock.calls.every(([sql]) => !sql.includes("modelState"))).toBe(true);
  } finally { queries.mockRestore(); rangeStatements.mockRestore(); }
});

test("format 5 adds external attribution columns without changing existing signatures", () => {
  const path = fresh(), adapter = createSqliteStorageAdapter(path);
  const created = adapter.open({ mode: "create", identity });
  if (!created.ok) throw new Error(created.error.message);
  const original = { kind: "participant_message" as const, channelId: "c1", senderId: "ana", text: "hello", itemId: "old" };
  const accepted = created.value.acceptItem(original);
  if (!accepted.ok) throw new Error(accepted.error.message);
  created.value.close();
  const db = new Database(path);
  db.exec("ALTER TABLE items DROP COLUMN external_source; ALTER TABLE entries DROP COLUMN external_source; UPDATE meta SET value='5' WHERE key='formatVersion'");
  db.close();
  const reopened = adapter.open({ mode: "open", identity });
  if (!reopened.ok) throw new Error(reopened.error.message);
  const duplicate = reopened.value.acceptItem(original);
  expect(duplicate).toMatchObject({ ok: true, value: { duplicate: true, item: { signature: accepted.value.item.signature } } });
  expect(reopened.value.acceptItem({ kind: "external_notice", itemId: "new", channelId: "c1", senderId: "host", text: "notice", inheritedPolicyNames: [] }).ok).toBe(true);
  reopened.value.close();
  expect(rawFormat(path)).toBe("6");
});

test("inference sizes rows before point-reading bodies and uses bounded indexed queries", () => {
  const path = fresh(), adapter = createSqliteStorageAdapter(path);
  const ok = <T>(result: import("../src/contracts/storage.ts").StorageResult<T>): T => {
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  let s = ok(adapter.open({ mode: "create", identity }));
  const input = (channelId: string, text: string) =>
    ok(s.acceptItem({ kind: "participant_message", channelId, senderId: "ana", text }));
  function historical(channelId: string, content: string) {
    input(channelId, "history");
    const turnId = ok(s.beginTurn(channelId))!.turn.turnId;
    const reply = ok(s.appendMessage(turnId, { role: "assistant", content, calls: [] }));
    ok(s.finishTurn(turnId, { status: "completed" }));
    return reply;
  }
  const large = historical("other", "é".repeat(50_000));
  historical("local", "local reply");
  input("local", "trigger");
  const start = ok(s.beginTurn("local"))!;
  const turnId = start.turn.turnId;
  ok(s.beginSuspend());
  ok(s.checkpointTurn(turnId));
  ok(s.completeSuspend());
  ok(s.close());

  // Reopen a format-6 database from before the derived projection existed.
  const old = new Database(path);
  old.exec("DROP TRIGGER context_policy_insert; DROP TRIGGER context_policy_take; DROP TABLE context_turn_policies");
  old.close();
  s = ok(adapter.open({ mode: "open", identity }));
  const query = Database.prototype.query;
  const bodies: number[] = [];
  const plans: string[] = [];
  const trace = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
    const statement = query.call(this, sql);
    const preparePlan = (bindings: (string | number)[]) => {
      const compiled = this.prepare("EXPLAIN QUERY PLAN " + sql);
      try { plans.push(...compiled.all(...bindings).map(row => String((row as { detail: string }).detail))); }
      finally { compiled.finalize(); }
    };
    if (sql.includes("AS bytes")) {
      const bindings = sql.includes("WITH recent") ? [8, "local"] : sql.includes("context_turn_policies") ? [turnId, 9]
        : sql.includes("channel_id = ?") ? ["local", start.turn.startedSeq, 8]
        : sql.includes("seq > ?") ? [turnId, 0, 9] : sql.includes("DESC LIMIT ?") ? [turnId, 8] : [turnId];
      preparePlan(bindings);
    }
    if (sql.includes("AS reply_id")) {
      const get = statement.get.bind(statement);
      statement.get = (...args: Parameters<typeof get>) => { bodies.push(Number(args[0])); return get(...args); };
    }
    return statement;
  } as typeof Database.prototype.query);
  try {
    const read = ok(s.readInferenceContext({ channelId: "local", turnId, limits: {
      maxInputBytes: 8192, maxTakenTextBytes: 8192, maxTakenItems: 16,
      maxReadBytes: 4096, maxReadRecords: 8, maxSharedCandidates: 8,
      contextTokens: 16384, outputReserveTokens: 2048, estimationMarginTokens: 1024,
    } }));
    if ("code" in read) throw new Error(read.code);
    expect(read.policyNames).toEqual(["__legacy_allow"]);
    expect(read.sharedHistory).toHaveLength(1);
    expect(bodies.toSorted((a, b) => a - b)).toEqual(
      [...read.required, ...read.optionalTurn, ...read.localHistory, ...read.sharedHistory].map(row => row.seq).sort((a, b) => a - b),
    );
    expect(bodies).not.toContain(large.seq);
    for (const index of ["entries_context_inputs", "entries_by_turn", "entries_context_assistants", "entries_conversation", "context_turn_policies"])
      expect(plans.some(plan => plan.startsWith("SEARCH") && plan.includes(index))).toBe(true);
    expect(plans).toContain("MATERIALIZE recent");
    const calls = trace.mock.calls.map(([sql]) => sql);
    expect(calls.every(sql => !/\bmodelState\b|SELECT \* FROM (entries|items)/.test(sql))).toBe(true);
  } finally { trace.mockRestore(); ok(s.close()); }
});

test("model-call paging reads indexed rows and single-call writes patch one projection row", () => {
  const path = fresh(), adapter = createSqliteStorageAdapter(path);
  must(adapter.open({ mode: "create", identity })).close();
  const history = { nextCall: 10001, itemIds: {}, scriptPositions: {}, entryIds: {},
    calls: Array.from({ length: 10000 }, (_, index) => ({
      callId: String(index + 1), turnId: "1", channel: "c1", messageId: `model:${index + 1}`,
      startedAt: "start", endedAt: "end", outcome: "succeeded", attempts: [],
    })) };
  const legacyWrite = () => {
    using db = new Database(path);
    db.run("INSERT OR REPLACE INTO meta VALUES ('modelState', ?)", [JSON.stringify(history)]);
  };
  legacyWrite();
  let storage = must(adapter.open({ mode: "open", identity }));
  try {
    let owner!: Database;
    const originalQuery = Database.prototype.query;
    const query = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
      if (sql.includes("SELECT summary FROM model_call_pages")) owner = this;
      return originalQuery.call(this, sql);
    } as typeof Database.prototype.query);
    try {
      const defaultPage = must(storage.readCalls());
      expect(defaultPage.calls).toHaveLength(100);
      expect(defaultPage.next).toBe("100");
      expect(must(storage.readCalls("9998", 1))).toMatchObject({ calls: [{ callId: "9999" }], next: "9999" });
      expect(must(storage.readCalls("9999", 100))).toMatchObject({ calls: [{ callId: "10000" }] });
      expect(storage.readCalls("09999")).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(query.mock.calls.map(([sql]) => sql).some(sql => sql.includes("key = 'modelState'"))).toBe(false);
    } finally { query.mockRestore(); }
    {
      const plan = owner.prepare("EXPLAIN QUERY PLAN SELECT summary FROM model_call_pages WHERE call_number > ? ORDER BY call_number LIMIT ?");
      try { expect(JSON.stringify(plan.all(9998, 2))).toContain("USING INTEGER PRIMARY KEY"); } finally { plan.finalize(); }
      owner.exec(`CREATE TABLE projection_writes (id INTEGER);
        CREATE TRIGGER count_call_rows AFTER INSERT ON model_call_pages
        BEGIN INSERT INTO projection_writes VALUES (NEW.call_number); END;`);
    }
    must(storage.acceptItem({ itemId: "new", kind: "participant_message", channelId: "c1", senderId: "ana", text: "hello" }));
    const turn = must(storage.beginTurn("c1"))!.turn;
    expect(must(storage.startCall(String(turn.turnId), ["new"])).callId).toBe("10001");
    {
      const writes = owner.prepare("SELECT id FROM projection_writes");
      try { expect(writes.all()).toEqual([{ id: 10001 }]); } finally { writes.finalize(); }
    }
    history.nextCall = 10002;
    history.calls.push({ ...history.calls[0]!, callId: "10001", messageId: "model:10001" });
    const legacy = owner.prepare("INSERT OR REPLACE INTO meta VALUES ('modelState', ?)");
    try { legacy.run(JSON.stringify(history)); } finally { legacy.finalize(); }
    expect(storage.readCalls("10000")).toMatchObject({ ok: false, error: { code: "storage_failure" } });
    must(storage.close());
    history.nextCall = 10003;
    history.calls.push({ ...history.calls[0]!, callId: "10002", messageId: "model:10002" });
    legacyWrite();
    storage = must(adapter.open({ mode: "open", identity }));
    expect(must(storage.readCalls("10000")).calls.map(call => call.callId)).toEqual(["10001", "10002"]);
  } finally { storage.close(); }
});
