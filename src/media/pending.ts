import type { PersistedContent } from "../persistence/backend.ts";
import type { MediaCaptureLevel } from "./capture.ts";
import { createHash } from "node:crypto";
import type { MediaStore } from "./store.ts";
import type { ResolvedPart } from "./parts.ts";

/** Pending delivery bytes are temporary transport state, never message/audit content. */
export async function stagePendingParts(store: MediaStore | undefined, owner: string, recordId: string, parts: readonly ResolvedPart[], content: PersistedContent, capture: MediaCaptureLevel): Promise<void> {
  if (!store || !parts.some((part) => part.kind !== "text" || part.record === false)) return;
  const media = typeof content === "string" ? [] : content.filter((block) => block.type === "media");
  let index = 0;
  const serialized = parts.map((part) => {
    if (part.kind === "text" || part.kind === "pasted") return part;
    const block = part.record !== false && (capture !== "none" || part.keep !== undefined) ? media[index++] : undefined;
    if (block?.ref) { const { data: _data, ...rest } = part; return { ...rest, ref: block.ref }; }
    return part.data ? { ...part, data: Buffer.from(part.data).toString("base64") } : part;
  });
  const data = new TextEncoder().encode(JSON.stringify(serialized));
  await store.put(data, { owner, kind: "file", mimeType: "application/vnd.acp-lib.pending-parts+json",
    size: data.byteLength, sha256: createHash("sha256").update(data).digest("hex"), pendingFor: recordId });
}
export async function loadPendingParts(store: MediaStore | undefined, owner: string, recordId: string): Promise<readonly ResolvedPart[] | undefined> {
  const pending = (await store?.list(owner))?.find((entry) => entry.info.pendingFor === recordId);
  if (!pending) return undefined;
  const value = await store!.get(pending.ref);
  if (!value) throw new Error(`pending media was removed: ${recordId}`);
  const parts = JSON.parse(new TextDecoder().decode(value.data)) as Array<Record<string, unknown>>;
  return Promise.all(parts.map(async (part) => {
    if (typeof part.data === "string") return { ...part, data: new Uint8Array(Buffer.from(part.data, "base64")) };
    if (part.mode === "copy" && typeof part.ref === "string") {
      const original = await store!.get(part.ref);
      if (!original) throw new Error(`media bytes are unavailable for delivery: ${part.ref}`);
      return { ...part, data: original.data };
    }
    return part;
  })) as Promise<ResolvedPart[]>;
}
export async function deletePendingParts(store: MediaStore | undefined, owner: string, recordIds: readonly string[]): Promise<void> {
  const ids = new Set(recordIds);
  for (const entry of await store?.list(owner) ?? []) {
    if (entry.info.pendingFor && ids.has(entry.info.pendingFor)) await store!.delete(entry.ref);
  }
}
