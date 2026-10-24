import type { MediaStore } from "./store.ts";
import type { ResolvedPart, ResolvedMediaPart } from "./parts.ts";
import type { PersistedContent, PersistedContentBlock, PersistenceJsonValue } from "../persistence/backend.ts";

export function contentText(content: PersistedContent | undefined): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map((block) => {
    if (block.type === "text" || block.type === "pasted") return block.text;
    if (block.type === "image") return block.alt ?? "";
    if (block.type === "resource") return [block.title, block.text, block.uri].filter(Boolean).join("\n");
    if (block.type === "media") return "";
    return jsonText(block.value);
  }).filter(Boolean).join("\n");
}


function jsonText(value: PersistenceJsonValue | undefined): string {
  return value === undefined ? "" : JSON.stringify(value);
}

/** Build byte-free record blocks; call inside the record transaction for a backend store. */
export async function persistParts(parts: readonly ResolvedPart[], owner: string, store?: MediaStore): Promise<PersistedContent> {
  const blocks: PersistedContentBlock[] = [];
  for (const part of parts) {
    if (part.record === false) continue;
    if (part.kind === "text" || part.kind === "pasted") {
      blocks.push(part.kind === "text" ? { type: "text", text: part.text } : { type: "pasted", text: part.text, ...(part.name ? { name: part.name } : {}) });
      continue;
    }
    let ref: string | undefined;
    if (part.mode === "copy" && (part.keep ?? Boolean(store))) {
      if (!store) throw new Error("keep: true requires a media store");
      ref = part.ref ?? await store.put(part.data!, { owner, kind: part.kind, mimeType: part.mimeType,
        ...(part.name ? { name: part.name } : {}), size: part.size, sha256: part.sha256! });
    }
    blocks.push({ type: "media", kind: part.kind, mode: part.mode, mimeType: part.mimeType,
      ...(part.name ? { name: part.name } : {}), size: part.size,
      ...(part.sha256 ? { sha256: part.sha256 } : {}), ...(ref ? { ref } : {}),
      ...(part.uri ? { uri: part.uri } : {}),
    });
  }
  return blocks.every((block) => block.type === "text")
    ? blocks.map((block) => block.type === "text" ? block.text : "").join("") : blocks;
}
