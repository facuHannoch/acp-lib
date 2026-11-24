import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUploadManager, UploadError } from "../src/capabilities/attachments/upload.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("managed upload staging", () => {
  test("publishes durable bytes before metadata, and supports offset recovery and finalize retry", () => {
    const root = mkdtempSync(join(tmpdir(), "attachment-test-")); roots.push(root);
    const data = Buffer.from("hello attachment"), sha256 = createHash("sha256").update(data).digest("hex");
    let published = 0;
    const uploads = createUploadManager({ root, validateImage() { throw new Error("unexpected image"); }, publishReady(metadata) {
      expect(readFileSync(join(root, metadata.id))).toEqual(data); published++;
    } });
    const { uploadId, attachmentId } = uploads.begin({ channel: "a", filename: "hi.txt", mediaType: "text/plain", bytes: data.length, sha256 });
    expect(uploads.write("a", uploadId, 0, data.subarray(0, 5).toString("base64")).offset).toBe(5);
    try { uploads.write("a", uploadId, 0, data.toString("base64")); throw new Error("expected failure"); }
    catch (error) { expect(error).toBeInstanceOf(UploadError); expect((error as UploadError).expectedOffset).toBe(5); }
    expect(uploads.status("a", uploadId).offset).toBe(5);
    uploads.write("a", uploadId, 5, data.subarray(5).toString("base64"));
    expect(uploads.finalize("a", uploadId).id).toBe(attachmentId);
    expect(uploads.finalize("a", uploadId).id).toBe(attachmentId);
    expect(published).toBe(1);
    uploads.close();
  });
  test("refuses wrong channels and invalid digest before publication", () => {
    const root = mkdtempSync(join(tmpdir(), "attachment-test-")); roots.push(root);
    let published = false;
    const uploads = createUploadManager({ root, validateImage() {}, publishReady() { published = true; } });
    const { uploadId } = uploads.begin({ channel: "a", filename: "x", mediaType: "application/octet-stream", bytes: 1, sha256: "0".repeat(64) });
    expect(() => uploads.status("b", uploadId)).toThrow(UploadError);
    uploads.write("a", uploadId, 0, Buffer.from("x").toString("base64"));
    expect(() => uploads.finalize("a", uploadId)).toThrow(UploadError);
    expect(published).toBe(false);
    uploads.close();
  });
});
