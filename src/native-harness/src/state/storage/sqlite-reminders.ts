import type { Database } from "bun:sqlite";
import type { OneOffReminder, ReminderWake } from "../../contracts/reminders.ts";
import type { ReminderReceipt } from "./reminder-change.ts";
import type { ReminderRow, ReminderTables } from "./reminder-tables.ts";

type Saved = { creation_seq: number; json: string; original: string | null; defaulted_expiry: number };
const decode = (row: Saved): ReminderRow => ({
  sequence: row.creation_seq, defaultedExpiry: row.defaulted_expiry === 1, reminder: JSON.parse(row.json) as OneOffReminder,
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
          channel TEXT NOT NULL, due_at TEXT, original TEXT, json TEXT NOT NULL, defaulted_expiry INTEGER NOT NULL, runnable_at TEXT
        );
        CREATE INDEX reminder_channel_order ON reminder_rows(channel, creation_seq);
        CREATE INDEX reminder_policy_blocks ON reminder_rows(creation_seq)
          WHERE json_extract(json, '$.state') = 'blocked' AND json_extract(json, '$.blockedReason') = 'invalid_policy';
        CREATE INDEX reminder_deadlines ON reminder_rows(runnable_at, creation_seq) WHERE runnable_at IS NOT NULL;
        CREATE TRIGGER reminder_channel_lifecycle AFTER UPDATE OF lifecycle ON channels
          WHEN OLD.lifecycle <> NEW.lifecycle BEGIN
            UPDATE reminder_rows SET runnable_at = CASE WHEN NEW.lifecycle = 'open' THEN due_at END
            WHERE channel = NEW.channel_id AND due_at IS NOT NULL;
          END;
        CREATE TABLE reminder_receipts (
          reminder_id TEXT NOT NULL, change_id INTEGER NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY(reminder_id, change_id)
        ) WITHOUT ROWID;
        CREATE TABLE reminder_creates (reminder_id TEXT PRIMARY KEY, json TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE reminder_metadata (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1), listing_revision INTEGER NOT NULL,
          wake_revision INTEGER NOT NULL, next_due_at TEXT
        );
        INSERT INTO reminder_metadata VALUES (1, 0, 0, NULL);
      `);
    },
    archive() {
      return {
        rows: execute<Saved[]>("SELECT creation_seq, json, original, defaulted_expiry FROM reminder_rows ORDER BY creation_seq", [], "all").map(decode),
        receipts: execute<Array<{ json: string }>>("SELECT json FROM reminder_receipts ORDER BY reminder_id, change_id", [], "all")
          .map(row => JSON.parse(row.json) as ReminderReceipt),
        listingRevision: this.listingRevision(), wake: this.wake(),
      };
    },
    restore(saved) {
      this.activate();
      for (const row of saved.rows) this.put(row);
      for (const receipt of saved.receipts) this.saveReceipt(receipt);
      this.setWake(saved.wake);
      execute("UPDATE reminder_metadata SET listing_revision = ?", [saved.listingRevision], "run");
    },
    get(id) {
      if (!active()) return;
      const row = execute<Saved | null>("SELECT creation_seq, json, original, defaulted_expiry FROM reminder_rows WHERE reminder_id = ?", [id], "get");
      return row ? decode(row) : undefined;
    },
    put(row) {
      execute(`INSERT INTO reminder_rows VALUES (?, ?, ?, ?, ?, ?, ?,
          (SELECT CASE WHEN lifecycle = 'open' THEN ? END FROM channels WHERE channel_id = ?))
        ON CONFLICT(reminder_id) DO UPDATE SET due_at = excluded.due_at, runnable_at = excluded.runnable_at, json = excluded.json, defaulted_expiry = excluded.defaulted_expiry`, [
        row.reminder.id, row.sequence, row.reminder.channel, row.reminder.nextRunAt,
        row.original ?? null, JSON.stringify(row.reminder), row.defaultedExpiry ? 1 : 0, row.reminder.nextRunAt, row.reminder.channel,
      ], "run");
      execute("UPDATE reminder_metadata SET listing_revision = listing_revision + 1", [], "run");
    },
    originalCreate(id) {
      if (!active()) return;
      const row = execute<{ json: string } | null>("SELECT json FROM reminder_creates WHERE reminder_id = ?", [id], "get");
      return row ? JSON.parse(row.json) as ReminderReceipt : undefined;
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
      const json = JSON.stringify(receipt);
      execute("INSERT INTO reminder_receipts VALUES (?, ?, ?)", [reminderId, changeId, json], "run");
      if (receipt.fingerprint.startsWith('["create",'))
        execute("INSERT OR IGNORE INTO reminder_creates VALUES (?, ?)", [reminderId, json], "run");
    },
    list(channel, after, limit) {
      if (!active()) return [];
      const rows = channel === undefined
        ? execute<Saved[]>("SELECT creation_seq, json, original, defaulted_expiry FROM reminder_rows WHERE creation_seq > ? ORDER BY creation_seq LIMIT ?", [after, limit], "all")
        : execute<Saved[]>(`SELECT creation_seq, json, original, defaulted_expiry FROM reminder_rows WHERE channel = ? AND creation_seq > ?
          ORDER BY creation_seq LIMIT ?`, [channel, after, limit], "all");
      return rows.map(decode);
    },
    blocked(channel, after, limit) {
      if (!active()) return [];
      return execute<Saved[]>(`SELECT creation_seq, json, original, defaulted_expiry FROM reminder_rows
        WHERE json_extract(json, '$.state') = 'blocked' AND json_extract(json, '$.blockedReason') = 'invalid_policy'
          AND creation_seq > ? ${channel === undefined ? "" : "AND channel = ?"} ORDER BY creation_seq LIMIT ?`,
      channel === undefined ? [after, limit] : [after, channel, limit], "all").map(decode);
    },
    eligible(through, limit) {
      if (!active()) return [];
      return execute<Saved[]>(`SELECT r.creation_seq, r.json, r.original, r.defaulted_expiry FROM reminder_rows r
        WHERE r.runnable_at <= ?
        ORDER BY r.runnable_at, r.creation_seq LIMIT ?`, [through ?? "9999-12-31T23:59:59.999Z", limit], "all").map(decode);
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
