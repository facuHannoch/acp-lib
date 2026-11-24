import { mkdirSync } from "node:fs";
import type { SessionStorage, StorageResult } from "../../contracts/storage.ts";
import { createUploadManager, UploadError } from "./upload.ts";
import { readAttachment } from "./read.ts";
import { recoverAttachmentOrphans } from "./recovery.ts";

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
  validateImage: Parameters<typeof createUploadManager>[0]["validateImage"]) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  recoverAttachmentOrphans(root, new Set(take(storage.managedAttachmentIds())));
  const uploads = createUploadManager({ root, validateImage, publishReady(metadata) { take(storage.registerReadyAttachment(metadata)); } });
  const channel = (id: string) => { if (!take(storage.readChannel(id))) throw new UploadError("not_found", "Unknown channel"); };
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
    close() { uploads.close(); },
  };
}
