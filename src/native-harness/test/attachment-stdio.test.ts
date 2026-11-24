import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHarness } from "./helpers/stdio.ts";

test("stdio managed general-file upload, ordered push and download survive reopen", async () => {
  const home = mkdtempSync(join(tmpdir(), "a1-stdio-")), script = join(home, "scenario.jsonl");
  writeFileSync(script, [{ type: "scenario", version: 1, name: "file" }, { type: "model", content: "done" }].map(x => JSON.stringify(x)).join("\n") + "\n");
  const data = Buffer.alloc(600000, 0x5a), sha256 = createHash("sha256").update(data).digest("hex");
  let id = "";
  try {
    const first = spawnHarness({ home });
    try {
      const init = await first.client.initialize();
      expect(init.description.capabilities).toMatchObject({ managedAttachments: true, orderedParts: true });
      await first.client.createSession({ sessionId: "s", participants: [], channels: {}, channelChanges: [{ channel: "a", changeId: "a" }, { channel: "b", changeId: "b" }],
        config: { version: 1, system: "test", model: { protocol: "scripted", script }, defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } } } });
      const upload = await first.client.beginAttachment({ channel: "a", filename: "data.bin", mediaType: "application/octet-stream", bytes: data.length, sha256 });
      id = upload.attachmentId;
      await first.client.writeAttachment({ channel: "a", uploadId: upload.uploadId, offset: 0, data: data.subarray(0, 400000).toString("base64") });
      await first.client.writeAttachment({ channel: "a", uploadId: upload.uploadId, offset: 400000, data: data.subarray(400000).toString("base64") });
      expect((await first.client.finalizeAttachment({ channel: "a", uploadId: upload.uploadId })).id).toBe(id);
      await expect(first.client.readAttachment({ channel: "b", id, offset: 0 })).rejects.toMatchObject({ code: "not_found" });
      expect((await first.client.push({ channel: "a", item: { id: "msg", kind: "user_message", sender: "human", content: [{ type: "text", text: "before" }, { type: "attachment", id }, { type: "text", text: "after" }] } })).accepted).toBe(true);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const view = await first.client.reconcileChannel({ channel: "a", itemIds: ["msg"] });
        if (view.items[0]?.milestone !== "received") break;
        await Bun.sleep(10);
      }
      const shared = await first.client.readAttachment({ channel: "b", id, offset: 0 });
      expect(Buffer.from(shared.data, "base64")).toEqual(data.subarray(0, 524288));
    } finally { await first.close(); }
    const second = spawnHarness({ home });
    try {
      await second.client.initialize(); await second.client.openSession({ sessionId: "s" });
      const one = await second.client.readAttachment({ channel: "a", id, offset: 0 });
      const two = await second.client.readAttachment({ channel: "a", id, offset: one.nextOffset! });
      expect(Buffer.concat([Buffer.from(one.data, "base64"), Buffer.from(two.data, "base64")])).toEqual(data);
    } finally { await second.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 20000);
