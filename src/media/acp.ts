import { createHash } from "node:crypto";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { Attachment } from "../types.ts";
import { mediaKind, type MessagePart, type ResolvedPart } from "./parts.ts";

/** Compatibility attachments are copies whose bytes are not kept. */
export function attachmentParts(attachments: readonly Attachment[] = []): MessagePart[] {
  return attachments.map((attachment) => ({ kind: mediaKind(attachment.mimeType), mimeType: attachment.mimeType,
    data: new Uint8Array(attachment.data), mode: "copy", keep: false }));
}
export function partsToAcp(parts: readonly ResolvedPart[]): ContentBlock[] {
  return parts.map((part): ContentBlock => {
    if (part.kind === "text" || part.kind === "pasted") return { type: "text", text: part.text };
    if (part.mode === "link") return { type: "resource_link", uri: part.uri!, name: part.name ?? "file", mimeType: part.mimeType, size: part.size };
    const data = Buffer.from(part.data!).toString("base64");
    if (part.kind === "image" || part.kind === "audio") return { type: part.kind, data, mimeType: part.mimeType };
    const uri = `file:///${encodeURIComponent(part.name ?? "attachment")}`;
    if (part.mimeType.startsWith("text/") || part.mimeType === "image/svg+xml" || part.mimeType === "application/json") {
      return { type: "resource", resource: { uri, mimeType: part.mimeType, text: new TextDecoder().decode(part.data) } };
    }
    return { type: "resource", resource: { uri, mimeType: part.mimeType, blob: data } };
  });
}

/** Normalize an agent content chunk without fetching resource links. */
export function acpToPart(block: ContentBlock): ResolvedPart | undefined {
  if (block.type === "text") return { kind: "text", text: block.text };
  if (block.type === "resource_link") return { kind: mediaKind(block.mimeType ?? undefined), mode: "link",
    uri: block.uri, name: block.name, mimeType: block.mimeType ?? "application/octet-stream", size: block.size ?? 0 };
  if (block.type === "image" || block.type === "audio") {
    const data = new Uint8Array(Buffer.from(block.data, "base64"));
    return { kind: block.type === "image" && block.mimeType === "image/svg+xml" ? "file" : block.type, mode: "copy", data, mimeType: block.mimeType,
      size: data.byteLength, sha256: hashBytes(data) };
  }
  if (block.type === "resource") {
    const resource = block.resource;
    const data = "text" in resource ? new TextEncoder().encode(resource.text) : new Uint8Array(Buffer.from(resource.blob, "base64"));
    const name = resource.uri.split("/").at(-1) || undefined;
    return { kind: "file", mode: "copy", data, mimeType: resource.mimeType ?? ("text" in resource ? "text/plain" : "application/octet-stream"),
      ...(name ? { name } : {}), size: data.byteLength, sha256: hashBytes(data) };
  }
  return undefined;
}

function hashBytes(data: Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }
