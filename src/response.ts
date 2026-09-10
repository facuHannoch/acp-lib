import type { ResponseChunk, ResponseMessage } from "./types.ts";

export interface IncomingResponseChunk {
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
 * Fold response deltas without inventing separators. Only a change between two explicit
 * ACP message ids proves that a new assistant message started; missing ids remain part of
 * the current message because no boundary can be inferred safely.
 */
export class ResponseAccumulator {
  private readonly entries: Array<{ messageId?: string; text: string }> = [];

  append(chunk: IncomingResponseChunk): ResponseChunk {
    let current = this.entries.at(-1);
    const inferredStart =
      !current ||
      (chunk.messageId !== undefined &&
        current.messageId !== undefined &&
        chunk.messageId !== current.messageId);
    // The first observed chunk necessarily starts our first entry, even if a malformed
    // upstream callback says otherwise.
    const startsMessage = !current || (chunk.startsMessage ?? inferredStart);

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

    return chunk.messageId === undefined
      ? { text: chunk.text, startsMessage }
      : { text: chunk.text, messageId: chunk.messageId, startsMessage };
  }

  /** @deprecated Prefer `snapshot()` and preserve the distinct response messages. */
  get text(): string {
    return joinResponseMessages(this.entries);
  }

  snapshot(): readonly ResponseMessage[] {
    return Object.freeze(
      this.entries.map((entry) => Object.freeze({ ...entry })),
    );
  }
}
