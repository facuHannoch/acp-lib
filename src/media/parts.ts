/** Parts accepted for user, assistant, and out-of-band messages. */
export type MessagePart =
  | { kind: "text"; text: string; record?: false }
  | { kind: "pasted"; text: string; name?: string; record?: false }
  | MediaPart;
export type MediaKind = "image" | "audio" | "file";
export type MediaPart = {
  kind: MediaKind;
  mimeType?: string;
  name?: string;
  mode?: "copy" | "link";
  keep?: boolean;
  record?: false;
} & (
  | { data: Uint8Array; path?: never; ref?: never }
  | { path: string; data?: never; ref?: never }
  | { ref: string; data?: never; path?: never }
);
export type MediaThresholds = Readonly<Partial<Record<MediaKind, number>>>;
export const DEFAULT_MEDIA_THRESHOLDS = Object.freeze({ file: 100_000, image: 3_750_000, audio: 5_000_000 });
export type ResolvedMediaPart = {
  kind: MediaKind; mode: "copy" | "link"; mimeType: string; name?: string;
  size: number; sha256?: string; data?: Uint8Array; uri?: string; ref?: string;
  keep?: boolean; record?: false;
};
export type ResolvedPart = Exclude<MessagePart, MediaPart> | ResolvedMediaPart;

export function mediaKind(mimeType?: string): MediaKind {
  if (mimeType?.startsWith("image/") && mimeType !== "image/svg+xml") return "image";
  if (mimeType?.startsWith("audio/")) return "audio";
  return "file";
}

/** Validate source and policy before reading files or writing a store. */
export function normalizeParts(parts: readonly MessagePart[]): readonly MessagePart[] {
  return parts.map((part) => {
    if (part.kind === "text" || part.kind === "pasted") return { ...part };
    const media = part as MediaPart;
    if ([media.data !== undefined, media.path !== undefined, media.ref !== undefined].filter(Boolean).length !== 1) {
      throw new Error("media requires exactly one of data, path, or ref");
    }
    if (media.mode !== undefined && media.mode !== "copy" && media.mode !== "link") throw new Error("media mode must be copy or link");
    if (media.data !== undefined && !(media.data instanceof Uint8Array)) throw new Error("media data must be a Uint8Array");
    if (media.path !== undefined && (typeof media.path !== "string" || !media.path.trim())) throw new Error("media path cannot be blank");
    if (media.ref !== undefined && (typeof media.ref !== "string" || !media.ref.trim())) throw new Error("media ref cannot be blank");
    if (media.keep !== undefined && typeof media.keep !== "boolean") throw new Error("media keep must be boolean");
    if (media.mode === "link" && !media.path) throw new Error("link media requires path");
    if (media.mode === "link" && media.keep !== undefined) throw new Error("keep is only valid for copies");
    if (media.record === false && media.keep !== undefined) throw new Error("record: false cannot specify keep");
    return { ...media, kind: media.mimeType === "image/svg+xml" ? "file" : media.kind };
  });
}

export function partsText(parts: readonly MessagePart[] | readonly ResolvedPart[]): string {
  return parts.filter((p) => p.kind === "text" || p.kind === "pasted").map((p) => p.text).join("");
}

/** Keep provider-only wrappers around the ordered current-message parts. */
export function providerParts<T extends MessagePart | ResolvedPart>(providerText: string, text: string, parts: readonly T[]): readonly (T | { kind: "text"; text: string; record: false })[] {
  if (providerText === text) return parts;
  const marker = "<current-message>\n";
  const markerIndex = providerText.lastIndexOf(marker);
  const index = markerIndex >= 0 ? markerIndex + marker.length : providerText.lastIndexOf(text);
  if (index < 0) throw new Error("provider prompt does not contain current message");
  return [
    { kind: "text", text: providerText.slice(0, index), record: false },
    ...parts,
    { kind: "text", text: providerText.slice(index + text.length), record: false },
  ];
}

/** Compact text-only view for the older JSONL transcript, which has no media store. */
export function transcriptParts(parts: readonly (MessagePart | ResolvedPart)[]): string {
  return parts.filter((part) => part.record !== false).map((part) =>
    part.kind === "text" || part.kind === "pasted" ? part.text : `[${part.kind}${part.name ? ` ${part.name}` : ""}]`,
  ).join("\n");
}

/** Object-form text is an optional leading part when structured parts are supplied. */
export function promptParts(input: { readonly text?: string; readonly parts?: readonly MessagePart[] }): readonly MessagePart[] | undefined {
  if (!input.parts) return undefined;
  return [...(input.text ? [{ kind: "text" as const, text: input.text }] : []), ...input.parts];
}
