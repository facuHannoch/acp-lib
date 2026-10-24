import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { DEFAULT_MEDIA_THRESHOLDS, normalizeParts, type MessagePart, type MediaPart, type MediaThresholds, type ResolvedPart } from "./parts.ts";

export interface ResolvePartsOptions {
  cwd: string;
  thresholds?: MediaThresholds;
  capabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
}

export async function resolveParts(parts: readonly MessagePart[], options: ResolvePartsOptions): Promise<readonly ResolvedPart[]> {
  const result: ResolvedPart[] = [];
  for (const part of normalizeParts(parts)) {
    if (part.kind === "text" || part.kind === "pasted") { result.push(part); continue; }
    const media = part as MediaPart;
    if (media.ref) throw new Error("media refs require an Agent media store");
    const path = media.path === undefined ? undefined : resolve(options.cwd, media.path.startsWith("file:") ? fileURLToPath(media.path) : media.path);
    const size = path ? (await stat(path)).size : media.data!.byteLength;
    const supported = options.capabilities?.[media.kind === "file" ? "embeddedContext" : media.kind] ?? false;
    let mode = media.mode ?? (path && size > (options.thresholds?.[media.kind] ?? DEFAULT_MEDIA_THRESHOLDS[media.kind]) ? "link" : "copy");
    if (mode === "copy" && !supported) {
      if (media.mode === undefined && path) mode = "link";
      else throw new Error(`agent does not support ${media.kind} copies`);
    }
    if (mode === "link" && media.keep !== undefined) throw new Error("keep is only valid for copies");
    const data = mode === "copy" ? (path ? new Uint8Array(await readFile(path)) : new Uint8Array(media.data!)) : undefined;
    result.push({ kind: media.kind, mode, mimeType: media.mimeType ?? ((path ? Bun.file(path).type : "application/octet-stream") || "application/octet-stream"),
      name: media.name ?? (path ? basename(path) : undefined), size,
      ...(data ? { data, sha256: createHash("sha256").update(data).digest("hex") } : { uri: pathToFileURL(path!).href }),
      ...(media.record === false ? { record: false as const } : {}), ...(media.keep === undefined ? {} : { keep: media.keep }),
    });
  }
  return result;
}
