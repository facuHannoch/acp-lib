import { markCapturedMedia, type MediaCaptureLevel } from "./capture.ts";
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
export async function persistParts(parts: readonly ResolvedPart[], owner: string, store?: MediaStore, capture: MediaCaptureLevel = "content", reuse?: { cache: WeakMap<object, string>; pending: Array<readonly [object, string]> }): Promise<PersistedContent> {
  const blocks: PersistedContentBlock[] = [];
  for (const part of parts) {
    if (part.record === false) continue;
    if (part.kind === "text" || part.kind === "pasted") {
      blocks.push(part.kind === "text" ? { type: "text", text: part.text } : { type: "pasted", text: part.text, ...(part.name ? { name: part.name } : {}) });
      continue;
    }
    if (capture === "none" && part.keep === undefined) continue;
    let ref: string | undefined;
    if (part.mode === "copy" && (part.keep ?? (capture === "content" && Boolean(store)))) {
      if (!store) throw new Error("keep: true requires a media store");
      ref = part.ref ?? reuse?.cache.get(part) ?? await store.put(part.data!, { owner, kind: part.kind, mimeType: part.mimeType,
        ...(part.name ? { name: part.name } : {}), size: part.size, sha256: part.sha256! });
    }
    if (ref && reuse) reuse.pending.push([part, ref]);
    blocks.push(markCapturedMedia({ type: "media", kind: part.kind, mode: part.mode, mimeType: part.mimeType,
      ...(part.name ? { name: part.name } : {}), size: part.size,
      ...(part.sha256 ? { sha256: part.sha256 } : {}), ...(ref ? { ref } : {}),
      ...(part.uri ? { uri: part.uri } : {}),
    }));
  }
  return blocks.every((block) => block.type === "text")
    ? blocks.map((block) => block.type === "text" ? block.text : "").join("") : blocks;
}

/** Restore a recorded copy for delivery; links are never opened by the library. */
export async function contentParts(content: PersistedContent, store?: MediaStore): Promise<readonly ResolvedPart[]> {
  if (typeof content === "string") return content ? [{ kind: "text", text: content }] : [];
  const parts: ResolvedPart[] = [];
  for (const block of content) {
    if (block.type === "text" || block.type === "pasted") { parts.push({ kind: block.type, text: block.text, ...(block.type === "pasted" && block.name ? { name: block.name } : {}) }); continue; }
    if (block.type !== "media") { const text = contentText([block]); if (text) parts.push({ kind: "text", text }); continue; }
    if (block.mode === "link") { parts.push({ kind: block.kind, mode: "link", uri: block.uri!, mimeType: block.mimeType, name: block.name, size: block.size }); continue; }
    const stored = block.ref ? await store?.get(block.ref) : undefined;
    if (!stored) throw new Error(`media bytes are unavailable for delivery: ${block.name ?? block.ref ?? block.kind}`);
    parts.push({ kind: block.kind, mode: "copy", data: stored.data, ref: stored.ref, mimeType: block.mimeType,
      name: block.name, size: block.size, sha256: block.sha256 });
  }
  return parts;
}
