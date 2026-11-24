import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUploadManager, UploadError } from "../src/capabilities/attachments/upload.ts";
import { readAttachment, AttachmentReadError } from "../src/capabilities/attachments/read.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("managed upload staging", () => {
  test("publishes durable bytes before metadata, and supports offset recovery and finalize retry", async () => {
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
    const metadata = await uploads.finalize("a", uploadId);
    expect(metadata.id).toBe(attachmentId);
    expect((await uploads.finalize("a", uploadId)).id).toBe(attachmentId);
    expect(published).toBe(1);
    const lookup = () => ({ metadata, timelineVisible: false, timelineReadable: true });
    expect(Buffer.from(readAttachment({ root, channel: "a", id: attachmentId, offset: 0, lookup }).data, "base64")).toEqual(data);
    expect(() => readAttachment({ root, channel: "b", id: attachmentId, offset: 0, lookup })).toThrow(AttachmentReadError);
    expect(Buffer.from(readAttachment({ root, channel: "b", id: attachmentId, offset: 0,
      lookup: () => ({ metadata, timelineVisible: true, timelineReadable: true }) }).data, "base64")).toEqual(data);
    uploads.close();
  });
  test("refuses wrong channels and invalid digest before publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "attachment-test-")); roots.push(root);
    let published = false;
    const uploads = createUploadManager({ root, validateImage() {}, publishReady() { published = true; } });
    const { uploadId } = uploads.begin({ channel: "a", filename: "x", mediaType: "application/octet-stream", bytes: 1, sha256: "0".repeat(64) });
    expect(() => uploads.status("b", uploadId)).toThrow(UploadError);
    uploads.write("a", uploadId, 0, Buffer.from("x").toString("base64"));
    await expect(uploads.finalize("a", uploadId)).rejects.toBeInstanceOf(UploadError);
    expect(published).toBe(false);
    uploads.close();
  });
  test("abort cancels an in-flight validator before metadata publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "attachment-test-")); roots.push(root);
    const data = Buffer.from("image"), sha256 = createHash("sha256").update(data).digest("hex");
    let published = false;
    const uploads = createUploadManager({ root, validateImage: (_path, _metadata, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true });
    }), publishReady() { published = true; } });
    const { uploadId } = uploads.begin({ channel: "a", filename: "x.png", mediaType: "image/png", bytes: data.length, sha256 });
    uploads.write("a", uploadId, 0, data.toString("base64"));
    const result = uploads.finalize("a", uploadId);
    uploads.abort("a", uploadId);
    await expect(result).rejects.toThrow();
    expect(published).toBe(false);
    uploads.close();
  });
  test("idle uploads are actively reclaimed without another request", async () => {
    const root = mkdtempSync(join(tmpdir(), "attachment-test-")); roots.push(root);
    const uploads = createUploadManager({ root, idleMs: 20, validateImage() {}, publishReady() {} });
    const { uploadId } = uploads.begin({ channel: "a", filename: "x", mediaType: "text/plain", bytes: 1, sha256: "0".repeat(64) });
    await Bun.sleep(80);
    expect(readdirSync(root)).toEqual([]);
    expect(() => uploads.status("a", uploadId)).toThrow(UploadError);
    uploads.close();
  });
});
