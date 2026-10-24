import type { Database } from "bun:sqlite";
import type { MediaInfo, MediaStore, StoredMedia } from "../media/store.ts";

interface Row { ref: string; owner: string; kind: MediaInfo["kind"]; mime_type: string; name: string | null; size: number; sha256: string; data?: Uint8Array; }
function entry(row: Row): StoredMedia {
  return { ref: row.ref, info: { owner: row.owner, kind: row.kind, mimeType: row.mime_type,
    ...(row.name === null ? {} : { name: row.name }), size: row.size, sha256: row.sha256 } };
}

/** The scoped writer joins the enclosing record transaction when one is active. */
export class SqliteMediaStore implements MediaStore {
  constructor(private readonly database: Database, private readonly write: <T>(work: () => T) => Promise<T>) {}
  async put(bytes: Uint8Array, info: MediaInfo): Promise<string> {
    return this.write(() => {
      const ref = `media-${crypto.randomUUID()}`;
      this.database.query("INSERT INTO conversation_media(ref, owner, kind, mime_type, name, size, sha256, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(ref, info.owner, info.kind, info.mimeType, info.name ?? null, info.size, info.sha256, bytes);
      return ref;
    });
  }
  async get(ref: string): Promise<(StoredMedia & { data: Uint8Array }) | null> {
    const row = this.database.query<Row, [string]>("SELECT * FROM conversation_media WHERE ref = ?").get(ref);
    return row ? { ...entry(row), data: new Uint8Array(row.data!) } : null;
  }
  async delete(ref: string): Promise<void> {
    await this.write(() => { this.database.query("DELETE FROM conversation_media WHERE ref = ?").run(ref); });
  }
  async list(owner: string): Promise<readonly StoredMedia[]> {
    return this.database.query<Row, [string]>("SELECT ref, owner, kind, mime_type, name, size, sha256 FROM conversation_media WHERE owner = ? ORDER BY rowid").all(owner).map(entry);
  }
}
