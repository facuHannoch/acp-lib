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
