import { createHash } from "node:crypto";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { Attachment } from "../types.ts";
import { isMediaPart, mediaKind, type MessagePart, type ResolvedPart } from "./parts.ts";

/** What an agent's `promptCapabilities` allow beyond text and links (always allowed by ACP). */
export interface MediaCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

/** The uri of an embedded copy, which names the copy, not a file. */
export const EMBEDDED_URI_SCHEME = "attachment:///";

/** MIME types sent as an embedded text resource rather than a base64 blob. */
const TEXT_MIME_TYPES = new Set(["image/svg+xml", "application/json"]);

/** Compatibility attachments are copies whose bytes are not kept. */
export function attachmentParts(attachments: readonly Attachment[] = []): MessagePart[] {
  return attachments.map((attachment) => ({
    kind: mediaKind(attachment.mimeType),
    mimeType: attachment.mimeType,
    data: new Uint8Array(attachment.data),
    mode: "copy",
    keep: false,
  }));
}

/** Whether the agent accepts a copy of this kind. */
export function supportsCopy(kind: ResolvedPart["kind"], capabilities?: MediaCapabilities): boolean {
  if (kind === "text" || kind === "pasted") return true;
  return Boolean(capabilities?.[kind === "file" ? "embeddedContext" : kind]);
}

export function partsToAcp(parts: readonly ResolvedPart[]): ContentBlock[] {
  return parts.map((part): ContentBlock => {
    if (!isMediaPart(part)) return { type: "text", text: part.text };
    if (part.mode === "link") {
      return {
        type: "resource_link",
        uri: part.uri!,
        name: part.name ?? "file",
        mimeType: part.mimeType,
        ...(part.size !== undefined ? { size: part.size } : {}),
      };
    }
    const data = Buffer.from(part.data!).toString("base64");
    if (part.kind === "image" || part.kind === "audio") return { type: part.kind, data, mimeType: part.mimeType };
    // The content travels in the block: a `file://` uri would name a path that does not exist.
    const uri = `${EMBEDDED_URI_SCHEME}${encodeURIComponent(part.name ?? "attachment")}`;
    if (part.mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(part.mimeType)) {
      const text = new TextDecoder().decode(part.data);
      return { type: "resource", resource: { uri, mimeType: part.mimeType, text } };
    }
    return { type: "resource", resource: { uri, mimeType: part.mimeType, blob: data } };
  });
}

/** Normalize an agent content chunk without fetching resource links. */
export function acpToPart(block: ContentBlock): ResolvedPart | undefined {
  switch (block.type) {
    case "text":
      return { kind: "text", text: block.text };
    case "resource_link":
      return {
        kind: mediaKind(block.mimeType ?? undefined),
        mode: "link",
        uri: block.uri,
        name: block.name,
        mimeType: block.mimeType ?? "application/octet-stream",
        ...(block.size != null ? { size: block.size } : {}),
      };
    case "image":
    case "audio": {
      const data = new Uint8Array(Buffer.from(block.data, "base64"));
      return {
        kind: block.type === "image" && block.mimeType === "image/svg+xml" ? "file" : block.type,
        mode: "copy",
        data,
        mimeType: block.mimeType,
        size: data.byteLength,
        sha256: hashBytes(data),
      };
    }
    case "resource": {
      const resource = block.resource;
      const isText = "text" in resource;
      const data = isText
        ? new TextEncoder().encode(resource.text)
        : new Uint8Array(Buffer.from(resource.blob, "base64"));
      const name = resource.uri.split("/").at(-1) || undefined;
      return {
        kind: "file",
        mode: "copy",
        data,
        mimeType: resource.mimeType ?? (isText ? "text/plain" : "application/octet-stream"),
        ...(name ? { name } : {}),
        size: data.byteLength,
        sha256: hashBytes(data),
      };
    }
    default:
      return undefined;
  }
}

export function hashBytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** An explicit copy the agent cannot take is refused: nothing is silently dropped. */
export function assertPartCapabilities(parts: readonly ResolvedPart[], capabilities?: MediaCapabilities): void {
  for (const part of parts) {
    if (!isMediaPart(part) || part.mode === "link") continue;
    if (!supportsCopy(part.kind, capabilities)) throw new Error(`agent does not support ${part.kind} copies`);
  }
}
