import type { AttachmentFailure } from "../contracts/attachments.ts";

/** Durable reason representation allows typed recovery after process restart. */
export function attachmentFailureReason(failure: AttachmentFailure): string {
  return JSON.stringify({ attachmentFailure: failure });
}
export function parseAttachmentFailure(reason: string): AttachmentFailure | undefined {
  try {
    const value = JSON.parse(reason)?.attachmentFailure;
    if (!value || !["unsupported_image", "attachment_unavailable", "transfer_limit"].includes(value.code)
      || !Array.isArray(value.attachmentIds) || !value.attachmentIds.every((id: unknown) => typeof id === "string")) return undefined;
    return { code: value.code, attachmentIds: [...value.attachmentIds] };
  } catch { return undefined; }
}
