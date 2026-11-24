import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENT_LIMITS, type AttachmentMetadata } from "../../contracts/attachments.ts";
import { mayReadAttachment } from "./selection.ts";

export class AttachmentReadError extends Error {
  constructor(readonly code: "not_found" | "invalid_params" | "attachment_unavailable", message: string) { super(message); }
}

/** Resolve authorization against committed state, never against the opaque ID.
 * The session owner supplies both metadata and visibility from one coherent
 * read. Integrity is checked in bounded blocks before returning any bytes. */
export function readAttachment(input: { root: string; channel: string; id: string; offset: number;
  lookup: (id: string) => { metadata: AttachmentMetadata; timelineVisible: boolean; timelineReadable: boolean } | undefined;
}) {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new AttachmentReadError("invalid_params", "Invalid offset");
  const found = input.lookup(input.id);
  if (!found || !mayReadAttachment({ ownerChannel: found.metadata.channel, requestingChannel: input.channel,
    timelineVisible: found.timelineVisible, timelineReadable: found.timelineReadable }))
    throw new AttachmentReadError("not_found", "Unknown attachment");
  const metadata = found.metadata;
  if (input.offset > metadata.bytes) throw new AttachmentReadError("invalid_params", "Invalid offset");
  // IDs are generated UUIDs; never accept a path from storage or a caller.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(metadata.id) || metadata.id !== input.id)
    throw new AttachmentReadError("attachment_unavailable", "Invalid stored attachment identity");
  let fd: number | undefined;
  try {
    fd = openSync(join(input.root, metadata.id), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== metadata.bytes) throw new Error("Invalid length");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    for (let pos = 0; pos < metadata.bytes;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, metadata.bytes - pos), pos);
      if (!count) throw new Error("Unexpected end of file");
      hash.update(buffer.subarray(0, count)); pos += count;
    }
    if (hash.digest("hex") !== metadata.sha256) throw new Error("Digest mismatch");
    const chunk = Buffer.alloc(Math.min(ATTACHMENT_LIMITS.chunkBytes, metadata.bytes - input.offset));
    let count = 0;
    while (count < chunk.length) {
      const n = readSync(fd, chunk, count, chunk.length - count, input.offset + count);
      if (!n) throw new Error("Unexpected end of file");
      count += n;
    }
    const next = input.offset + count;
    return { metadata: { ...metadata }, data: chunk.toString("base64"), ...(next < metadata.bytes ? { nextOffset: next } : {}) };
  } catch {
    throw new AttachmentReadError("attachment_unavailable", "Attachment bytes are unavailable or corrupt");
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Inference needs the complete file; unlike paged download this allocates at
 * most one validated file (20 MiB), and verifies it in a single read pass. */
export function readAttachmentForInference(input: { root: string; channel: string; id: string;
  lookup: (id: string) => { metadata: AttachmentMetadata; timelineVisible: boolean; timelineReadable: boolean } | undefined;
}): Uint8Array {
  const found = input.lookup(input.id);
  if (!found || !mayReadAttachment({ ownerChannel: found.metadata.channel, requestingChannel: input.channel,
    timelineVisible: found.timelineVisible, timelineReadable: found.timelineReadable })) throw new AttachmentReadError("not_found", "Unknown attachment");
  const metadata = found.metadata;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(metadata.id) || metadata.id !== input.id
    || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > ATTACHMENT_LIMITS.fileBytes)
    throw new AttachmentReadError("attachment_unavailable", "Invalid stored attachment metadata");
  let fd: number | undefined;
  try {
    fd = openSync(join(input.root, metadata.id), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== metadata.bytes) throw Error("Invalid length");
    const bytes = Buffer.alloc(metadata.bytes); let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) throw Error("Unexpected end of file"); offset += n; }
    if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw Error("Digest mismatch");
    return bytes;
  } catch { throw new AttachmentReadError("attachment_unavailable", "Attachment bytes are unavailable or corrupt"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
