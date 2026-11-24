import type { Database } from "bun:sqlite";
import type { AttachmentMetadata } from "../../contracts/attachments.ts";

/** Durable attachment rows live in the same SQLite transaction as the caller's
 * inbox acceptance. The session owner is responsible for serialization with
 * file publication and cleanup. No table or format change occurs on reads. */
export function sqliteAttachmentTables(db: Database) {
  const present = () => !!db.query<{ present: number }, []>(
    "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='attachment_files'",
  ).get();
  const activate = () => {
    db.exec(`CREATE TABLE IF NOT EXISTS attachment_files (
      id TEXT PRIMARY KEY, channel TEXT NOT NULL, filename TEXT NOT NULL,
      media_type TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
      ready_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attachment_items (
      attachment_id TEXT NOT NULL REFERENCES attachment_files(id),
      item_id TEXT NOT NULL REFERENCES items(item_id),
      PRIMARY KEY (attachment_id, item_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS attachment_items_by_item ON attachment_items(item_id);`);
    const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='formatVersion'").get();
    const format = Number(row?.value);
    if (!Number.isSafeInteger(format) || format < 6 || format > 9) throw new Error("Unsupported session format");
    if (format < 9) db.query("UPDATE meta SET value='9' WHERE key='formatVersion'").run();
  };
  type Row = { id: string; channel: string; filename: string; media_type: string; bytes: number; sha256: string; ready_at: string };
  const project = (row: Row) => ({ metadata: { id: row.id, channel: row.channel, filename: row.filename,
    mediaType: row.media_type, bytes: row.bytes, sha256: row.sha256 }, readyAt: row.ready_at });
  return {
    /** Caller executes inside its owner transaction after flushing file bytes. */
    publish(metadata: AttachmentMetadata, readyAt: string) {
      activate();
      db.query("INSERT INTO attachment_files VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(metadata.id, metadata.channel, metadata.filename, metadata.mediaType, metadata.bytes, metadata.sha256, readyAt);
    },
    get(id: string) {
      if (!present()) return undefined;
      const row = db.query<Row, [string]>("SELECT * FROM attachment_files WHERE id=?").get(id);
      return row ? project(row) : undefined;
    },
    /** Call within the same transaction that inserts the accepted item. */
    associate(id: string, itemId: string) {
      if (!present()) throw new Error("Unknown attachment");
      db.query("INSERT OR IGNORE INTO attachment_items VALUES (?, ?)").run(id, itemId);
    },
    isRetained(id: string) {
      return present() && !!db.query<{ yes: number }, [string]>("SELECT 1 AS yes FROM attachment_items WHERE attachment_id=? LIMIT 1").get(id);
    },
    isTimelineVisible(id: string) {
      return present() && !!db.query<{ yes: number }, [string]>(`SELECT 1 AS yes FROM attachment_items a
        JOIN items i ON i.item_id=a.item_id WHERE a.attachment_id=? AND i.entry_seq IS NOT NULL LIMIT 1`).get(id);
    },
    /** Candidates are advisory: the owner must recheck under the same fence as
     * acceptance immediately before removing any metadata or bytes. */
    unreferencedBefore(readyAt: string) {
      if (!present()) return [];
      return db.query<Row, [string]>(`SELECT f.* FROM attachment_files f WHERE f.ready_at <= ?
        AND NOT EXISTS (SELECT 1 FROM attachment_items a WHERE a.attachment_id=f.id) ORDER BY f.id`).all(readyAt).map(project);
    },
  };
}
