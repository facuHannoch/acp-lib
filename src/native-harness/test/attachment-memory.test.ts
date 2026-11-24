import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { createManagedAttachmentService } from "../src/capabilities/attachments/service.ts";
import type { StorageResult } from "../src/contracts/storage.ts";
function take<T>(result: StorageResult<T>): T { if (!result.ok) throw Error(JSON.stringify(result.error)); return result.value; }
test("memory session retains ordered attachments and exports their temporary bytes", async () => {
  const home = mkdtempSync(join(tmpdir(), "a1-memory-")), root = join(home, "media");
  try {
    const adapter = createMemoryStorageAdapter({ mediaRoot: root }), store = take(adapter.open({ mode: "create", identity: { sessionId: "s", compatibilityKey: "k" } }));
    try {
      take(store.createChannel({ channelId: "a" }));
      let clock = Date.now();
      const service = createManagedAttachmentService(root, store, () => { throw Error("unexpected image"); }, () => clock);
      const bytes = Buffer.from("file"), sha256 = createHash("sha256").update(bytes).digest("hex");
      const upload = service.begin({ channel: "a", filename: "x", mediaType: "text/plain", bytes: bytes.length, sha256 });
      service.write("a", upload.uploadId, 0, bytes.toString("base64"));
      const metadata = await service.finalize("a", upload.uploadId);
      take(store.acceptItem({ itemId: "item", kind: "participant_message", channelId: "a", senderId: "p", text: "", parts: [{ type: "attachment", id: metadata.id }] }));
      const orphan = service.begin({ channel: "a", filename: "orphan", mediaType: "text/plain", bytes: bytes.length, sha256 });
      service.write("a", orphan.uploadId, 0, bytes.toString("base64"));
      const orphanMetadata = await service.finalize("a", orphan.uploadId);
      clock += 25 * 60 * 60 * 1000;
      expect(service.cleanup()).toBe(1);
      expect(Buffer.from(service.read("a", metadata.id, 0).data, "base64")).toEqual(bytes);
      expect(store.acceptItem({ itemId: "late", kind: "participant_message", channelId: "a", senderId: "p", text: "", parts: [{ type: "attachment", id: orphanMetadata.id }] })).toMatchObject({ ok: false, error: { code: "not_found" } });
      const turn = take(store.beginTurn("a"))!;
      expect(turn.items[0]?.parts).toEqual([{ type: "attachment", id: metadata.id }]);
      take(store.appendMessage(turn.turn.turnId, { role: "assistant", content: "done", calls: [] }));
      take(store.finishTurn(turn.turn.turnId, { status: "completed" }));
      const archive = take(store.exportArchive());
      expect(archive.attachmentState?.files[0]?.bytes).toEqual(new Uint8Array(bytes));
      const copyRoot = join(home, "copy"), copy = createMemoryStorageAdapter({ mediaRoot: copyRoot });
      take(copy.importArchive(archive));
      const restored = take(copy.open({ mode: "open", identity: { sessionId: "s", compatibilityKey: "k" } }));
      try {
        const reader = createManagedAttachmentService(copyRoot, restored, () => { throw Error("unexpected image"); });
        expect(Buffer.from(reader.read("a", metadata.id, 0).data, "base64")).toEqual(bytes);
        reader.close();
      } finally { take(restored.close()); }
      service.close();
    } finally { take(store.close()); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("withdrawn pending attachments remain owner-only and retained until a later visible association", async () => {
  const home = mkdtempSync(join(tmpdir(), "a1-scope-")), root = join(home, "media");
  try {
    const store = take(createMemoryStorageAdapter({ mediaRoot: root }).open({ mode: "create", identity: { sessionId: "s", compatibilityKey: "k" } }));
    const other = take(createMemoryStorageAdapter({ mediaRoot: join(home, "other") }).open({ mode: "create", identity: { sessionId: "other", compatibilityKey: "k" } }));
    let clock = Date.now();
    try {
      take(store.createChannel({ channelId: "a" })); take(store.createChannel({ channelId: "b" })); take(other.createChannel({ channelId: "a" }));
      const service = createManagedAttachmentService(root, store, () => {}, () => clock);
      const otherService = createManagedAttachmentService(join(home, "other"), other, () => {});
      const bytes = Buffer.from("file"), sha256 = createHash("sha256").update(bytes).digest("hex");
      const upload = service.begin({ channel: "a", filename: "x", mediaType: "text/plain", bytes: bytes.length, sha256 });
      service.write("a", upload.uploadId, 0, bytes.toString("base64")); const metadata = await service.finalize("a", upload.uploadId);
      const input = { itemId: "withdraw", kind: "participant_message" as const, channelId: "a", senderId: "p", text: "", parts: [{ type: "attachment" as const, id: metadata.id }] };
      take(store.acceptItem(input));
      expect(() => service.read("b", metadata.id, 0)).toThrow("Unknown attachment");
      take(store.withdrawItem("a", input.itemId));
      expect(() => service.read("b", metadata.id, 0)).toThrow("Unknown attachment");
      expect(() => otherService.read("a", metadata.id, 0)).toThrow("Unknown attachment");
      clock += 25 * 60 * 60 * 1000; expect(service.cleanup()).toBe(0);
      expect(Buffer.from(service.read("a", metadata.id, 0).data, "base64")).toEqual(bytes);
      take(store.acceptItem({ ...input, itemId: "visible" })); take(store.beginTurn("a"));
      expect(Buffer.from(service.read("b", metadata.id, 0).data, "base64")).toEqual(bytes);
      service.close(); otherService.close();
    } finally { take(store.close()); take(other.close()); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
