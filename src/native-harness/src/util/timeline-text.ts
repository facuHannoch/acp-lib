import { isTimelineTool } from "./timeline-tool-names.ts";
import type { TimelineEntry } from "../contracts/storage.ts";
import type { RetrievedMessage, TimelineSearch } from "../contracts/timeline-retrieval.ts";

export const timelineMessageId = (entry: TimelineEntry) => entry.itemId ? `item:${entry.itemId}` : entry.messageId ?? String(entry.seq);

export function retrievalMessage(entry: TimelineEntry): RetrievedMessage | undefined {
  const message = entry.message;
  const participant = entry.kind === "participant_message" && message.role === "user";
  if (!participant && (message.role !== "assistant" || !message.content)) return;
  const text = participant ? message.content.slice(`Participant: ${JSON.stringify(entry.from)}\n\n`.length) : message.content!;
  return { seq: entry.seq, message_id: timelineMessageId(entry), channel: entry.channelId, sender: entry.from, at: entry.at, text };
}

export function timelineTokens(text: string) {
  return Array.from(text.normalize("NFC").matchAll(/[\p{L}\p{M}\p{N}]+/gu), match => ({
    exact: match[0], folded: match[0].toLowerCase().normalize("NFC"),
  }));
}

export const timelineTokenLimit = 256;
export const timelineBytes = (text: string) => Buffer.byteLength(text);
export const encodedTimelineToken = (word: string) => `x${Buffer.from(word).toString("hex")}`;

export function timelineIndexText(text: string): string {
  return timelineTokens(text).flatMap(({ folded }) => timelineBytes(folded) <= timelineTokenLimit
    ? [encodedTimelineToken(folded)] : []).join(" ");
}

export function timelineQuery(input: TimelineSearch) {
  if (timelineBytes(input.query) > 1024) return;
  const words = timelineTokens(input.query);
  if (words.length === 0 || words.length > 32 ||
    words.some(({ exact, folded }) => timelineBytes(exact) > timelineTokenLimit || timelineBytes(folded) > timelineTokenLimit)) return;
  return words;
}

/** Every eligible start counts, including overlapping phrase matches. */
export function scoreTimeline(words: readonly string[], query: readonly string[], phrase: boolean): { score: number; first: number } {
  const unique = new Set(query);
  let score = 0, first = -1;
  for (let index = 0; index < words.length; index++) {
    const qualifies = phrase ? query.every((word, offset) => words[index + offset] === word) : unique.has(words[index]!);
    if (!qualifies) continue;
    if (first < 0) first = index;
    score++;
  }
  if (!phrase) {
    const present = new Set(words);
    if ([...unique].some(word => !present.has(word))) return { score: 0, first: -1 };
  }
  return { score: Math.min(score, 255), first };
}

/** Historical candidates already contain only conversation messages. Strip
 * retrieval calls from text-bearing mixed assistant records before charging. */
export function historicalRetrievalProjection(message: TimelineEntry["message"]): TimelineEntry["message"] {
  if (message.role !== "assistant" || !message.calls.some(call => isTimelineTool(call.name))) return message;
  return { ...message, calls: message.calls.filter(call => !isTimelineTool(call.name)) };
}
