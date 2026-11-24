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
