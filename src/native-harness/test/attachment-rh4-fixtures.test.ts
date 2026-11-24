import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";
import { sqliteAttachmentTables } from "../src/state/storage/attachment-tables.ts";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createUploadManager } from "../src/capabilities/attachments/upload.ts";
import { readAttachment } from "../src/capabilities/attachments/read.ts";
import type { StorageResult, SessionArchive } from "../src/contracts/storage.ts";
function take<T>(result: StorageResult<T>): T { if (!result.ok) throw Error(JSON.stringify(result.error)); return result.value; }
const identity = { sessionId: "a1-rh4-fixture", compatibilityKey: "test" };
const config = { version: 1 as const, system: "test", model: { protocol: "scripted" as const, script: "test" }, defaultPolicy: "open", policies: { open: { fallback: "allow" as const, tools: {} } }, limits: { unattendedTurns: 1 } };

test("approved R-H4 SQLite and logical archive fixtures reopen on the trial runtime", () => {
  const home = mkdtempSync(join(tmpdir(), "a1-rh4-reopen-"));
  try {
    const path = join(home, "sqlite");
    copyFileSync(new URL("./fixtures/attachments-rh4/format-8.sqlite", import.meta.url), path);
    const archive = JSON.parse(readFileSync(new URL("./fixtures/attachments-rh4/archive-7.json", import.meta.url), "utf8")) as SessionArchive;
    const imported = createSqliteStorageAdapter(join(home, "imported"));
    take(imported.importArchive(archive));
    for (const adapter of [createSqliteStorageAdapter(path), imported]) {
      const store = take(adapter.open({ mode: "open", identity, config }));
      try {
        expect(take(store.readSession()).formatVersion).toBe(8);
        expect(take(store.readReminder("routine"))).toMatchObject({ id: "routine", schedule: { every: 600000, count: 2 } });
        const exported = take(store.exportArchive());
        expect(exported.archiveVersion).toBe(7);
        expect(exported.reminderState?.guard).toEqual({ limit: 1, counters: [{ channel: "a", spent: 1 }] });
      } finally { take(store.close()); }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("detached format-9 fixture reopens and exports its prior archive without changing the source", () => {
  const home = mkdtempSync(join(tmpdir(), "a1-rh4-nine-")), path = join(home, "sqlite");
  try {
    copyFileSync(new URL("./fixtures/attachments-rh4/format-8.sqlite", import.meta.url), path);
    const db = new Database(path);
    try {
      const tables = sqliteAttachmentTables(db);
      db.transaction(() => tables.publish({ id: "unreferenced", channel: "a", filename: "fixture.txt", mediaType: "text/plain", bytes: 1, sha256: "0".repeat(64) }, "2026-01-01T00:00:00.000Z"))();
    } finally { db.close(); }
    const adapter = createSqliteStorageAdapter(path), store = take(adapter.open({ mode: "open", identity, config }));
    let exported: SessionArchive;
    try {
      expect(take(store.readSession()).formatVersion).toBe(9);
      exported = take(store.exportArchive());
      expect(exported.archiveVersion).toBe(7);
      expect(exported.snapshot.session.formatVersion).toBe(8);
      expect(exported.reminderState?.guard).toEqual({ limit: 1, counters: [{ channel: "a", spent: 1 }] });
      expect(JSON.stringify(exported)).not.toContain("unreferenced");
      expect(take(store.readSession()).formatVersion).toBe(9);
    } finally { take(store.close()); }
    const imported = createSqliteStorageAdapter(join(home, "imported"));
    take(imported.importArchive(exported!));
    const restored = take(imported.open({ mode: "open", identity, config }));
    try {
      expect(take(restored.readSession()).formatVersion).toBe(8);
      expect(take(restored.readReminder("routine"))).toMatchObject({ id: "routine" });
      expect(take(restored.exportArchive()).reminderState?.guard?.counters).toEqual([{ channel: "a", spent: 1 }]);
    } finally { take(restored.close()); }
    const cleanup = new Database(path);
    try { cleanup.exec("DELETE FROM attachment_files WHERE id='unreferenced'"); } finally { cleanup.close(); }
    const cleaned = take(adapter.open({ mode: "open", identity, config }));
    try {
      expect(take(cleaned.readSession()).formatVersion).toBe(9);
      expect(take(cleaned.exportArchive()).archiveVersion).toBe(7);
    } finally { take(cleaned.close()); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("detached format-9 sources retain legacy archive 5 and 6 selection", () => {
  const home = mkdtempSync(join(tmpdir(), "a1-legacy-nine-"));
  try {
    for (const version of [5, 6] as const) {
      const path = join(home, String(version)), adapter = createSqliteStorageAdapter(path);
      const store = take(adapter.open({ mode: "create", identity }));
      if (version === 6) {
        take(store.createChannel({ channelId: "a" }));
        const at = Date.parse("2026-10-31T12:00:00.000Z");
        take(store.changeReminder({ op: "create", reminderId: "once", changeId: 1, payload: { channel: "a", text: "one",
          acceptedAt: new Date(at).toISOString(), schedule: { at: new Date(at + 600000).toISOString() } } }, at));
      }
      take(store.close());
      const db = new Database(path);
      try { db.transaction(() => sqliteAttachmentTables(db).publish({ id: "detached", channel: "a", filename: "x", mediaType: "text/plain", bytes: 1, sha256: "0".repeat(64) }, "2026-01-01T00:00:00.000Z"))(); }
      finally { db.close(); }
      const opened = take(adapter.open({ mode: "open", identity }));
      try {
        expect(take(opened.readSession()).formatVersion).toBe(9);
        const archive = take(opened.exportArchive());
        expect(archive.archiveVersion).toBe(version);
        expect(archive.snapshot.session.formatVersion).toBe(version === 5 ? 6 : 7);
        expect(take(opened.readSession()).formatVersion).toBe(9);
        const copy = createSqliteStorageAdapter(join(home, `copy-${version}`));
        take(copy.importArchive(archive));
        const restored = take(copy.open({ mode: "open", identity }));
        try { if (version === 6) expect(take(restored.readReminder("once"))).toMatchObject({ id: "once" }); }
        finally { take(restored.close()); }
      } finally { take(opened.close()); }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("imported approved archive 7 can activate format 9 and reopen", () => {
  const home = mkdtempSync(join(tmpdir(), "a1-rh4-import-nine-")), path = join(home, "sqlite");
  try {
    const original = JSON.parse(readFileSync(new URL("./fixtures/attachments-rh4/archive-7.json", import.meta.url), "utf8")) as SessionArchive;
    const adapter = createSqliteStorageAdapter(path);
    take(adapter.importArchive(original));
    const db = new Database(path);
    try { db.transaction(() => sqliteAttachmentTables(db).publish({ id: "detached", channel: "a", filename: "x", mediaType: "text/plain", bytes: 1, sha256: "0".repeat(64) }, "2026-01-01T00:00:00.000Z"))(); }
    finally { db.close(); }
    const store = take(adapter.open({ mode: "open", identity, config }));
    try {
      expect(take(store.readSession()).formatVersion).toBe(9);
      expect(take(store.readReminder("routine"))).toMatchObject({ id: "routine" });
      const archive = take(store.exportArchive());
      expect(archive.archiveVersion).toBe(7);
      expect(archive.reminderState?.guard).toEqual({ limit: 1, counters: [{ channel: "a", spent: 1 }] });
      expect(JSON.stringify(archive)).not.toContain("detached");
    } finally { take(store.close()); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("new reminder state advances the detached archive base without downgrading format 9", () => {
  const home = mkdtempSync(join(tmpdir(), "a1-base-nine-")), path = join(home, "sqlite");
  try {
    const adapter = createSqliteStorageAdapter(path), fresh = take(adapter.open({ mode: "create", identity }));
    take(fresh.createChannel({ channelId: "a" })); take(fresh.close());
    const db = new Database(path);
    try { db.transaction(() => sqliteAttachmentTables(db).publish({ id: "detached", channel: "a", filename: "x", mediaType: "text/plain", bytes: 1, sha256: "0".repeat(64) }, "2026-01-01T00:00:00.000Z"))(); }
    finally { db.close(); }
    const store = take(adapter.open({ mode: "open", identity }));
    try {
      const at = Date.parse("2026-10-31T12:00:00.000Z");
      take(store.changeReminder({ op: "create", reminderId: "once", changeId: 1, payload: { channel: "a", text: "one", acceptedAt: new Date(at).toISOString(), schedule: { at: new Date(at + 600000).toISOString() } } }, at));
      expect(take(store.readSession()).formatVersion).toBe(9);
      expect(take(store.exportArchive()).archiveVersion).toBe(6);
      take(store.changeReminder({ op: "create", reminderId: "routine2", changeId: 1, payload: { channel: "a", text: "two", acceptedAt: new Date(at).toISOString(), schedule: { every: 600000, count: 2 }, expiresAfter: null } }, at));
      expect(take(store.readSession()).formatVersion).toBe(9);
      expect(take(store.exportArchive()).archiveVersion).toBe(7);
    } finally { take(store.close()); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("durable publication activates format 9 through the owning session and survives reopen", () => {
  const home = mkdtempSync(join(tmpdir(), "a1-owner-nine-")), path = join(home, "sqlite"), root = join(home, "media");
  try {
    copyFileSync(new URL("./fixtures/attachments-rh4/format-8.sqlite", import.meta.url), path);
    const adapter = createSqliteStorageAdapter(path), store = take(adapter.open({ mode: "open", identity, config }));
    const data = Buffer.from("managed fixture bytes"), sha256 = createHash("sha256").update(data).digest("hex");
    const uploads = createUploadManager({ root, validateImage() { throw Error("unexpected image"); }, publishReady: metadata => { take(store.registerReadyAttachment(metadata)); } });
    const begin = uploads.begin({ channel: "a", filename: "fixture.txt", mediaType: "text/plain", bytes: data.length, sha256 });
    uploads.write("a", begin.uploadId, 0, data.toString("base64"));
    const metadata = uploads.finalize("a", begin.uploadId);
    expect(take(store.readSession()).formatVersion).toBe(9);
    expect(take(store.readManagedAttachment(metadata.id))?.metadata).toEqual(metadata);
    uploads.close(); take(store.close());
    const reopened = take(adapter.open({ mode: "open", identity, config }));
    try {
      expect(take(reopened.readSession()).formatVersion).toBe(9);
      const lookup = (id: string) => { const saved = take(reopened.readManagedAttachment(id)); return saved && { ...saved, timelineReadable: true }; };
      expect(Buffer.from(readAttachment({ root, channel: "a", id: metadata.id, offset: 0, lookup }).data, "base64")).toEqual(data);
      expect(take(reopened.exportArchive()).archiveVersion).toBe(7);
      expect(take(reopened.readSession()).formatVersion).toBe(9);
    } finally { take(reopened.close()); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
