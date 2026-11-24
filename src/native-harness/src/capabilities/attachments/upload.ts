import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { ATTACHMENT_LIMITS, type AttachmentMetadata } from "../../contracts/attachments.ts";

export class UploadError extends Error {
  constructor(readonly code: "invalid_params" | "transfer_limit" | "offset_mismatch" | "invalid_attachment" | "not_found", message: string,
    readonly expectedOffset?: number) { super(message); }
}

type Upload = { metadata: AttachmentMetadata; path: string; fd: number; offset: number; lastUsed: number; validation?: AbortController };
type Finalized = { channel: string; metadata: AttachmentMetadata };

/** The session owner must serialize these methods with acceptance and cleanup.
 * publishReady must commit metadata only after durable file publication, and
 * throw on failure. validateImage must verify the complete encoded image and
 * its decoded dimensions; it runs before publication. */
export function createUploadManager(options: {
  root: string;
  now?: () => number;
  validateImage: (path: string, metadata: AttachmentMetadata, signal: AbortSignal) => void | Promise<void>;
  publishReady: (metadata: AttachmentMetadata) => void;
}) {
  const existed = existsSync(options.root);
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  if (!lstatSync(options.root).isDirectory()) throw new Error("Attachment root must be a directory, not a symlink");
  if (!existed) { const parent = openSync(dirname(options.root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(parent); } finally { closeSync(parent); } }
  const now = options.now ?? Date.now;
  const uploads = new Map<string, Upload>();
  const completed = new Map<string, Finalized>();
  const finalizing = new Map<string, Promise<AttachmentMetadata>>();
  const discard = (id: string, upload: Upload) => {
    uploads.delete(id);
    upload.validation?.abort();
    closeSync(upload.fd);
    rmSync(upload.path, { force: true });
  };
  const expire = () => {
    for (const [id, upload] of uploads) if (!upload.validation && now() - upload.lastUsed >= ATTACHMENT_LIMITS.uploadIdleMs) discard(id, upload);
  };
  const get = (channel: string, id: string): Upload => {
    expire();
    const upload = uploads.get(id);
    if (!upload || upload.metadata.channel !== channel) throw new UploadError("not_found", "Unknown upload");
    upload.lastUsed = now();
    return upload;
  };
  return {
    begin(input: { channel: string; filename: string; mediaType: string; bytes: number; sha256: string }) {
      expire();
      if (uploads.size >= ATTACHMENT_LIMITS.openUploads) throw new UploadError("transfer_limit", "Too many uploads");
      if (typeof input.channel !== "string" || !input.channel.trim() || typeof input.filename !== "string" ||
        !input.filename || !input.filename.isWellFormed() || Buffer.byteLength(input.filename) > 255 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.filename) ||
        typeof input.mediaType !== "string" || input.mediaType.length > 127 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(input.mediaType) ||
        !Number.isSafeInteger(input.bytes) || input.bytes <= 0 || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256))
        throw new UploadError("invalid_params", "Invalid upload metadata");
      if (input.bytes > ATTACHMENT_LIMITS.fileBytes) throw new UploadError("transfer_limit", "File exceeds size limit");
      const id = randomUUID(), uploadId = randomUUID();
      const path = join(options.root, `.stage-${uploadId}`);
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      uploads.set(uploadId, { metadata: { id, ...input }, path, fd, offset: 0, lastUsed: now() });
      return { uploadId, attachmentId: id, offset: 0 };
    },
    status(channel: string, uploadId: string) { return { offset: get(channel, uploadId).offset }; },
    write(channel: string, uploadId: string, offset: number, data: string) {
      const upload = get(channel, uploadId);
      if (upload.validation) throw new UploadError("invalid_params", "Upload is finalizing");
      if (!Number.isSafeInteger(offset) || offset !== upload.offset) throw new UploadError("offset_mismatch", "Unexpected offset", upload.offset);
      if (typeof data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
        throw new UploadError("invalid_params", "Invalid base64");
      const bytes = Buffer.from(data, "base64");
      if (bytes.toString("base64") !== data || bytes.length === 0) throw new UploadError("invalid_params", "Invalid base64");
      if (bytes.length > ATTACHMENT_LIMITS.chunkBytes || upload.offset + bytes.length > upload.metadata.bytes)
        throw new UploadError("transfer_limit", "Chunk exceeds upload bounds");
      let written = 0;
      while (written < bytes.length) written += writeSync(upload.fd, bytes, written, bytes.length - written, upload.offset + written);
      upload.offset += bytes.length;
      return { offset: upload.offset };
    },
    async finalize(channel: string, uploadId: string): Promise<AttachmentMetadata> {
      const prior = completed.get(uploadId);
      if (prior) {
        if (prior.channel !== channel) throw new UploadError("not_found", "Unknown upload");
        return { ...prior.metadata };
      }
      const upload = get(channel, uploadId);
      const pending = finalizing.get(uploadId);
      if (pending) return pending;
      const work = (async () => {
      if (upload.offset !== upload.metadata.bytes) throw new UploadError("invalid_attachment", "Incomplete upload");
      const digest = () => {
        const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
        for (let pos = 0; pos < upload.offset;) {
          const count = readSync(upload.fd, buffer, 0, Math.min(buffer.length, upload.offset - pos), pos);
          if (!count) throw new UploadError("invalid_attachment", "Incomplete upload");
          hash.update(buffer.subarray(0, count)); pos += count;
        }
        return hash.digest("hex");
      };
      if (digest() !== upload.metadata.sha256) throw new UploadError("invalid_attachment", "Digest mismatch");
      if (upload.metadata.mediaType.startsWith("image/")) {
        const controller = new AbortController(); upload.validation = controller;
        try { await options.validateImage(upload.path, upload.metadata, controller.signal); }
        finally { upload.validation = undefined; }
        if (controller.signal.aborted || uploads.get(uploadId) !== upload) throw new UploadError("invalid_attachment", "Image validation cancelled");
      }
      const original = fstatSync(upload.fd);
      let staged: ReturnType<typeof lstatSync>;
      try { staged = lstatSync(upload.path); } catch { throw new UploadError("invalid_attachment", "Staged attachment is unavailable"); }
      if (!original.isFile() || !staged.isFile() || original.dev !== staged.dev || original.ino !== staged.ino || original.size !== upload.metadata.bytes || digest() !== upload.metadata.sha256)
        throw new UploadError("invalid_attachment", "Staged attachment changed during validation");
      fsyncSync(upload.fd);
      const target = join(options.root, upload.metadata.id);
      // Reserve the generated destination exclusively before replacing our
      // own empty reservation with the durable staging inode.
      const reservation = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      closeSync(reservation);
      renameSync(upload.path, target);
      let published: ReturnType<typeof lstatSync>;
      try { published = lstatSync(target); } catch { throw new UploadError("invalid_attachment", "Published attachment is unavailable"); }
      if (!published.isFile() || published.dev !== original.dev || published.ino !== original.ino)
        throw new UploadError("invalid_attachment", "Published attachment changed during validation");
      const directory = openSync(options.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
      // If this callback fails, the published orphan is recovered by the owner.
      // Remove the live handle so a retry cannot publish the same staging path.
      uploads.delete(uploadId); closeSync(upload.fd);
      options.publishReady(upload.metadata);
      completed.set(uploadId, { channel, metadata: upload.metadata });
      return { ...upload.metadata };
      })();
      finalizing.set(uploadId, work);
      try { return await work; } finally { finalizing.delete(uploadId); }
    },
    abort(channel: string, uploadId: string) {
      const upload = uploads.get(uploadId);
      if (!upload) {
        const done = completed.get(uploadId);
        if (done && done.channel !== channel) throw new UploadError("not_found", "Unknown upload");
        return;
      }
      if (upload.metadata.channel !== channel) throw new UploadError("not_found", "Unknown upload");
      discard(uploadId, upload);
    },
    close() { for (const [id, upload] of uploads) discard(id, upload); completed.clear(); },
  };
}
