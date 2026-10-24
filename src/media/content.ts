import type { PersistedContent, PersistenceJsonValue } from "../persistence/backend.ts";

export function contentText(content: PersistedContent | undefined): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "image") return block.alt ?? "";
    if (block.type === "resource") return [block.title, block.text, block.uri].filter(Boolean).join("\n");
    return jsonText(block.value);
  }).filter(Boolean).join("\n");
}


function jsonText(value: PersistenceJsonValue | undefined): string {
  return value === undefined ? "" : JSON.stringify(value);
}
