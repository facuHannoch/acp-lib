import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";
import { storageConformance } from "./conformance/storage.ts";

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
  { const db = new Database(future); db.exec("UPDATE meta SET value = '3' WHERE key = 'formatVersion'"); db.close(); }
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
