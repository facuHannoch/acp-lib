import { createHash } from "node:crypto";
import { ATTACHMENT_LIMITS, type AttachmentMetadata, type InputPart } from "../../contracts/attachments.ts";

export class VisionInputError extends Error {
  constructor(readonly code: "unsupported_image" | "attachment_unavailable" | "transfer_limit", message: string,
    readonly attachmentIds: readonly string[] = []) { super(message); }
}

/** Resolved bytes are ephemeral and must never be passed to capture/log hooks.
 * Caller supplies only active-turn parts. A failed projection returns no partial
 * request, and reports all unavailable image references in input order. */
export function projectVisionParts(parts: readonly InputPart[], options: { supported: boolean;
  metadata: (id: string) => AttachmentMetadata | undefined;
  read: (metadata: AttachmentMetadata) => Uint8Array;
}) {
  const resolved: Array<{ part: InputPart; metadata?: AttachmentMetadata; bytes?: Uint8Array }> = [];
  const unavailable = new Set<string>();
  let total = 0, hasImage = false;
  for (const part of parts) {
    if (part.type === "text") { resolved.push({ part }); continue; }
    const metadata = options.metadata(part.id);
    if (!metadata) { unavailable.add(part.id); continue; }
    if (!metadata.mediaType.startsWith("image/")) { resolved.push({ part, metadata }); continue; }
    hasImage = true;
    total += metadata.bytes;
    resolved.push({ part, metadata });
  }
  if (unavailable.size) throw new VisionInputError("attachment_unavailable", "Attachment metadata is unavailable", [...unavailable]);
  if (hasImage && !options.supported) throw new VisionInputError("unsupported_image", "The configured model does not support image input");
  if (total > ATTACHMENT_LIMITS.imageBytesPerTurn) throw new VisionInputError("transfer_limit", "Image request exceeds the turn budget");
  for (const entry of resolved) if (entry.metadata?.mediaType.startsWith("image/")) {
    try {
      const bytes = options.read(entry.metadata);
      if (bytes.length !== entry.metadata.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.metadata.sha256)
        throw new Error("Integrity failure");
      entry.bytes = bytes;
    } catch { unavailable.add(entry.metadata.id); }
  }
  if (unavailable.size) throw new VisionInputError("attachment_unavailable", "Image bytes are unavailable", [...unavailable]);
  return resolved.map(entry => {
    if (entry.part.type === "text") return { type: "text" as const, text: entry.part.text };
    if (!entry.bytes) return { type: "text" as const, text: `[Attachment ${entry.metadata!.id}: ${entry.metadata!.filename}, ${entry.metadata!.mediaType}, ${entry.metadata!.bytes} bytes]` };
    return { type: "image_url" as const, image_url: { url: `data:${entry.metadata!.mediaType};base64,${Buffer.from(entry.bytes).toString("base64")}` } };
  });
}
