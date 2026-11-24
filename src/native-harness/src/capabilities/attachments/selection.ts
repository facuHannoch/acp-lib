import { ATTACHMENT_LIMITS, type AttachmentMetadata, type InputPart } from "../../contracts/attachments.ts";

/** A retained association is shared only after its item appears in the timeline.
 * Withdrawn pending items remain owner-scoped, even though bytes are retained. */
export function mayReadAttachment(input: { ownerChannel: string; requestingChannel: string; timelineVisible: boolean; timelineReadable: boolean }): boolean {
  return input.requestingChannel === input.ownerChannel || (input.timelineVisible && input.timelineReadable);
}

/** Select a FIFO prefix against the complete turn's already active images.
 * A reference occurs once per part, including repeated IDs. Callers must supply
 * authoritative ready metadata after admission and retain the remainder pending. */
export function selectImageBudget<T extends { parts: readonly InputPart[] }>(
  active: readonly T[], pending: readonly T[], resolve: (id: string) => AttachmentMetadata | undefined,
): { selected: T[]; deferred: boolean; unavailable: string[]; oversized: boolean } {
  const unavailable = new Set<string>();
  const imageBytes = (item: T): number => {
    let bytes = 0;
    for (const part of item.parts) if (part.type === "attachment") {
      const metadata = resolve(part.id);
      if (!metadata) unavailable.add(part.id);
      else if (metadata.mediaType.startsWith("image/")) bytes += metadata.bytes;
    }
    return bytes;
  };
  let used = active.reduce((sum, item) => sum + imageBytes(item), 0);
  const selected: T[] = [];
  if (unavailable.size) return { selected, deferred: false, unavailable: [...unavailable], oversized: false };
  if (used > ATTACHMENT_LIMITS.imageBytesPerTurn) return { selected, deferred: false, unavailable: [], oversized: true };
  for (const item of pending) {
    const size = imageBytes(item);
    if (unavailable.size) return { selected, deferred: false, unavailable: [...unavailable], oversized: false };
    if (size > ATTACHMENT_LIMITS.imageBytesPerTurn) return { selected, deferred: false, unavailable: [], oversized: true };
    if (used + size > ATTACHMENT_LIMITS.imageBytesPerTurn) return { selected, deferred: true, unavailable: [], oversized: false };
    selected.push(item); used += size;
  }
  return { selected, deferred: false, unavailable: [], oversized: false };
}
