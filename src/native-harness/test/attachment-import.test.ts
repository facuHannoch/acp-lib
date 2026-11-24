import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireImportLease, publishAttachmentImport, recoverAttachmentImport } from "../src/state/storage/attachment-import.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";
import type { SessionArchive } from "../src/contracts/storage.ts";
import { readArchiveFiles } from "../src/state/storage/attachment-files.ts";

const id = "11111111-1111-4111-8111-111111111111";
const archive = { attachmentState: { baseFormat: 6, files: [{ metadata: { id, channel: "a", filename: "x", mediaType: "text/plain", bytes: 1, sha256: "0".repeat(64) }, readyAt: "2026-01-01T00:00:00.000Z", bytes: Uint8Array.of(1) }] } } as unknown as SessionArchive;

test("import lease serializes publishers and failed publication cleans its files", () => {
  const home = mkdtempSync(join(tmpdir(), "a1-import-")), path = join(home, "session.sqlite"), root = join(home, "media");
  try {
    const release = acquireImportLease(path);
    try {
      expect(() => acquireImportLease(path)).toThrow("publication is in progress");
      expect(() => publishAttachmentImport(path, root, archive, () => { throw Error("interrupted"); })).toThrow("interrupted");
      expect(existsSync(path)).toBe(false); expect(existsSync(root)).toBe(false); expect(existsSync(`${path}.attachment-import`)).toBe(false);
    } finally { release(); }
    const again = acquireImportLease(path); again();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("oversized retained export is rejected before file reads", () => {
  const metadata = { id, channel: "a", filename: "x", mediaType: "application/octet-stream", bytes: 20 * 1024 * 1024, sha256: "0".repeat(64) };
  try { readArchiveFiles("/nonexistent", Array.from({ length: 13 }, () => ({ metadata, readyAt: "2026-01-01T00:00:00.000Z" })), 256 * 1024 * 1024); throw Error("expected failure"); }
  catch (error) { expect(error).toMatchObject({ code: "transfer_limit" }); }
});

test("recovery handles interrupted marker and token writes", () => {
  const home = mkdtempSync(join(tmpdir(), "a1-import-marker-")), path = join(home, "session.sqlite"), root = join(home, "media");
  try {
    writeFileSync(`${path}.attachment-import`, "{");
    recoverAttachmentImport(path, root);
    expect(existsSync(`${path}.attachment-import`)).toBe(false);
    writeFileSync(`${path}.attachment-import`, JSON.stringify({ token: id, ids: [id] }));
    mkdirSync(root); writeFileSync(join(root, ".import-token"), "partial");
    recoverAttachmentImport(path, root);
    expect(existsSync(root)).toBe(false); expect(existsSync(`${path}.attachment-import`)).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a killed importer is recovered before a fresh open", async () => {
  const home = mkdtempSync(join(tmpdir(), "a1-import-death-")), path = join(home, "session.sqlite"), root = join(home, "media");
  try {
    const modulePath = new URL("../src/state/storage/attachment-import.ts", import.meta.url).href;
    const program = `import {acquireImportLease,publishAttachmentImport} from ${JSON.stringify(modulePath)}; const path=${JSON.stringify(path)},root=${JSON.stringify(root)}; acquireImportLease(path); publishAttachmentImport(path,root,{attachmentState:{baseFormat:6,files:[{metadata:{id:${JSON.stringify(id)}},bytes:Uint8Array.of(1)}]}},()=>process.kill(process.pid,"SIGKILL"));`;
    const child = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).not.toBe(0);
    expect(existsSync(`${path}.attachment-import`)).toBe(true);
    const opened = createSqliteStorageAdapter(path, { mediaRoot: root }).open({ mode: "open", identity: { sessionId: "s", compatibilityKey: "k" } });
    expect(opened).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(existsSync(path)).toBe(false); expect(existsSync(root)).toBe(false); expect(existsSync(`${path}.attachment-import`)).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 10000);

test("a killed importer after database publication preserves the published files", async () => {
  const home = mkdtempSync(join(tmpdir(), "a1-import-published-")), path = join(home, "session.sqlite"), root = join(home, "media");
  try {
    const modulePath = new URL("../src/state/storage/attachment-import.ts", import.meta.url).href;
    const fixture = new URL("./fixtures/attachments-rh4/format-8.sqlite", import.meta.url).pathname;
    const program = `import {copyFileSync} from 'node:fs'; import {acquireImportLease,publishAttachmentImport} from ${JSON.stringify(modulePath)}; const path=${JSON.stringify(path)},root=${JSON.stringify(root)}; acquireImportLease(path); publishAttachmentImport(path,root,{attachmentState:{baseFormat:6,files:[{metadata:{id:${JSON.stringify(id)}},bytes:Uint8Array.of(1)}]}},()=>{copyFileSync(${JSON.stringify(fixture)},path); process.kill(process.pid,"SIGKILL")});`;
    const child = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).not.toBe(0);
    expect(existsSync(`${path}.attachment-import`)).toBe(true);
    const opened = createSqliteStorageAdapter(path, { mediaRoot: root }).open({ mode: "open", identity: { sessionId: "a1-rh4-fixture", compatibilityKey: "test" } });
    if (!opened.ok) throw Error(JSON.stringify(opened.error));
    try { expect(existsSync(join(root, id))).toBe(true); expect(existsSync(`${path}.attachment-import`)).toBe(false); }
    finally { opened.value.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 10000);
