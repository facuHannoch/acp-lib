import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionArchive } from "../../contracts/storage.ts";
import { Fail } from "./engine.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const syncDirectory = (path: string) => { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } };

/** A separate SQLite lock serializes create/open and import publication. It is
 * released by the OS after process death, allowing the next owner to recover. */
export function acquireImportLease(path: string): () => void {
  // Keep coordination files outside the session directory. Resolve the parent
  // so equivalent local paths share one lock, independent of caller TMPDIR.
  const key = createHash("sha256").update(join(realpathSync(dirname(path)), basename(path))).digest("hex");
  const temp = process.platform === "win32" ? tmpdir() : "/tmp";
  const lockDir = join(temp, `harness-attachment-locks-${process.getuid?.() ?? "user"}`);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const dirFd = openSync(lockDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); closeSync(dirFd);
  const lock = new Database(join(lockDir, key), { create: true, readwrite: true });
  try { lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
  catch (error) { lock.close(); const code = (error as { code?: string }).code; if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") throw new Fail("owner_conflict", "Session publication is in progress"); throw error; }
  return () => { try { lock.exec("ROLLBACK"); } finally { lock.close(true); } };
}

type Marker = { token: string; ids: string[] };
function readMarker(path: string): Marker | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let marker: Marker;
    try { marker = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
    if (!marker || typeof marker.token !== "string" || !uuid.test(marker.token) || !Array.isArray(marker.ids)
      || marker.ids.some((id: unknown) => typeof id !== "string" || !uuid.test(id)) || new Set(marker.ids).size !== marker.ids.length) throw Error();
    return marker;
  } catch { throw new Fail("incompatible", "Invalid attachment import marker"); }
}

/** Recover only files named by our validated marker. Never recursively delete an
 * existing directory, and never follow a root symlink. Caller holds the lease. */
export function recoverAttachmentImport(path: string, root: string): void {
  const markerPath = `${path}.attachment-import`;
  let marker: Marker | undefined;
  try { marker = readMarker(markerPath); }
  catch (error) {
    // The root is created only after the marker is fully written and flushed.
    // A truncated marker with no destination is an interrupted marker write.
    if (!existsSync(path) && !existsSync(root)) { rmSync(markerPath, { force: true }); syncDirectory(dirname(path)); return; }
    throw error;
  }
  if (!marker) return;
  const tokenPath = join(root, ".import-token");
  let owned = false;
  if (existsSync(root)) {
    const rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    closeSync(rootFd);
    try { const fd = openSync(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW); try { owned = readFileSync(fd, "utf8") === marker.token; } finally { closeSync(fd); } }
    catch { /* No valid token means no file publication was completed. */ }
  }
  if (existsSync(path)) {
    if (owned) { rmSync(tokenPath, { force: true }); syncDirectory(root); }
  } else if (owned) {
    const dir = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); closeSync(dir);
    for (const id of marker.ids) rmSync(join(root, id), { force: true });
    rmSync(tokenPath, { force: true });
    try { rmdirSync(root); } catch { throw new Fail("already_exists", "Interrupted import directory contains other files"); }
  } else if (existsSync(root)) {
    const entries = readdirSync(root);
    if (entries.length === 1 && entries[0] === ".import-token") rmSync(tokenPath, { force: true });
    try { rmdirSync(root); } catch { throw new Fail("already_exists", "Attachment destination is occupied"); }
  }
  rmSync(markerPath, { force: true }); syncDirectory(dirname(path));
}

/** Publish files first and the SQLite database last. A marker and lease fence
 * fresh-destination visibility; recovery removes only this import's files if
 * publication did not commit. `publishDatabase` must fail if path is occupied. */
export function publishAttachmentImport(path: string, root: string, archive: SessionArchive, publishDatabase: () => void): void {
  const state = archive.attachmentState;
  if (!state) throw new Fail("invalid_archive", "Missing attachment state");
  if (existsSync(path) || existsSync(root)) throw new Fail("already_exists", "Destination is occupied");
  const markerPath = `${path}.attachment-import`, marker: Marker = { token: randomUUID(), ids: state.files.map(file => file.metadata.id) };
  const markerFd = openSync(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(markerFd, JSON.stringify(marker)); fsyncSync(markerFd); } finally { closeSync(markerFd); }
  syncDirectory(dirname(path));
  try {
    mkdirSync(root, { mode: 0o700 });
    const tokenFd = openSync(join(root, ".import-token"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(tokenFd, marker.token); fsyncSync(tokenFd); } finally { closeSync(tokenFd); }
    syncDirectory(root);
    for (const file of state.files) {
      const fd = openSync(join(root, file.metadata.id), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { let offset = 0; while (offset < file.bytes.length) { const count = writeSync(fd, file.bytes, offset, file.bytes.length - offset, offset); if (!count) throw Error("Unable to write attachment"); offset += count; } fsyncSync(fd); }
      finally { closeSync(fd); }
    }
    syncDirectory(root);
    publishDatabase();
    syncDirectory(dirname(path));
    recoverAttachmentImport(path, root);
  } catch (error) {
    try { recoverAttachmentImport(path, root); } catch { /* Preserve the marker for the next owner. */ }
    throw error;
  }
}
