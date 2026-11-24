import type { Database } from "bun:sqlite";
import type { Reminder, ReminderWake } from "../../contracts/reminders.ts";
import type { ReminderReceipt } from "./reminder-change.ts";
import type { ReminderRow, ReminderTables } from "./reminder-tables.ts";

type Saved = { creation_seq: number; json: string; original: string | null; defaulted_expiry: number };
const decode = (row: Saved): ReminderRow => {
  const { _routineCursor, ...reminder } = JSON.parse(row.json) as Reminder & { _routineCursor?: Pick<ReminderRow, "processedThrough" | "episodeCutoff" | "coalescedPending"> };
  return ({
  sequence: row.creation_seq, defaultedExpiry: row.defaulted_expiry === 1, reminder, ..._routineCursor,
  ...(row.original === null ? {} : { original: row.original }),
  });
};

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
    recordDisposition(event) {
      db.exec("CREATE TABLE IF NOT EXISTS routine_dispositions (json TEXT NOT NULL)");
      execute("INSERT INTO routine_dispositions VALUES (?)", [JSON.stringify(event)], "run");
    },
    activeRoutines(channel) {
      return !active() ? 0 : execute<{ count: number }>(`SELECT count(*) AS count FROM reminder_rows
        WHERE channel = ? AND json_extract(json, '$.state') = 'active' AND json_extract(json, '$.missedRuns') IS NOT NULL`, [channel], "get").count;
    },
    guardLimit() {
      if (!active() || !execute("SELECT 1 FROM sqlite_schema WHERE name = 'routine_guard'", [], "get")) return;
      return execute<{ max_turns: number }>("SELECT max_turns FROM routine_guard", [], "get").max_turns;
    },
    bindGuard(limit) {
      this.activate();
      db.exec(`CREATE INDEX IF NOT EXISTS routine_notice_sources ON items(channel_id, external_source) WHERE kind = 'external_notice';
        CREATE TABLE routine_guard (max_turns INTEGER NOT NULL);
        CREATE TABLE routine_guard_channels (channel TEXT PRIMARY KEY, spent INTEGER NOT NULL) WITHOUT ROWID`);
      execute("INSERT INTO routine_guard VALUES (?)", [limit], "run");
    },
    guardSpent(channel) {
      return execute<{ spent: number } | null>("SELECT spent FROM routine_guard_channels WHERE channel = ?", [channel], "get")?.spent ?? 0;
    },
    setGuardSpent(channel, spent) {
      execute(`INSERT INTO routine_guard_channels VALUES (?, ?)
        ON CONFLICT(channel) DO UPDATE SET spent = excluded.spent`, [channel, spent], "run");
    },
    archive() {
      const limit = this.guardLimit();
      const hasDispositions = active() && execute("SELECT 1 FROM sqlite_schema WHERE name = 'routine_dispositions'", [], "get");
      return {
        ...(hasDispositions ? { dispositions: execute<Array<{ json: string }>>("SELECT json FROM routine_dispositions ORDER BY rowid", [], "all")
          .map(row => JSON.parse(row.json)) } : {}),
        ...(limit === undefined ? {} : { guard: { limit,
          counters: execute<Array<{ channel: string; spent: number }>>("SELECT channel, spent FROM routine_guard_channels ORDER BY channel", [], "all") } }),
        rows: execute<Saved[]>("SELECT creation_seq, json, original, defaulted_expiry FROM reminder_rows ORDER BY creation_seq", [], "all").map(decode),
        receipts: execute<Array<{ json: string }>>("SELECT json FROM reminder_receipts ORDER BY reminder_id, change_id", [], "all")
          .map(row => JSON.parse(row.json) as ReminderReceipt),
        listingRevision: this.listingRevision(), wake: this.wake(),
      };
    },
    restore(saved) {
      this.activate();
      for (const disposition of saved.dispositions ?? []) this.recordDisposition(disposition);
      if (saved.guard) {
        this.bindGuard(saved.guard.limit);
        for (const { channel, spent } of saved.guard.counters) this.setGuardSpent(channel, spent);
      }
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
        row.original ?? null, JSON.stringify({ ...row.reminder, ...(row.processedThrough === undefined ? {} : { _routineCursor: { processedThrough: row.processedThrough, episodeCutoff: row.episodeCutoff, coalescedPending: row.coalescedPending } }) }), row.defaultedExpiry ? 1 : 0, row.reminder.nextRunAt, row.reminder.channel,
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
    eligible(through, limit, heldChannels = []) {
      if (!active()) return [];
      return execute<Saved[]>(`SELECT r.creation_seq, r.json, r.original, r.defaulted_expiry FROM reminder_rows r
        WHERE r.runnable_at <= ? AND (json_extract(json,'$.missedRuns') IS NULL OR channel NOT IN (SELECT value FROM json_each(?)))
        ORDER BY r.runnable_at, r.creation_seq LIMIT ?`, [through ?? "9999-12-31T23:59:59.999Z", JSON.stringify(heldChannels), limit], "all").map(decode);
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
