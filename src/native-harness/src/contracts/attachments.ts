/** An immutable harness-owned attachment reference, never a filesystem path. */
export type InputPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "attachment"; readonly id: string };

/** Metadata describes committed bytes. It does not grant access to them. */
export interface AttachmentMetadata {
  readonly id: string;
  readonly channel: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Metadata-only presentation of a submitted part. */
export type AttachmentViewPart = { type: "text"; text: string } |
  { type: "attachment"; id: string; text?: never; metadata?: AttachmentMetadata; unavailable?: true };

/** A provider boundary refused an image request without sending a partial one. */
export interface AttachmentFailure {
  code: "unsupported_image" | "attachment_unavailable" | "transfer_limit";
  attachmentIds: string[];
}

/** Limits apply to decoded bytes, not base64 or transport frames. */
export const ATTACHMENT_LIMITS = {
  fileBytes: 20 * 1024 * 1024,
  imageBytesPerTurn: 40 * 1024 * 1024,
  parts: 32,
  references: 8,
  inputBytes: 8 * 1024,
  chunkBytes: 512 * 1024,
  openUploads: 4,
  uploadIdleMs: 60_000,
  imageSide: 8192,
  imagePixels: 20_000_000,
} as const;

/** Project only metadata allowed by the current owner or shared timeline. */
export function attachmentView(parts: readonly InputPart[], read: ((id: string) => { ok: true; value: { metadata: AttachmentMetadata; timelineVisible: boolean } | undefined } | { ok: false }) | undefined,
  scope: { ownerChannel?: string; timeline?: boolean }): AttachmentViewPart[] {
  return parts.map(part => {
    if (part.type === "text") return { ...part };
    const result = read?.(part.id), found = result?.ok ? result.value : undefined;
    const visible = found && (scope.timeline ? found.timelineVisible : found.metadata.channel === scope.ownerChannel);
    return visible ? { ...part, metadata: found!.metadata } : { ...part, unavailable: true };
  });
}

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
