import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hashBytes, supportsCopy, type MediaCapabilities } from "./acp.ts";
import {
  DEFAULT_MEDIA_THRESHOLDS,
  isMediaPart,
  normalizeParts,
  type MediaKind,
  type MessagePart,
  type MediaThresholds,
  type ResolvedPart,
} from "./parts.ts";

export interface MediaInfo {
  /** The conversation the copy belongs to. */
  readonly owner: string;
  readonly kind: MediaKind;
  readonly mimeType: string;
  readonly name?: string;
  readonly size: number;
  readonly sha256: string;
}

export interface StoredMedia {
  readonly ref: string;
  readonly info: MediaInfo;
}

/** Where kept copies live. The SQLite backend provides one; a consumer can pass its own. */
export interface MediaStore {
  put(bytes: Uint8Array, info: MediaInfo): Promise<string>;
  get(ref: string): Promise<(StoredMedia & { readonly data: Uint8Array }) | null>;
  delete(ref: string): Promise<void>;
  /** Every copy of one conversation, so a cleanup pass can find bytes a failed write left behind. */
  list(owner: string): Promise<readonly StoredMedia[]>;
}

export interface MediaConfig {
  /** Replaces the persistence backend's own store. */
  readonly store?: MediaStore;
  readonly thresholds?: MediaThresholds;
}

export interface ResolvePartsOptions {
  /** Relative paths resolve against it. */
  cwd: string;
  /** The conversation sending the parts: a ref it owns is reused, another one is copied. */
  owner?: string;
  store?: MediaStore;
  thresholds?: MediaThresholds;
  capabilities?: MediaCapabilities;
}

/**
 * Read each part's source and decide its mode. A `path` part with no `mode` goes as a link above its
 * kind's threshold, or when the agent cannot take a copy of its kind. An explicit copy the agent cannot
 * take is refused.
 */
export async function resolveParts(
  parts: readonly MessagePart[],
  options: ResolvePartsOptions,
): Promise<readonly ResolvedPart[]> {
  for (const [kind, threshold] of Object.entries(options.thresholds ?? {})) {
    if (!["image", "audio", "file"].includes(kind) || !Number.isSafeInteger(threshold) || threshold < 0) {
      throw new Error(`invalid media threshold for ${kind}`);
    }
  }
  const result: ResolvedPart[] = [];
  for (const part of normalizeParts(parts)) {
    if (!isMediaPart(part)) {
      result.push(part);
      continue;
    }
    if (part.ref) {
      const stored = await options.store?.get(part.ref);
      if (!stored) throw new Error(`media ref is missing or removed: ${part.ref}`);
      if (!supportsCopy(part.kind, options.capabilities)) throw new Error(`agent does not support ${part.kind} copies`);
      result.push({
        kind: part.kind,
        mode: "copy",
        mimeType: part.mimeType ?? stored.info.mimeType,
        name: part.name ?? stored.info.name,
        size: stored.data.byteLength,
        sha256: stored.info.sha256,
        data: new Uint8Array(stored.data),
        // Another conversation's copy is stored again, so each conversation owns its copies.
        ...(stored.info.owner === options.owner ? { ref: stored.ref } : {}),
        ...(part.keep === undefined ? {} : { keep: part.keep }),
        ...(part.record === false ? { record: false as const } : {}),
      });
      continue;
    }
    const path = part.path === undefined
      ? undefined
      : resolve(options.cwd, part.path.startsWith("file:") ? fileURLToPath(part.path) : part.path);
    const mimeType = part.mimeType ?? ((path ? Bun.file(path).type : "") || "application/octet-stream");
    const kind = mimeType === "image/svg+xml" ? "file" : part.kind;
    // A link is not opened by the library: a file it cannot read is the agent's to report.
    const size = path
      ? await stat(path).then((info) => info.size, (error) => {
        if (part.mode === "link") return undefined;
        throw error;
      })
      : part.data!.byteLength;
    const threshold = options.thresholds?.[kind] ?? DEFAULT_MEDIA_THRESHOLDS[kind];
    let mode = part.mode ?? (path && size! > threshold ? "link" : "copy");
    if (mode === "copy" && !supportsCopy(kind, options.capabilities)) {
      if (part.mode === undefined && path) mode = "link";
      else throw new Error(`agent does not support ${part.kind} copies`);
    }
    if (mode === "link" && part.keep !== undefined) throw new Error("keep is only valid for copies");
    let data: Uint8Array | undefined;
    if (mode === "copy") data = path ? new Uint8Array(await readFile(path)) : new Uint8Array(part.data!);
    result.push({
      kind,
      mode,
      mimeType,
      name: part.name ?? (path ? basename(path) : undefined),
      ...(data ? { size: data.byteLength } : size !== undefined ? { size } : {}),
      ...(data ? { data, sha256: hashBytes(data) } : { uri: pathToFileURL(path!).href }),
      ...(part.record === false ? { record: false as const } : {}),
      ...(part.keep === undefined ? {} : { keep: part.keep }),
    });
  }
  return result;
}
