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
  // Message capture drops only the text: media capture was applied when the parts were persisted.
  expect(captureRuntimeRecord(record, "none")).toMatchObject({ content: [{ type: "media", size: 1 }] });
  expect(captureRuntimeRecord(record, "content")).toMatchObject({ content: [{ type: "text" }, { type: "media" }] });
});
