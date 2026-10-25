import type { MediaCaptureLevel } from "./capture.ts";
import type { MediaStore } from "./store.ts";
import { isMediaPart, mediaMention, type ResolvedPart } from "./parts.ts";
import type { PersistedContent, PersistedContentBlock, PersistenceJsonValue } from "../persistence/backend.ts";

/** Keys whose values are bytes or store handles: never search text. */
const NON_TEXT_KEYS = new Set(["data", "blob", "bytes", "ref", "refs", "sha256"]);

/** The searchable text of recorded content. Media blocks have none: their metadata has its own search. */
export function contentText(content: PersistedContent | undefined): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map((block) => {
    switch (block.type) {
      case "text":
      case "pasted":
        return block.text;
      case "image":
        return block.alt ?? "";
      case "resource":
        return [block.title, block.text].filter(Boolean).join("\n");
      case "media":
        return "";
      default:
        return jsonText(block.value);
    }
  }).filter(Boolean).join("\n");
}

function jsonText(value: PersistenceJsonValue | undefined): string {
  return value === undefined
    ? ""
    : JSON.stringify(value, (key, child) => (NON_TEXT_KEYS.has(key) ? undefined : child));
}

/**
 * Reuse of kept copies across the revisions of one assistant message: a part already stored keeps its
 * ref. Refs found during a transaction are added to `cache` only after it commits.
 */
export interface StoredPartCache {
  readonly cache: WeakMap<object, string>;
  readonly pending: Array<readonly [object, string]>;
}

/**
 * Build the byte-free blocks a record holds, storing the copies that are kept. This is where the
 * `media` capture level and each part's `keep` and `record` are applied. With a backend store, call
 * it inside the record's transaction so the bytes and the record commit together.
 */
export async function persistParts(
  parts: readonly ResolvedPart[],
  owner: string,
  store?: MediaStore,
  capture: MediaCaptureLevel = "content",
  reuse?: StoredPartCache,
): Promise<PersistedContent> {
  const blocks: PersistedContentBlock[] = [];
  for (const part of parts) {
    if (part.record === false) continue;
    if (!isMediaPart(part)) {
      blocks.push(part.kind === "text"
        ? { type: "text", text: part.text }
        : { type: "pasted", text: part.text, ...(part.name ? { name: part.name } : {}) });
      continue;
    }
    // A part's own `keep` wins over the capture level.
    if (capture === "none" && part.keep === undefined) continue;
    const keep = part.mode === "copy" && (part.keep ?? (capture === "content" && Boolean(store)));
    let ref: string | undefined;
    if (keep) {
      if (!store) throw new Error("keep: true requires a media store");
      ref = part.ref ?? reuse?.cache.get(part) ?? await store.put(part.data!, {
        owner,
        kind: part.kind,
        mimeType: part.mimeType,
        ...(part.name ? { name: part.name } : {}),
        size: part.data!.byteLength,
        sha256: part.sha256!,
      });
      reuse?.pending.push([part, ref]);
    }
    blocks.push({
      type: "media",
      kind: part.kind,
      mode: part.mode,
      mimeType: part.mimeType,
      ...(part.name ? { name: part.name } : {}),
      ...(part.size !== undefined ? { size: part.size } : {}),
      ...(part.sha256 ? { sha256: part.sha256 } : {}),
      ...(ref ? { ref } : {}),
      ...(part.uri ? { uri: part.uri } : {}),
    });
  }
  return blocks.every((block) => block.type === "text")
    ? blocks.map((block) => (block.type === "text" ? block.text : "")).join("")
    : blocks;
}

/**
 * Restore recorded content for delivery. Links are never opened by the library. A copy whose bytes
 * were not kept, or were deleted since, is named instead of sent.
 */
export async function contentParts(content: PersistedContent, store?: MediaStore): Promise<readonly ResolvedPart[]> {
  if (typeof content === "string") return content ? [{ kind: "text", text: content }] : [];
  const parts: ResolvedPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ kind: "text", text: block.text });
    } else if (block.type === "pasted") {
      parts.push({ kind: "pasted", text: block.text, ...(block.name ? { name: block.name } : {}) });
    } else if (block.type !== "media") {
      const text = contentText([block]);
      if (text) parts.push({ kind: "text", text });
    } else if (block.mode === "link") {
      parts.push({
        kind: block.kind,
        mode: "link",
        uri: block.uri!,
        mimeType: block.mimeType,
        name: block.name,
        size: block.size,
      });
    } else {
      const stored = block.ref ? await store?.get(block.ref) : undefined;
      if (!stored) {
        parts.push({ kind: "text", text: mediaMention(block, "not available") });
        continue;
      }
      parts.push({
        kind: block.kind,
        mode: "copy",
        data: stored.data,
        ref: stored.ref,
        mimeType: block.mimeType,
        name: block.name,
        size: block.size,
        sha256: block.sha256,
      });
    }
  }
  return parts;
}
