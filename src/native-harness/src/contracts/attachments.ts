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
