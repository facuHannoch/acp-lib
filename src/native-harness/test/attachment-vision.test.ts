import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { projectVisionParts, VisionInputError } from "../src/capabilities/attachments/vision.ts";
const image = Buffer.from("fixture image");
const metadata = { id: "image", channel: "a", filename: "a.png", mediaType: "image/png", bytes: image.length, sha256: createHash("sha256").update(image).digest("hex") };
const parts = [{ type: "text" as const, text: "before" }, { type: "attachment" as const, id: "image" }, { type: "text" as const, text: "after" }];
test("vision projection preserves order and fails rather than dropping unavailable image bytes", () => {
  const options = { supported: true, metadata: () => metadata, read: () => image };
  const result = projectVisionParts(parts, options);
  expect(result.map(part => part.type)).toEqual(["text", "image_url", "text"]);
  expect(() => projectVisionParts(parts, { ...options, supported: false })).toThrow(VisionInputError);
  try { projectVisionParts(parts, { ...options, read: () => Buffer.from("corrupt") }); throw Error("expected failure"); }
  catch (error) { expect(error).toMatchObject({ code: "attachment_unavailable", attachmentIds: ["image"] }); }
});
