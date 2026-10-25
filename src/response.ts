import type { ResponseChunk, ResponseMessage } from "./types.ts";
import type { ResolvedPart } from "./media/parts.ts";

export interface IncomingResponseChunk {
  part?: ResolvedPart;
  text: string;
  messageId?: string;
  /** Supplied when an upstream client already resolved the boundary. */
  startsMessage?: boolean;
}

/**
 * Explicitly flatten structured response messages using a separator chosen by the
 * consumer. This is a display conversion; it does not alter the messages themselves.
 */
export function formatResponseMessages(
  messages: readonly ResponseMessage[],
  separator: string,
): string {
  if (typeof separator !== "string") throw new TypeError("response message separator must be a string");
  return messages.map((message) => message.text).join(separator);
}

/**
 * Produce the legacy combined-text view without erasing protocol message boundaries.
 * Message text is preserved verbatim; the only inserted content is the boundary between
 * entries. Empty entries therefore participate in the literal join rather than being
 * silently removed.
 *
 * @deprecated Use the canonical message array, or call `formatResponseMessages` with an
 * explicit consumer-selected separator.
 */
export function joinResponseMessages(messages: readonly ResponseMessage[]): string {
  return formatResponseMessages(messages, "\n\n");
}

/**
 * Fold response deltas without inventing separators. A new assistant message starts when the
 * explicit ACP message id changes, or after `closeMessage()` (a tool call ended the text before
 * it). Otherwise missing ids remain part of the current message: no boundary can be inferred.
 */
export class ResponseAccumulator {
  private readonly entries: Array<{ messageId?: string; text: string; parts?: ResolvedPart[] }> = [];
  private closed = false;

  /** End the current message: the next chunk starts a new one, whatever its id. */
  closeMessage(): void {
    if (this.entries.length > 0) this.closed = true;
  }

  append(chunk: IncomingResponseChunk): ResponseChunk {
    let current = this.entries.at(-1);
    const inferredStart =
      !current ||
      (chunk.messageId !== undefined &&
        current.messageId !== undefined &&
        chunk.messageId !== current.messageId);
    // The first observed chunk necessarily starts our first entry, even if a malformed
    // upstream callback says otherwise.
    const startsMessage = !current || this.closed || (chunk.startsMessage ?? inferredStart);
    this.closed = false;

    if (startsMessage) {
      current = chunk.messageId === undefined
        ? { text: chunk.text }
        : { messageId: chunk.messageId, text: chunk.text };
      this.entries.push(current);
    } else {
      const entry = current!;
      if (entry.messageId === undefined && chunk.messageId !== undefined) {
        entry.messageId = chunk.messageId;
      }
      entry.text += chunk.text;
    }

    // A message keeps parts once it has media: its text before the first media part becomes the first
    // text part, and later text extends the last text part.
    const entry = this.entries.at(-1)!;
    if (chunk.part) {
      if (!entry.parts) {
        const earlier = entry.text.slice(0, entry.text.length - chunk.text.length);
        entry.parts = earlier && !startsMessage ? [{ kind: "text", text: earlier }] : [];
      }
      entry.parts.push(chunk.part);
    } else if (entry.parts && chunk.text) {
      const last = entry.parts.at(-1);
      if (last?.kind === "text") entry.parts[entry.parts.length - 1] = { ...last, text: last.text + chunk.text };
      else entry.parts.push({ kind: "text", text: chunk.text });
    }
    return chunk.messageId === undefined
      ? { text: chunk.text, startsMessage, ...(chunk.part ? { part: chunk.part } : {}) }
      : { text: chunk.text, messageId: chunk.messageId, startsMessage, ...(chunk.part ? { part: chunk.part } : {}) };
  }

  /** @deprecated Prefer `snapshot()` and preserve the distinct response messages. */
  get text(): string {
    return joinResponseMessages(this.entries);
  }

  /** The parts of the message being received, when it has any media. */
  currentParts(): readonly ResolvedPart[] | undefined {
    const parts = this.entries.at(-1)?.parts;
    return parts ? Object.freeze([...parts]) : undefined;
  }

  snapshot(): readonly ResponseMessage[] {
    return Object.freeze(
      this.entries.map((entry) => Object.freeze({
        ...entry,
        ...(entry.parts ? { parts: Object.freeze([...entry.parts]) } : {}),
      })),
    );
  }
}
