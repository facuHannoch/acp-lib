import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { projectVisionParts, readVerifiedImage, VisionInputError } from "../src/capabilities/attachments/vision.ts";
const image = Buffer.from("fixture image");
const metadata = { id: "image", channel: "a", filename: "a.png", mediaType: "image/png", bytes: image.length, sha256: createHash("sha256").update(image).digest("hex") };
const parts = [{ type: "text" as const, text: "before" }, { type: "attachment" as const, id: "image" }, { type: "text" as const, text: "after" }];
test("vision projection preserves order and fails rather than dropping unavailable image bytes", () => {
  const result = projectVisionParts(parts, () => metadata, reference => readVerifiedImage(reference, () => image).toString());
  expect(result.map(part => part.type)).toEqual(["text", "image_url", "text"]);
  expect(() => readVerifiedImage(metadata, () => Buffer.from("corrupt"))).toThrow(VisionInputError);
  try { readVerifiedImage(metadata, () => Buffer.from("corrupt")); throw Error("expected failure"); }
  catch (error) { expect(error).toMatchObject({ code: "attachment_unavailable", attachmentIds: ["image"] }); }
});
