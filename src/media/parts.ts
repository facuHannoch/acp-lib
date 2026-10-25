/** Parts accepted for user, assistant, and out-of-band messages. */
export type MessagePart =
  | { kind: "text"; text: string; record?: false }
  | { kind: "pasted"; text: string; name?: string; record?: false }
  | MediaPart;

export type MediaKind = "image" | "audio" | "file";

/**
 * A media part has exactly one source: bytes (`data`), a file (`path`, a path or `file://` uri),
 * or a copy already kept in the media store (`ref`). `mode` says what the agent receives: a copy of
 * the content, or a link to the original. Unset, it is chosen by size.
 */
export type MediaPart = {
  kind: MediaKind;
  mimeType?: string;
  name?: string;
  mode?: "copy" | "link";
  /** Copies only: whether the bytes are kept in the media store. */
  keep?: boolean;
  /** `false`: sent to the agent, not recorded at all. */
  record?: false;
} & (
  | { data: Uint8Array; path?: never; ref?: never }
  | { path: string; data?: never; ref?: never }
  | { ref: string; data?: never; path?: never }
);

/** Size, in bytes, above which a `path` part with no `mode` goes as a link. */
export type MediaThresholds = Readonly<Partial<Record<MediaKind, number>>>;

/**
 * Text costs about 4 bytes a token, so 100 KB of a text file is about 25k tokens. Images cost by their
 * pixels, and the providers' per-image limits (about 5 MB) likely apply to the base64 form.
 */
export const DEFAULT_MEDIA_THRESHOLDS = Object.freeze({ file: 100_000, image: 3_750_000, audio: 5_000_000 });

/** A media part after its source was read and its mode decided. */
export type ResolvedMediaPart = {
  kind: MediaKind;
  mode: "copy" | "link";
  mimeType: string;
  name?: string;
  /** Unknown for a link the agent sent without one, or to a file that could not be read. */
  size?: number;
  sha256?: string;
  /** Copies: the content to send. */
  data?: Uint8Array;
  /** Links: the absolute `file://` uri of the original. */
  uri?: string;
  /** A copy already kept by this conversation. */
  ref?: string;
  keep?: boolean;
  record?: false;
};

export type ResolvedPart = Exclude<MessagePart, MediaPart> | ResolvedMediaPart;

/** SVG is XML text: it goes as a file, not as an image. */
export function mediaKind(mimeType?: string): MediaKind {
  if (mimeType?.startsWith("image/") && mimeType !== "image/svg+xml") return "image";
  if (mimeType?.startsWith("audio/")) return "audio";
  return "file";
}

export function isMediaPart<T extends MessagePart | ResolvedPart>(
  part: T,
): part is Exclude<T, { kind: "text" | "pasted" }> {
  return part.kind !== "text" && part.kind !== "pasted";
}

/** Validate source and policy before reading files or writing a store. */
export function normalizeParts(parts: readonly MessagePart[]): readonly MessagePart[] {
  return parts.map((part) => {
    if (!isMediaPart(part)) return { ...part };
    const sources = [part.data, part.path, part.ref].filter((source) => source !== undefined);
    if (sources.length !== 1) throw new Error("media requires exactly one of data, path, or ref");
    if (part.mode !== undefined && part.mode !== "copy" && part.mode !== "link") {
      throw new Error("media mode must be copy or link");
    }
    if (part.data !== undefined && !(part.data instanceof Uint8Array)) {
      throw new Error("media data must be a Uint8Array");
    }
    if (part.path !== undefined && (typeof part.path !== "string" || !part.path.trim())) {
      throw new Error("media path cannot be blank");
    }
    if (part.ref !== undefined && (typeof part.ref !== "string" || !part.ref.trim())) {
      throw new Error("media ref cannot be blank");
    }
    if (part.keep !== undefined && typeof part.keep !== "boolean") throw new Error("media keep must be boolean");
    // Only a file can be pointed to: bytes and kept copies are always copies.
    if (part.mode === "link" && !part.path) throw new Error("link media requires path");
    if (part.mode === "link" && part.keep !== undefined) throw new Error("keep is only valid for copies");
    if (part.record === false && part.keep !== undefined) throw new Error("record: false cannot specify keep");
    return { ...part, kind: part.mimeType === "image/svg+xml" ? "file" : part.kind };
  });
}

/**
 * The text parts, concatenated as they are sent: text parts are segments of one text (separators
 * between combined messages are their own text parts), so nothing is inserted between them.
 */
export function partsText(parts: readonly MessagePart[] | readonly ResolvedPart[]): string {
  return parts.map((part) => (isMediaPart(part) ? "" : part.text)).join("");
}

/** Compact text-only view for the older JSONL transcript, which has no media store. */
export function transcriptParts(parts: readonly (MessagePart | ResolvedPart)[]): string {
  return parts
    .filter((part) => part.record !== false)
    .map((part) => (isMediaPart(part) ? mediaMention(part) : part.text))
    .join("\n");
}

/** How a media part is named in text: `[image plot.png]`. */
export function mediaMention(part: { kind: MediaKind; name?: string }, note?: string): string {
  return `[${part.kind}${part.name ? ` ${part.name}` : ""}${note ? `: ${note}` : ""}]`;
}

/** Object-form text is an optional leading part when structured parts are supplied. */
export function promptParts(
  input: { readonly text?: string; readonly parts?: readonly MessagePart[] },
): readonly MessagePart[] | undefined {
  if (!input.parts) return undefined;
  return [...(input.text ? [{ kind: "text" as const, text: input.text }] : []), ...input.parts];
}

/**
 * The input form of already resolved parts, to send them through a client: copies carry their bytes
 * and links their uri, so resolving them again reads nothing and decides nothing new.
 */
export function unresolvedParts(parts: readonly ResolvedPart[]): readonly MessagePart[] {
  return parts.map((part): MessagePart => {
    if (!isMediaPart(part)) return part;
    const common = {
      kind: part.kind,
      mimeType: part.mimeType,
      ...(part.name !== undefined ? { name: part.name } : {}),
      ...(part.record === false ? { record: false as const } : {}),
    };
    return part.mode === "link"
      ? { ...common, mode: "link", path: part.uri! }
      : { ...common, mode: "copy", data: part.data!, ...(part.keep !== undefined ? { keep: part.keep } : {}) };
  });
}
