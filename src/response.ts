import type { ResponseChunk, ResponseMessage } from "./types.ts";

export interface IncomingResponseChunk {
  text: string;
  messageId?: string;
  /** Supplied when an upstream client already resolved the boundary. */
  startsMessage?: boolean;
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

  get text(): string {
    return this.entries.map((entry) => entry.text).join("");
  }

  snapshot(): readonly ResponseMessage[] {
    return Object.freeze(
      this.entries.map((entry) => Object.freeze({ ...entry })),
    );
  }
}
