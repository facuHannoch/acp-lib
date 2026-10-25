import type { PersistedContent, PersistedContentBlock } from "../persistence/backend.ts";

export type MediaCaptureLevel = "none" | "metadata" | "content";

/**
 * Apply the message capture level to a record's content. Media blocks are left as they are: the
 * `media` capture level, and each part's own `keep` and `record`, were applied when the parts were
 * persisted (`persistParts`, the only place media blocks are built), so the record already holds
 * what was decided for them.
 */
export function captureMessageContent(content: PersistedContent, text: boolean): PersistedContent {
  if (typeof content === "string") return text ? content : "";
  const blocks: PersistedContentBlock[] = content.filter((block) => block.type === "media" || text);
  return blocks.length === 0 ? "" : blocks;
}
