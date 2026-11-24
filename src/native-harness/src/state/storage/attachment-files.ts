import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, mkdirSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { AttachmentMetadata } from "../../contracts/attachments.ts";

export class AttachmentArchiveError extends Error {
  constructor(readonly code: "attachment_unavailable" | "transfer_limit", message: string) { super(message); }
}

/** Memory-backed sessions have no durable publication to coordinate. Their
 * fresh private root is removed on failure and becomes visible only when the
 * caller publishes the in-memory session after this function returns. */
export function writeMemoryArchiveFiles(root: string, files: readonly { metadata: AttachmentMetadata; bytes: Uint8Array }[]): void {
  mkdirSync(root, { mode: 0o700 });
  try {
    for (const file of files) {
      if (!idPattern.test(file.metadata.id)) throw new AttachmentArchiveError("attachment_unavailable", "Invalid attachment ID");
      const fd = openSync(join(root, file.metadata.id), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { let offset = 0; while (offset < file.bytes.length) { const n = writeSync(fd, file.bytes, offset, file.bytes.length - offset, offset); if (!n) throw Error("Unable to write attachment"); offset += n; } fsyncSync(fd); }
      finally { closeSync(fd); }
    }
    const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Preflight every retained file and the aggregate before allocating bytes.
 * The owner holds the session fence for the entire consistent export. */
export function readArchiveFiles(root: string, records: readonly { metadata: AttachmentMetadata; readyAt: string }[], maxBytes: number) {
    let total = 0;
    for (const { metadata } of records) {
      total += metadata.bytes;
      if (!Number.isSafeInteger(total) || total > maxBytes) throw new AttachmentArchiveError("transfer_limit", "Retained attachment bytes exceed the export limit");
    }
    for (const record of records) {
      const { metadata } = record;
      if (!idPattern.test(metadata.id)) throw new AttachmentArchiveError("attachment_unavailable", "Invalid attachment ID");
      let fd: number;
      try { fd = openSync(join(root, metadata.id), constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch { throw new AttachmentArchiveError("attachment_unavailable", `Attachment unavailable: ${metadata.id}`); }
      try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size !== metadata.bytes) throw new AttachmentArchiveError("attachment_unavailable", `Attachment unavailable: ${metadata.id}`); }
      finally { closeSync(fd); }
    }
    return records.map(({ metadata, readyAt }) => {
      let fd: number;
      try { fd = openSync(join(root, metadata.id), constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch { throw new AttachmentArchiveError("attachment_unavailable", `Attachment unavailable: ${metadata.id}`); }
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size !== metadata.bytes) throw new AttachmentArchiveError("attachment_unavailable", `Attachment unavailable: ${metadata.id}`);
        const bytes = Buffer.alloc(metadata.bytes); let offset = 0;
        while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) throw new AttachmentArchiveError("attachment_unavailable", `Attachment unavailable: ${metadata.id}`); offset += count; }
        if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw new AttachmentArchiveError("attachment_unavailable", `Attachment corrupt: ${metadata.id}`);
        return { metadata, readyAt, bytes };
      } finally { closeSync(fd); }
    });
}
