import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { DEFAULT_MEDIA_THRESHOLDS, normalizeParts, type MessagePart, type MediaPart, type MediaThresholds, type ResolvedPart, type MediaKind, type ResolvedMediaPart } from "./parts.ts";

export interface MediaInfo {
  readonly owner: string;
  readonly kind: MediaKind;
  readonly mimeType: string;
  readonly name?: string;
  readonly size: number;
  readonly sha256: string;
}
export interface StoredMedia { readonly ref: string; readonly info: MediaInfo; }
export interface MediaStore {
  put(bytes: Uint8Array, info: MediaInfo): Promise<string>;
  get(ref: string): Promise<(StoredMedia & { readonly data: Uint8Array }) | null>;
  delete(ref: string): Promise<void>;
  list(owner: string): Promise<readonly StoredMedia[]>;
}
export interface MediaConfig { readonly store?: MediaStore; readonly thresholds?: MediaThresholds; }

export interface ResolvePartsOptions {
  cwd: string;
  owner?: string;
  store?: MediaStore;
  thresholds?: MediaThresholds;
  capabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
}

export async function resolveParts(parts: readonly MessagePart[], options: ResolvePartsOptions): Promise<readonly ResolvedPart[]> {
  const result: ResolvedPart[] = [];
  for (const part of normalizeParts(parts)) {
    if (part.kind === "text" || part.kind === "pasted") { result.push(part); continue; }
    const media = part as MediaPart;
    if (media.ref) {
      const stored = await options.store?.get(media.ref);
      if (!stored) throw new Error(`media ref is missing or removed: ${media.ref}`);
      const supported = options.capabilities?.[media.kind === "file" ? "embeddedContext" : media.kind] ?? false;
      if (!supported) throw new Error(`agent does not support ${media.kind} copies`);
      result.push({ kind: media.kind, mode: "copy", mimeType: media.mimeType ?? stored.info.mimeType,
        name: media.name ?? stored.info.name, size: stored.data.byteLength, sha256: stored.info.sha256,
        data: new Uint8Array(stored.data), ...(stored.info.owner === options.owner ? { ref: stored.ref } : {}),
        ...(media.keep === undefined ? {} : { keep: media.keep }), ...(media.record === false ? { record: false as const } : {}),
      });
      continue;
    }
    const path = media.path === undefined ? undefined : resolve(options.cwd, media.path.startsWith("file:") ? fileURLToPath(media.path) : media.path);
    const mimeType = media.mimeType ?? ((path ? Bun.file(path).type : "application/octet-stream") || "application/octet-stream");
    const kind = mimeType === "image/svg+xml" ? "file" : media.kind;
    const size = path ? (await stat(path)).size : media.data!.byteLength;
    const supported = options.capabilities?.[kind === "file" ? "embeddedContext" : kind] ?? false;
    let mode = media.mode ?? (path && size > (options.thresholds?.[kind] ?? DEFAULT_MEDIA_THRESHOLDS[kind]) ? "link" : "copy");
    if (mode === "copy" && !supported) {
      if (media.mode === undefined && path) mode = "link";
      else throw new Error(`agent does not support ${media.kind} copies`);
    }
    if (mode === "link" && media.keep !== undefined) throw new Error("keep is only valid for copies");
    const data = mode === "copy" ? (path ? new Uint8Array(await readFile(path)) : new Uint8Array(media.data!)) : undefined;
    result.push({ kind, mode, mimeType,
      name: media.name ?? (path ? basename(path) : undefined), size,
      ...(data ? { data, sha256: createHash("sha256").update(data).digest("hex") } : { uri: pathToFileURL(path!).href }),
      ...(media.record === false ? { record: false as const } : {}), ...(media.keep === undefined ? {} : { keep: media.keep }),
    });
  }
  return result;
}
