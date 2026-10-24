import { expect, test } from "bun:test";
import { resolveConversationRecordCapture } from "../src/persistence/backend.ts";
import { captureRuntimeRecord } from "../src/agent/record-capture.ts";
import { persistParts } from "../src/media/content.ts";
import { resolveParts } from "../src/media/store.ts";

test("media capture validates separately from record kinds", () => {
  expect(resolveConversationRecordCapture().media).toBe("content");
  expect(resolveConversationRecordCapture({ media: "metadata", message: "none" })).toMatchObject({ media: "metadata", message: "none" });
  expect(() => resolveConversationRecordCapture({ media: "raw" as never })).toThrow("invalid media");
});

test("message text and media capture are independent and explicit keep overrides defaults", async () => {
  const parts = await resolveParts([
    { kind: "text", text: "private text" },
    { kind: "image", data: new Uint8Array([1]), keep: false },
    { kind: "image", data: new Uint8Array([2]) },
  ], { cwd: ".", capabilities: { image: true } });
  const content = await persistParts(parts, "owner", undefined, "none");
  expect(content).toMatchObject([{ type: "text" }, { type: "media", size: 1 }]);
  const record = { kind: "message", content, role: "user" } as never;
  expect(captureRuntimeRecord(record, "none", "none")).toMatchObject({ content: [{ type: "media", size: 1 }] });
  const raw = { kind: "message", content: [{ type: "text", text: "text" }, { type: "media", kind: "image", mode: "copy", ref: "ref", size: 1, mimeType: "image/png" }], role: "user" } as never;
  expect(captureRuntimeRecord(raw, "content", "none")).toMatchObject({ content: [{ type: "text", text: "text" }] });
  expect(JSON.stringify(captureRuntimeRecord(raw, "none", "metadata"))).not.toContain('"ref"');
});
