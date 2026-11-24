import type { Database } from "bun:sqlite";
import type { Reminder, ReminderWake } from "../../contracts/reminders.ts";
import type { ReminderReceipt } from "./reminder-change.ts";
import type { ReminderRow, ReminderTables } from "./reminder-tables.ts";

type Saved = { creation_seq: number; json: string; original: string | null };
const decode = (row: Saved): ReminderRow => ({
  sequence: row.creation_seq, reminder: JSON.parse(row.json) as Reminder,
  ...(row.original === null ? {} : { original: row.original }),
});

export function sqliteReminderTables(db: Database): ReminderTables {
  // Keep probes lazy. Creating or reading a format-6 session changes no reminder schema.
  const active = () => {
    const statement = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'reminder_rows'");
    try { return !!statement.get(); } finally { statement.finalize(); }
  };
  const execute = <T>(sql: string, params: (string | number | null)[], action: "get" | "all" | "run"): T => {
    const statement = db.prepare(sql);
    try { return statement[action](...params) as T; } finally { statement.finalize(); }
  };
  return {
    activate() {
      if (active()) return;
      db.exec(`
        CREATE TABLE reminder_rows (
          reminder_id TEXT PRIMARY KEY, creation_seq INTEGER NOT NULL UNIQUE,
          channel TEXT NOT NULL, due_at TEXT, original TEXT, json TEXT NOT NULL
        );
        CREATE INDEX reminder_channel_order ON reminder_rows(channel, creation_seq);
        CREATE INDEX reminder_deadlines ON reminder_rows(due_at, creation_seq) WHERE due_at IS NOT NULL;
        CREATE TABLE reminder_receipts (
          reminder_id TEXT NOT NULL, change_id INTEGER NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY(reminder_id, change_id)
        ) WITHOUT ROWID;
        CREATE TABLE reminder_metadata (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1), listing_revision INTEGER NOT NULL,
          wake_revision INTEGER NOT NULL, next_due_at TEXT
        );
        INSERT INTO reminder_metadata VALUES (1, 0, 0, NULL);
      `);
    },
    get(id) {
      if (!active()) return;
      const row = execute<Saved | null>("SELECT creation_seq, json, original FROM reminder_rows WHERE reminder_id = ?", [id], "get");
      return row ? decode(row) : undefined;
    },
    put(row) {
      execute(`INSERT INTO reminder_rows VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(reminder_id) DO UPDATE SET due_at = excluded.due_at, json = excluded.json`, [
        row.reminder.id, row.sequence, row.reminder.channel, row.reminder.nextRunAt,
        row.original ?? null, JSON.stringify(row.reminder),
      ], "run");
      execute("UPDATE reminder_metadata SET listing_revision = listing_revision + 1", [], "run");
    },
    receipt(id, version) {
      if (!active()) return;
      const row = execute<{ json: string } | null>("SELECT json FROM reminder_receipts WHERE reminder_id = ? AND change_id = ?", [id, version], "get");
      return row ? JSON.parse(row.json) as ReminderReceipt : undefined;
    },
    highWater(id) {
      if (!active()) return 0;
      return execute<{ change_id: number } | null>(`SELECT change_id FROM reminder_receipts
        WHERE reminder_id = ? ORDER BY change_id DESC LIMIT 1`, [id], "get")?.change_id ?? 0;
    },
    saveReceipt(receipt) {
      const { reminderId, changeId } = receipt.result;
      execute("INSERT INTO reminder_receipts VALUES (?, ?, ?)", [reminderId, changeId, JSON.stringify(receipt)], "run");
    },
    list(channel, after, limit) {
      if (!active()) return [];
      const rows = channel === undefined
        ? execute<Saved[]>("SELECT creation_seq, json, original FROM reminder_rows WHERE creation_seq > ? ORDER BY creation_seq LIMIT ?", [after, limit], "all")
        : execute<Saved[]>(`SELECT creation_seq, json, original FROM reminder_rows WHERE channel = ? AND creation_seq > ?
          ORDER BY creation_seq LIMIT ?`, [channel, after, limit], "all");
      return rows.map(decode);
    },
    eligible(through, limit) {
      if (!active()) return [];
      return execute<Saved[]>(`SELECT r.creation_seq, r.json, r.original FROM reminder_rows r
        JOIN channels c ON c.channel_id = r.channel
        WHERE r.due_at IS NOT NULL AND c.lifecycle = 'open' AND r.due_at <= ?
        ORDER BY r.due_at, r.creation_seq LIMIT ?`, [through ?? "9999-12-31T23:59:59.999Z", limit], "all").map(decode);
    },
    listingRevision() {
      return active() ? execute<{ listing_revision: number }>("SELECT listing_revision FROM reminder_metadata", [], "get").listing_revision : 0;
    },
    wake() {
      if (!active()) return { nextDueAt: null, reminderRevision: 0 };
      return execute<ReminderWake>("SELECT next_due_at AS nextDueAt, wake_revision AS reminderRevision FROM reminder_metadata", [], "get");
    },
    setWake(wake) {
      execute("UPDATE reminder_metadata SET next_due_at = ?, wake_revision = ?", [wake.nextDueAt, wake.reminderRevision], "run");
    },
  };
}
