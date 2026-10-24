import type { PersistedContent, PersistedContentBlock } from "../persistence/backend.ts";
export type MediaCaptureLevel = "none" | "metadata" | "content";

// Non-enumerable marker: these parts already applied defaults and explicit per-part overrides.
// It never enters SQLite, audit JSON or public history.
const preparedMedia = Symbol("preparedMedia");
export function markCapturedMedia<T extends PersistedContentBlock>(block: T): T {
  return Object.defineProperty(block, preparedMedia, { value: true });
}
export function captureMessageContent(content: PersistedContent, text: boolean, media: MediaCaptureLevel): PersistedContent {
  if (typeof content === "string") return text ? content : "";
  const blocks: PersistedContentBlock[] = [];
  for (const block of content) {
    if (block.type === "media") {
      const prepared = (block as unknown as Record<symbol, boolean>)[preparedMedia];
      if (!prepared && media === "none") continue;
      if (!prepared && media === "metadata") {
        const { ref: _ref, ...metadata } = block;
        blocks.push(metadata);
      } else blocks.push({ ...block });
    } else if (text) blocks.push(block);
  }
  return blocks.length === 0 ? "" : blocks;
}
