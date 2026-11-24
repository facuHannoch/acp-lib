import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAttachmentTables } from "../src/state/storage/attachment-tables.ts";

const metadata = { id: "file", channel: "a", filename: "file.txt", mediaType: "text/plain", bytes: 3, sha256: "a".repeat(64) };
function database() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('formatVersion','8'); CREATE TABLE items (item_id TEXT PRIMARY KEY, entry_seq INTEGER)");
  return db;
}
const format = (db: Database) => db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='formatVersion'").get()!.value;
describe("attachment metadata tables", () => {
  test("lazy activation and metadata commit roll back together", () => {
    const db = database();
    try {
      const tables = sqliteAttachmentTables(db);
      expect(tables.get("file")).toBeUndefined(); expect(format(db)).toBe("8");
      expect(() => db.transaction(() => { tables.publish(metadata, "2026-01-01T00:00:00.000Z"); throw Error("abort"); })()).toThrow();
      expect(tables.get("file")).toBeUndefined(); expect(format(db)).toBe("8");
      db.transaction(() => tables.publish(metadata, "2026-01-01T00:00:00.000Z"))();
      expect(format(db)).toBe("9"); expect(tables.get("file")?.metadata).toEqual(metadata);
      expect(tables.unreferencedBefore("2027-01-01T00:00:00.000Z")).toHaveLength(1);
    } finally { db.close(); }
  });
  test("association and timeline visibility follow committed item state", () => {
    const db = database();
    try {
      const tables = sqliteAttachmentTables(db);
      db.transaction(() => tables.publish(metadata, "2026-01-01T00:00:00.000Z"))();
      db.exec("INSERT INTO items VALUES ('i', NULL)");
      const parts = [{ type: "text" as const, text: "before" }, { type: "attachment" as const, id: "file" }, { type: "text" as const, text: "after" }];
      db.transaction(() => tables.saveParts("i", parts))();
      expect(tables.parts("i")).toEqual(parts);
      expect(tables.isRetained("file")).toBe(true);
      expect(tables.isTimelineVisible("file")).toBe(false);
      expect(tables.unreferencedBefore("2027-01-01T00:00:00.000Z")).toHaveLength(0);
      db.exec("UPDATE items SET entry_seq=1 WHERE item_id='i'");
      expect(tables.isTimelineVisible("file")).toBe(true);
    } finally { db.close(); }
  });
  test("activation preserves R-H4 fixture tables in the same database", () => {
    const home = mkdtempSync(join(tmpdir(), "a1-rh4-")), path = join(home, "fixture.sqlite");
    copyFileSync(new URL("./fixtures/attachments-rh4/format-8.sqlite", import.meta.url), path);
    const db = new Database(path);
    try {
      const tables = sqliteAttachmentTables(db);
      const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'reminder%' ORDER BY name").all().map(row => row.name);
      expect(names.length).toBeGreaterThan(0);
      const contents = () => names.map(name => ({ name, rows: db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() }));
      const meta = () => db.query("SELECT * FROM meta WHERE key NOT IN ('formatVersion', 'attachmentBaseFormat') ORDER BY key").all();
      const before = contents();
      const beforeMeta = meta();
      expect(format(db)).toBe("8");
      db.transaction(() => tables.publish(metadata, "2026-01-01T00:00:00.000Z"))();
      expect(format(db)).toBe("9");
      expect(contents()).toEqual(before);
      expect(meta()).toEqual(beforeMeta);
    } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
  });
});
