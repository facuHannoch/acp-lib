import type { Database } from "bun:sqlite";
import { ReminderPersistence, type Reminder, type ReminderChange, type ReminderJournal, type ReminderWakeIndex } from "./reminders.ts";

export const REMINDER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS reminder_journals (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, high_water INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reminder_conversation ON reminder_journals(conversation_id, id);
  CREATE TABLE IF NOT EXISTS reminder_changes (
    id TEXT NOT NULL REFERENCES reminder_journals(id) ON DELETE CASCADE,
    change_id INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (id, change_id)
  );
  CREATE TABLE IF NOT EXISTS reminder_cache (
    id TEXT PRIMARY KEY REFERENCES reminder_journals(id) ON DELETE CASCADE, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reminder_suspensions (conversation_id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS reminder_wake_index (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), value TEXT NOT NULL
  );
`;

type Runner = <T>(operation: () => T) => Promise<T>;
type JournalRow = { id: string; conversation_id: string; high_water: number };
type ValueRow = { value: string };

export function createSqliteReminderPersistence(database: Database, write: Runner, read: Runner): ReminderPersistence {
  const journalFrom = (row: JournalRow): ReminderJournal => {
    const cache = database.query<ValueRow, [string]>("SELECT value FROM reminder_cache WHERE id = ?").get(row.id);
    const changes = database.query<ValueRow, [string]>(
      "SELECT value FROM reminder_changes WHERE id = ? ORDER BY change_id",
    ).all(row.id);
    return {
      id: row.id,
      conversationId: row.conversation_id,
      highWater: row.high_water,
      ...(cache ? { confirmed: JSON.parse(cache.value) as Reminder } : {}),
      changes: changes.map(({ value }) => JSON.parse(value) as ReminderChange),
    };
  };
  return new ReminderPersistence(true, {
    get(id) {
      const row = database.query<JournalRow, [string]>("SELECT * FROM reminder_journals WHERE id = ?").get(id);
      return row ? journalFrom(row) : undefined;
    },
    list: () => database.query<JournalRow, []>("SELECT * FROM reminder_journals ORDER BY id").all().map(journalFrom),
    save(journal) {
      database.query(`INSERT INTO reminder_journals VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET high_water = excluded.high_water`).run(journal.id, journal.conversationId, journal.highWater);
      const existing = database.query<{ change_id: number }, [string]>(
        "SELECT change_id FROM reminder_changes WHERE id = ?",
      ).all(journal.id);
      const retained = new Set(journal.changes.map(({ changeId }) => changeId));
      for (const { change_id } of existing) {
        if (!retained.has(change_id)) database.query("DELETE FROM reminder_changes WHERE id = ? AND change_id = ?").run(journal.id, change_id);
      }
      for (const change of journal.changes) {
        database.query(`INSERT INTO reminder_changes VALUES (?, ?, ?)
          ON CONFLICT(id, change_id) DO UPDATE SET value = excluded.value WHERE value <> excluded.value`
        ).run(journal.id, change.changeId, JSON.stringify(change));
      }
      if (journal.confirmed) {
        database.query(`INSERT INTO reminder_cache VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET value = excluded.value`).run(journal.id, JSON.stringify(journal.confirmed));
      }
    },
    remove: (id) => { database.query("DELETE FROM reminder_journals WHERE id = ?").run(id); },
    suspended: (id) => database.query("SELECT 1 FROM reminder_suspensions WHERE conversation_id = ?").get(id) !== null,
    setSuspended(id, suspended) {
      if (suspended) database.query("INSERT OR IGNORE INTO reminder_suspensions VALUES (?)").run(id);
      else database.query("DELETE FROM reminder_suspensions WHERE conversation_id = ?").run(id);
    },
    wake() {
      const row = database.query<ValueRow, []>("SELECT value FROM reminder_wake_index WHERE singleton = 1").get();
      return row ? JSON.parse(row.value) as ReminderWakeIndex : { reported: null, effectiveAt: null };
    },
    saveWake(wake) {
      database.query(`INSERT INTO reminder_wake_index VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET value = excluded.value`).run(JSON.stringify(wake));
    },
  }, (operation) => write(() => database.inTransaction ? operation() : database.transaction(operation).immediate()), read);
}
