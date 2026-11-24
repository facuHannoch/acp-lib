import type { AttachmentMetadata, InputPart } from "../../contracts/attachments.ts";
import { ATTACHMENT_LIMITS } from "../../contracts/attachments.ts";
import { mixedPartsSignature, validateMixedParts } from "./input.ts";

export class AttachmentAdmissionError extends Error {
  constructor(readonly code: "item_conflict" | "not_found" | "unsupported_image" | "transfer_limit", message: string) { super(message); }
}

/** Called within the session owner's single transaction. `accept` must apply
 * normal channel/lifecycle/policy checks and insert the item; `associate` must
 * persist the ordered parts and links in that transaction. Existing identities
 * are compared before checking lifecycle, file state or model capability. */
export function admitAttachmentInput<T>(input: { channel: string; identity: string; content: unknown; imageInput: boolean;
  known: () => { identity: string; value: T } | undefined;
  lookup: (id: string) => AttachmentMetadata | undefined;
  accept: (identity: string, parts: readonly InputPart[]) => T;
  associate: (value: T, parts: readonly InputPart[]) => void;
}): { value: T; duplicate: boolean } {
  const parts = validateMixedParts(input.content);
  // The caller's identity covers channel, sender and policy, while this suffix
  // makes the exact ordered part boundaries part of that identity.
  const identity = JSON.stringify([input.identity, mixedPartsSignature(parts)]);
  const known = input.known();
  if (known) {
    if (known.identity !== identity) throw new AttachmentAdmissionError("item_conflict", "Item ID already identifies different input");
    return { value: known.value, duplicate: true };
  }
  let images = 0, bytes = 0;
  for (const part of parts) if (part.type === "attachment") {
    const metadata = input.lookup(part.id);
    if (!metadata || metadata.channel !== input.channel) throw new AttachmentAdmissionError("not_found", "Unknown attachment");
    if (metadata.mediaType.startsWith("image/")) {
      if (!input.imageInput) throw new AttachmentAdmissionError("unsupported_image", "Image input is unsupported");
      images++; bytes += metadata.bytes;
    }
  }
  if (images > ATTACHMENT_LIMITS.references || bytes > ATTACHMENT_LIMITS.imageBytesPerTurn)
    throw new AttachmentAdmissionError("transfer_limit", "Input image budget exceeded");
  const value = input.accept(identity, parts);
  input.associate(value, parts);
  return { value, duplicate: false };
}
