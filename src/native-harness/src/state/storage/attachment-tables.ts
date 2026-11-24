import type { Database } from "bun:sqlite";
import type { AttachmentMetadata, InputPart } from "../../contracts/attachments.ts";

/** Durable attachment rows live in the same SQLite transaction as the caller's
 * inbox acceptance. The session owner is responsible for serialization with
 * file publication and cleanup. No table or format change occurs on reads. */
export function sqliteAttachmentTables(db: Database) {
  // Bun caches `query` statements; short-lived explicit statements must be
  // finalized so the exclusive owner can close even after nested reads.
  const query = <R = unknown, P extends any[] = any[]>(sql: string) => ({
    get(...params: P): R | null { const statement = db.prepare<R, any[]>(sql); try { return statement.get(...params); } finally { statement.finalize(); } },
    all(...params: P): R[] { const statement = db.prepare<R, any[]>(sql); try { return statement.all(...params); } finally { statement.finalize(); } },
    run(...params: P) { const statement = db.prepare<R, any[]>(sql); try { return statement.run(...params); } finally { statement.finalize(); } },
  });
  const present = () => !!query<{ present: number }, []>(
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
    CREATE TABLE IF NOT EXISTS attachment_item_parts (
      item_id TEXT PRIMARY KEY REFERENCES items(item_id), parts TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS attachment_items_by_item ON attachment_items(item_id);`);
    const row = query<{ value: string }, []>("SELECT value FROM meta WHERE key='formatVersion'").get();
    const format = Number(row?.value);
    if (!Number.isSafeInteger(format) || format < 6 || format > 10) throw new Error("Unsupported session format");
    const prior = format === 10 ? Number(query<{ value: string }, []>("SELECT value FROM meta WHERE key='webBaseFormat'").get()?.value) : format;
    if (prior < 9) {
      if (![6, 7, 8].includes(prior)) throw new Error("Invalid attachment base format");
      query("INSERT INTO meta (key,value) VALUES ('attachmentBaseFormat', ?)").run(String(prior));
      if (format === 10) query("UPDATE meta SET value='9' WHERE key='webBaseFormat'").run();
      else query("UPDATE meta SET value='9' WHERE key='formatVersion'").run();
    }
  };
  type Row = { id: string; channel: string; filename: string; media_type: string; bytes: number; sha256: string; ready_at: string };
  const project = (row: Row) => ({ metadata: { id: row.id, channel: row.channel, filename: row.filename,
    mediaType: row.media_type, bytes: row.bytes, sha256: row.sha256 }, readyAt: row.ready_at });
  return {
    baseFormat(): number | undefined {
      const row = query<{ value: string }, []>("SELECT value FROM meta WHERE key='attachmentBaseFormat'").get();
      return row ? Number(row.value) : undefined;
    },
    advanceBaseFormat(format: number) {
      query("UPDATE meta SET value=? WHERE key='attachmentBaseFormat' AND CAST(value AS INTEGER) < ?").run(String(format), format);
    },
    hasRetained() {
      return present() && !!query<{ yes: number }, []>("SELECT 1 AS yes FROM attachment_items LIMIT 1").get();
    },
    readyIds(): string[] {
      return present() ? query<{ id: string }, []>("SELECT id FROM attachment_files ORDER BY id").all().map(row => row.id) : [];
    },
    retained() {
      if (!present()) return [];
      return query<Row, []>(`SELECT f.* FROM attachment_files f
        WHERE EXISTS (SELECT 1 FROM attachment_items a WHERE a.attachment_id=f.id) ORDER BY f.id`).all().map(project);
    },
    restore(baseFormat: 6 | 7 | 8, records: readonly { metadata: AttachmentMetadata; readyAt: string }[]) {
      activate();
      query("INSERT INTO meta (key,value) VALUES ('attachmentBaseFormat', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(baseFormat));
      for (const record of records) this.publish(record.metadata, record.readyAt);
    },
    /** Caller executes inside its owner transaction after flushing file bytes. */
    publish(metadata: AttachmentMetadata, readyAt: string) {
      activate();
      query("INSERT INTO attachment_files VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(metadata.id, metadata.channel, metadata.filename, metadata.mediaType, metadata.bytes, metadata.sha256, readyAt);
    },
    get(id: string) {
      if (!present()) return undefined;
      const row = query<Row, [string]>("SELECT * FROM attachment_files WHERE id=?").get(id);
      return row ? project(row) : undefined;
    },
    /** Call within the same transaction that inserts the accepted item. */
    associate(id: string, itemId: string) {
      if (!present()) throw new Error("Unknown attachment");
      query("INSERT OR IGNORE INTO attachment_items VALUES (?, ?)").run(id, itemId);
    },
    /** Caller inserts the item and links every attachment in the same owner
     * transaction. Retained order and boundaries do not depend on the links. */
    saveParts(itemId: string, parts: readonly InputPart[]) {
      if (!present()) throw new Error("Attachment storage has not been activated");
      query("INSERT INTO attachment_item_parts VALUES (?, ?)").run(itemId, JSON.stringify(parts));
      for (const part of parts) if (part.type === "attachment") this.associate(part.id, itemId);
    },
    parts(itemId: string): InputPart[] | undefined {
      if (!present()) return undefined;
      const row = query<{ parts: string }, [string]>("SELECT parts FROM attachment_item_parts WHERE item_id=?").get(itemId);
      return row ? JSON.parse(row.parts) as InputPart[] : undefined;
    },
    isRetained(id: string) {
      return present() && !!query<{ yes: number }, [string]>("SELECT 1 AS yes FROM attachment_items WHERE attachment_id=? LIMIT 1").get(id);
    },
    isTimelineVisible(id: string) {
      return present() && !!query<{ yes: number }, [string]>(`SELECT 1 AS yes FROM attachment_items a
        JOIN items i ON i.item_id=a.item_id WHERE a.attachment_id=? AND i.entry_seq IS NOT NULL LIMIT 1`).get(id);
    },
    /** Candidates are advisory: the owner must recheck under the same fence as
     * acceptance immediately before removing any metadata or bytes. */
    unreferencedBefore(readyAt: string) {
      if (!present()) return [];
      return query<Row, [string]>(`SELECT f.* FROM attachment_files f WHERE f.ready_at <= ?
        AND NOT EXISTS (SELECT 1 FROM attachment_items a WHERE a.attachment_id=f.id) ORDER BY f.id`).all(readyAt).map(project);
    },
    /** Within the owner transaction, compete with acceptance on the same
     * database. Once metadata is removed, a crash before unlink leaves only an
     * orphan that the next owner can reclaim. */
    reclaim(id: string, readyAt: string): boolean {
      if (!present()) return false;
      const result = query(`DELETE FROM attachment_files WHERE id=? AND ready_at <= ?
        AND NOT EXISTS (SELECT 1 FROM attachment_items WHERE attachment_id=?)`).run(id, readyAt, id);
      return result.changes === 1;
    },
  };
}
