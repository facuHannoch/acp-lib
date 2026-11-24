import { ATTACHMENT_LIMITS, type InputPart } from "../../contracts/attachments.ts";

export class AttachmentInputError extends Error {
  constructor(readonly code: "invalid_params" | "transfer_limit", message: string) {
    super(message);
  }
}

/** Validate mixed content before looking up references. Text-only messages must
 * use the existing parser and signature, which joins parts with newlines. */
export function validateMixedParts(value: unknown): InputPart[] {
  const bad = (message: string): never => { throw new AttachmentInputError("invalid_params", message); };
  if (!Array.isArray(value) || value.length === 0) return bad("Expected ordered content parts");
  if (value.length > ATTACHMENT_LIMITS.parts) throw new AttachmentInputError("transfer_limit", "Too many content parts");
  let references = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  const parts: InputPart[] = value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return bad("Invalid content part");
    const part = entry as Record<string, unknown>;
    if (part.type === "text" && Object.keys(part).length === 2 && typeof part.text === "string" && part.text.trim().length > 0) {
      bytes += encoder.encode(part.text).length + encoder.encode("text").length;
      return { type: "text", text: part.text };
    }
    if (part.type === "attachment" && Object.keys(part).length === 2 && typeof part.id === "string" && part.id.trim().length > 0) {
      references++;
      bytes += encoder.encode(part.id).length + encoder.encode("attachment").length;
      return { type: "attachment", id: part.id };
    }
    return bad("Invalid content part");
  });
  if (!references) return bad("Mixed input must include an attachment");
  if (references > ATTACHMENT_LIMITS.references || bytes > ATTACHMENT_LIMITS.inputBytes)
    throw new AttachmentInputError("transfer_limit", "Input exceeds attachment limits");
  return parts;
}

/** Mixed identity preserves boundaries and order; legacy text signatures stay
 * on their original path. This encoding is deterministic and unambiguous. */
export function mixedPartsSignature(parts: readonly InputPart[]): string {
  return JSON.stringify(parts.map(part => part.type === "text" ? ["text", part.text] : ["attachment", part.id]));
}
