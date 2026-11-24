import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: paid web dispatch survives lost result and atomically stores result usage`, () => {
  const dir = mkdtempSync(join(tmpdir(), "web-evidence-"));
  try {
    const adapter = kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(dir, "db"));
    const identity = { sessionId: "s", compatibilityKey: "k" };
    const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }) => { if (!r.ok) throw Error(r.error.message); return r.value; };
    let session = must(adapter.open({ mode: "create", identity }));
    must(session.acceptItem({ kind: "participant_message", channelId: "a", senderId: "p", text: "go", itemId: "input" }));
    const turn = must(session.beginTurn("a"))!.turn.turnId;
    must(session.appendMessage(turn, { role: "assistant", content: null, calls: [{ id: "c1", name: "web_search", arguments: "{}" }, { id: "c2", name: "web_fetch", arguments: "{}" }] }));
    expect(session.markToolDispatched(turn, "c1", { backend: "exa", operation: "web_fetch", paid: true })).toMatchObject({ ok: false });
    expect(must(session.snapshot()).session.formatVersion).toBe(6);
    must(session.markToolDispatched(turn, "c1", { backend: "exa", operation: "web_search", paid: true }));
    must(session.appendMessage(turn, { role: "tool", callId: "c1", content: "{}", usage: { requestId: "r", usd: 0 } }));
    must(session.markToolDispatched(turn, "c2", { backend: "exa", operation: "web_fetch", paid: true }));
    expect(must(session.snapshot()).session.formatVersion).toBe(10);
    session.close(); session = must(adapter.open({ mode: "open", identity }));
    const restored = must(session.snapshot());
    expect(restored.webDispatches).toEqual([{ turnId: turn, callId: "c1", evidence: { backend: "exa", operation: "web_search", paid: true } }, { turnId: turn, callId: "c2", evidence: { backend: "exa", operation: "web_fetch", paid: true } }]);
    expect(restored.timeline.find(entry => entry.message.role === "tool")?.message).toMatchObject({ usage: { requestId: "r", usd: 0 } });
    expect(restored.turns[0]?.state).toMatchObject({ status: "interrupted", uncertainCallIds: ["c2"] });
    const archive = must(session.exportArchive());
    expect(archive.archiveVersion).toBe(9);
    expect(archive.webState).toEqual({ baseFormat: 6 });
    session.close();
    const destination = kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(dir, "copy"));
    must(destination.importArchive(archive));
    const imported = must(destination.open({ mode: "open", identity }));
    expect(must(imported.snapshot()).webDispatches).toEqual(restored.webDispatches);
    imported.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("format 10 archives R-H4 routines and retained attachments, in either activation order", async () => {
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const { createUploadManager } = await import("../src/capabilities/attachments/upload.ts");
  const { readAttachment } = await import("../src/capabilities/attachments/read.ts");
  const { encodeSessionFile, decodeSessionFile } = await import("../src/state/storage/session-file.ts");
  const { validateArchive } = await import("../src/state/storage/archive.ts");
  const dir = mkdtempSync(join(tmpdir(), "web-a1-rh4-"));
  const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }) => { if (!r.ok) throw Error(r.error.message); return r.value; };
  const identity = { sessionId: "a1-rh4-fixture", compatibilityKey: "test" };
  const config = { version: 1 as const, system: "test", model: { protocol: "scripted" as const, script: "test" }, defaultPolicy: "open", policies: { open: { fallback: "allow" as const, tools: {} } }, limits: { unattendedTurns: 1 } };
  try {
    for (const order of ["attachment-first", "web-first"] as const) {
      const root = join(dir, `${order}-media`), adapter = createSqliteStorageAdapter(join(dir, order), { mediaRoot: root });
      const source = JSON.parse(readFileSync(new URL("./fixtures/attachments-rh4/archive-7.json", import.meta.url), "utf8"));
      must(adapter.importArchive(source)); const session = must(adapter.open({ mode: "open", identity, config }));
      const bytes = Buffer.from("file-data"), uploads = createUploadManager({ root, validateImage() { throw Error("unexpected image"); }, publishReady: value => { must(session.registerReadyAttachment(value)); } });
      const upload = async () => { const begun = uploads.begin({ channel: "a", filename: "file.txt", mediaType: "text/plain", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }); uploads.write("a", begun.uploadId, 0, bytes.toString("base64")); return uploads.finalize("a", begun.uploadId); };
      let metadata = order === "attachment-first" ? await upload() : undefined;
      must(session.acceptItem({ kind: "participant_message", channelId: "a", senderId: "p", text: "go", itemId: `input-${order}` }));
      const turn = must(session.beginTurn("a"))!.turn.turnId;
      must(session.appendMessage(turn, { role: "assistant", content: null, calls: [{ id: "web", name: "web_search", arguments: "{}" }] }));
      must(session.markToolDispatched(turn, "web", { backend: "exa", operation: "web_search", paid: true }));
      must(session.appendMessage(turn, { role: "tool", callId: "web", content: "{}", usage: { usd: 0 } }));
      metadata ??= await upload();
      must(session.acceptItem({ kind: "participant_message", channelId: "a", senderId: "p", text: "", itemId: `file-${order}`, parts: [{ type: "attachment", id: metadata.id }] }));
      must(session.takePending(turn));
      must(session.appendMessage(turn, { role: "assistant", content: "done", calls: [] })); must(session.finishTurn(turn, { status: "completed" }));
      const archive = must(session.exportArchive()); expect(archive.archiveVersion).toBe(9); expect(archive.webState).toEqual({ baseFormat: 9 });
      expect(archive.reminderState?.guard).toBeDefined(); expect(archive.attachmentState?.files[0]?.bytes).toEqual(new Uint8Array(bytes));
      const decoded = validateArchive(decodeSessionFile(encodeSessionFile(archive, 268435456), 268435456));
      const destRoot = join(dir, `${order}-copy-media`), dest = createSqliteStorageAdapter(join(dir, `${order}-copy`), { mediaRoot: destRoot });
      must(dest.importArchive(decoded)); const reopened = must(dest.open({ mode: "open", identity, config }));
      expect(must(reopened.readSession()).formatVersion).toBe(10); expect(must(reopened.readReminder("routine"))).toMatchObject({ id: "routine" });
      const saved = must(reopened.readManagedAttachment(metadata.id));
      const page = readAttachment({ root: destRoot, channel: "a", id: metadata.id, offset: 0, lookup: () => saved && { ...saved, timelineReadable: true } });
      expect(Buffer.from(page.data, "base64")).toEqual(bytes); expect(must(reopened.snapshot()).webDispatches?.[0]?.evidence.backend).toBe("exa");
      reopened.close(); uploads.close(); session.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15000);
