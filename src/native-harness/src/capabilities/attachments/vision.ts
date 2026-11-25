import { createHash } from "node:crypto";
import type { AttachmentMetadata, InputPart } from "../../contracts/attachments.ts";

export class VisionInputError extends Error {
  constructor(readonly code: "unsupported_image" | "attachment_unavailable" | "transfer_limit", message: string,
    readonly attachmentIds: readonly string[] = []) { super(message); }
}

export type AttachmentLookup = (id: string) => AttachmentMetadata | undefined;

export function imageDataPrefix(mediaType: string) { return `data:${mediaType};base64,`; }

/** Both sizing and dispatch use this projection. Only dispatch supplies URLs
 * backed by verified bytes. An absent reference is useful only in the estimate. */
export function projectVisionParts(parts: readonly InputPart[], metadata: AttachmentLookup,
  imageUrl?: (metadata: AttachmentMetadata) => string) {
  return parts.map(part => {
    if (part.type === "text") return { type: "text" as const, text: part.text };
    const reference = metadata(part.id);
    if (!reference) return { type: "text" as const, text: `[Attachment ${part.id}: unavailable]` };
    if (reference.mediaType.startsWith("image/") && imageUrl)
      return { type: "image_url" as const, image_url: { url: imageUrl(reference) } };
    return { type: "text" as const, text: `[Attachment ${reference.id}: ${reference.filename}, ${reference.mediaType}, ${reference.bytes} bytes]` };
  });
}

export function readVerifiedImage(metadata: AttachmentMetadata, read: (metadata: AttachmentMetadata) => Uint8Array) {
  const bytes = read(metadata);
  if (bytes.length !== metadata.bytes || createHash("sha256").update(bytes).digest("hex") !== metadata.sha256)
    throw new VisionInputError("attachment_unavailable", "Image bytes are unavailable", [metadata.id]);
  return bytes;
}
