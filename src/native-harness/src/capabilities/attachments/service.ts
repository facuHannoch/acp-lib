import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionStorage, StorageResult } from "../../contracts/storage.ts";
import { createUploadManager, UploadError } from "./upload.ts";
import { readAttachment, readAttachmentForInference } from "./read.ts";
import { recoverAttachmentOrphans } from "./recovery.ts";
import { mayReadAttachment } from "./selection.ts";

export class AttachmentServiceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function take<T>(result: StorageResult<T>): T {
  if (!result.ok) throw new AttachmentServiceError(result.error.code, result.error.message);
  return result.value;
}

/** Created once for the exclusive session owner. All callbacks are synchronous,
 * so publication, admission and cleanup are serialized on that owner. */
export function createManagedAttachmentService(root: string, storage: SessionStorage,
  validateImage: Parameters<typeof createUploadManager>[0]["validateImage"], now: () => number = Date.now,
  fault?: (point: string) => void) {
  const existed = existsSync(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existed) { const parent = openSync(dirname(root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(parent); } finally { closeSync(parent); } }
  recoverAttachmentOrphans(root, new Set(take(storage.managedAttachmentIds())));
  const uploads = createUploadManager({ root, validateImage, publishReady(metadata) { fault?.("attachmentPublished"); take(storage.registerReadyAttachment(metadata)); fault?.("attachmentReady"); } });
  const channel = (id: string) => { if (!take(storage.readChannel(id))) throw new UploadError("not_found", "Unknown channel"); };
  const cleanup = () => {
    const before = new Date(now() - 24 * 60 * 60 * 1000).toISOString();
    let removed = 0;
    for (const metadata of take(storage.unreferencedAttachments(before))) {
      if (!take(storage.reclaimAttachment(metadata.id, before))) continue;
      // The metadata commit fences admission. If unlink fails or the process
      // dies here, owner recovery removes the now-unreferenced orphan later.
      rmSync(join(root, metadata.id), { force: true }); removed++;
    }
    if (removed) { const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
    return removed;
  };
  cleanup();
  return {
    begin(input: Parameters<typeof uploads.begin>[0]) { channel(input.channel); return uploads.begin(input); },
    status(channelId: string, id: string) { channel(channelId); return uploads.status(channelId, id); },
    write(channelId: string, id: string, offset: number, data: string) { channel(channelId); return uploads.write(channelId, id, offset, data); },
    finalize(channelId: string, id: string) { channel(channelId); return uploads.finalize(channelId, id); },
    abort(channelId: string, id: string) { channel(channelId); uploads.abort(channelId, id); },
    read(channelId: string, id: string, offset: number) {
      channel(channelId);
      return readAttachment({ root, channel: channelId, id, offset, lookup: fileId => {
        const found = take(storage.readManagedAttachment(fileId));
        return found && { ...found, timelineReadable: true };
      } });
    },
    readForInference(channelId: string, id: string) {
      channel(channelId);
      return readAttachmentForInference({ root, channel: channelId, id, lookup: fileId => {
        const found = take(storage.readManagedAttachment(fileId));
        return found && { ...found, timelineReadable: true };
      } });
    },
    async verifyForInference(channelId: string, id: string, signal: AbortSignal) {
      channel(channelId);
      const found = take(storage.readManagedAttachment(id));
      if (!found || !mayReadAttachment({ ownerChannel: found.metadata.channel, requestingChannel: channelId, timelineVisible: found.timelineVisible, timelineReadable: true }))
        throw new AttachmentServiceError("not_found", "Unknown attachment");
      await validateImage(join(root, id), found.metadata, signal);
    },
    cleanup,
    close() { uploads.close(); },
  };
}
