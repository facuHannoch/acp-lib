import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";
import type { StorageResult } from "../src/contracts/storage.ts";
import type { ReminderChange } from "../src/contracts/reminders.ts";

const identity = { sessionId: "reminders", compatibilityKey: "test" };
const instant = Date.parse("2026-11-24T12:00:00.000Z");
const due = new Date(instant + 120_000).toISOString();

function value<T>(result: StorageResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function create(id: string): ReminderChange {
  return { reminderId: id, changeId: 1, op: "create", payload: {
    channel: "alpha", schedule: { at: due }, text: "Check the result", acceptedAt: new Date(instant).toISOString(),
  } };
}
for (const kind of ["memory", "sqlite"] as const) test(`${kind}: replay and due processing preserve an atomic one-off across reopen`, () => {
  const dir = mkdtempSync(join(tmpdir(), "reminder-state-"));
  const path = join(dir, "s.db"), adapter = kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(path);
  let store = value(adapter.open({ mode: "create", identity }));
  try {
    value(store.close());
    if (kind === "sqlite") {
      using db = new Database(path);
      expect(db.query("SELECT value FROM meta WHERE key='formatVersion'").get()).toEqual({ value: "6" });
      expect(db.query("SELECT 1 FROM sqlite_schema WHERE name='reminder_rows'").get()).toBeNull();
    }
    store = value(adapter.open({ mode: "open", identity }));
    value(store.acceptItem({ kind: "participant_message", channelId: "alpha", senderId: "Rin", itemId: "seed", text: "seed" }));
    const first = value(store.changeReminder(create("one"), instant));
    expect(first).toMatchObject({ outcome: "applied", reminder: { nextRunAt: due } });
    expect(value(store.changeReminder(create("one"), instant + 10_000))).toEqual(first);
    expect(value(store.reminderWake())).toEqual({ nextDueAt: due, reminderRevision: 1 });
    expect(value(store.fireDueReminders(instant + 119_999))).toEqual([]);
    expect(value(store.fireDueReminders(instant + 120_000))).toMatchObject([
      { channel: "alpha", event: { type: "reminder_fired", reminderId: "one", noticeId: `reminder-notice:one:${due}` } },
    ]);
    expect(value(store.readReminder("one"))?.state).toBe("done");
    value(store.close());
    store = value(adapter.open({ mode: "open", identity }));
    expect(value(store.fireDueReminders(instant + 140_000))).toEqual([]);
    expect(value(store.reminderWake())).toEqual({ nextDueAt: null, reminderRevision: 2 });
    expect(value(store.snapshot()).items.filter(item => item.kind === "external_notice")).toHaveLength(1);
    expect(value(store.changeReminder({ reminderId: "one", changeId: 2, op: "cancel", payload: {} }, instant + 140_000)))
      .toMatchObject({ outcome: "applied", alreadyQueued: true });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: format activation, expiry provenance and held expiry survive archive import`, () => {
  const dir = mkdtempSync(join(tmpdir(), "reminder-archive-"));
  const adapterFor = (name: string) => kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(dir, name));
  const source = adapterFor("source.db"), destination = adapterFor("destination.db");
  let store = value(source.open({ mode: "create", identity }));
  try {
    expect(value(store.exportArchive()).archiveVersion).toBe(5);
    const blocked = create("blocked");
    expect(value(store.changeReminder(blocked, instant))).toMatchObject({ outcome: "blocked", reason: "channel_missing" });
    expect(value(store.exportArchive()).archiveVersion).toBe(6);
    value(store.createChannel({ channelId: "alpha" }));
    expect(value(store.changeReminder(blocked, instant))).toMatchObject({ outcome: "blocked", reason: "channel_missing" });
    const changed: ReminderChange = { ...blocked, changeId: 2, op: "create", payload: {
      channel: "alpha", text: "corrected", schedule: { at: due }, acceptedAt: new Date(instant).toISOString(),
    } };
    expect(value(store.changeReminder(changed, instant))).toMatchObject({ outcome: "blocked", reason: "conflict" });
    const seeded = create("defaulted");
    const original = value(store.changeReminder(seeded, instant));
    const archive = value(store.exportArchive());
    expect(archive.archiveVersion).toBe(6);
    value(store.close());
    value(destination.importArchive(archive));
    store = value(destination.open({ mode: "open", identity }));
    const next = new Date(instant + 600_000).toISOString();
    expect(value(store.changeReminder({ reminderId: "defaulted", changeId: 2, op: "update", payload: {
      schedule: { at: next }, acceptedAt: new Date(instant).toISOString(),
    } }, instant))).toMatchObject({ outcome: "applied", reminder: { expiresAfter: 1_200_000 } });
    expect(value(store.changeReminder(seeded, instant))).toEqual(original);
    value(store.beginChannelSuspend("alpha"));
    expect(value(store.fireDueReminders(instant + 600_000))).toEqual([]);
    expect(value(store.reminderWake()).nextDueAt).toBeNull();
    value(store.resumeChannel("alpha"));
    expect(value(store.fireDueReminders(instant + 1_800_000))).toMatchObject([{ event: { type: "reminder_expired" } }]);
    expect(value(store.snapshot()).items).toHaveLength(0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SQLite: due rows are indexed, capped and leave a remaining wake across batches", () => {
  const dir = mkdtempSync(join(tmpdir(), "reminder-batch-")), path = join(dir, "session.db");
  const adapter = createSqliteStorageAdapter(path);
  const store = value(adapter.open({ mode: "create", identity }));
  try {
    value(store.createChannel({ channelId: "alpha" }));
    for (let index = 0; index < 101; index++) value(store.changeReminder(create(String(index)), instant));
    const page = value(store.listReminders({ limit: 50 }));
    expect(page.reminders).toHaveLength(50);
    expect(page.next).toBeDefined();
    value(store.changeReminder(create("0"), instant));
    expect(value(store.listReminders({ after: page.next })).reminders[0]?.id).toBe("50");
    expect(value(store.fireDueReminders(instant + 120_000))).toHaveLength(100);
    expect(value(store.reminderWake()).nextDueAt).toBe(due);
    expect(store.listReminders({ after: page.next })).toMatchObject({ ok: false, error: { code: "invalid_cursor" } });
    expect(value(store.fireDueReminders(instant + 120_000))).toMatchObject([{ event: { reminderId: "100" } }]);
    expect(value(store.reminderWake()).nextDueAt).toBeNull();
    value(store.close());
    using db = new Database(path);
    const plan = db.query("EXPLAIN QUERY PLAN SELECT json FROM reminder_rows WHERE runnable_at <= ? ORDER BY runnable_at, creation_seq LIMIT 100").all(due);
    expect(JSON.stringify(plan)).toContain("USING INDEX reminder_deadlines");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
