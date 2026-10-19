import type { AgentConversationId } from "./agent-ids.ts";
import type {
  ConversationRecord,
  MessageRecord,
  PersistenceBackend,
  PersistenceJsonValue,
} from "./persistence/backend.ts";

/** Input for an assistant message a consumer appends without running a provider turn. */
export interface AppendAssistantMessageInput {
  readonly text: string;
  /** Opaque JSON stored on the record for the consumer's own use. */
  readonly consumerMetadata?: PersistenceJsonValue;
}

/** Record `metadata.origin` marking an assistant message the provider did not produce. */
export const OUT_OF_BAND_MESSAGE_ORIGIN = "out_of_band";

/** Upper bound on the provider-only block; older messages are dropped first. */
export const OUT_OF_BAND_PROMPT_MAX_CHARS = 8_000;

const RECENT_PAGE_SIZE = 50;

export function isOutOfBandMessage(record: ConversationRecord): record is MessageRecord {
  return record.kind === "message" && parseMetadata(record.metadata).origin === OUT_OF_BAND_MESSAGE_ORIGIN;
}

/**
 * Out-of-band assistant messages the provider context has not received yet.
 *
 * Everything appended before the user record of the last completed turn was composed into
 * that turn's provider text, and a recovery seed carries every canonical message through
 * `recoveredThroughSequence`. So the window starts after the later of those two points and
 * ends before the current user record, which must already be persisted: an append that
 * races this read lands either inside the window or after the current user record.
 */
export async function pendingOutOfBandMessages(
  persistence: PersistenceBackend,
  conversationId: AgentConversationId,
  targetProviderContextId: string | undefined,
  currentUserSequence: number,
): Promise<readonly MessageRecord[]> {
  const watermark = Math.max(
    await recoveredThroughSequence(persistence, conversationId, targetProviderContextId),
    await lastCompletedTurnUserSequence(persistence, conversationId, currentUserSequence),
  );
  if (watermark >= currentUserSequence - 1) return [];
  const pending: MessageRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await persistence.messages.list(conversationId, {
      afterSequence: watermark,
      throughSequence: currentUserSequence - 1,
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    for (const message of page.messages) {
      if (message.role === "assistant" && isOutOfBandMessage(message) && textOf(message)) {
        pending.push(message);
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return pending;
}

/**
 * Provider text for one turn: identity preamble, then out-of-band messages, then the user's
 * own text. Only the user's text is persisted; everything else reaches the provider alone.
 */
export function composeProviderPrompt(
  prompt: string,
  identityPreamble: string | undefined,
  outOfBand: readonly MessageRecord[],
): string {
  const sections = [identityPreamble?.trim(), formatOutOfBandBlock(outOfBand)]
    .filter((section): section is string => Boolean(section));
  if (sections.length === 0) return prompt;
  return `${sections.join("\n\n")}\n\n<current-message>\n${prompt}\n</current-message>`;
}

function formatOutOfBandBlock(messages: readonly MessageRecord[]): string | undefined {
  if (messages.length === 0) return undefined;
  const header = "Messages you sent in this conversation through another channel since your last turn."
    + " The user has seen them; you have not.";
  const entries = messages.map((message) => `[${message.timestamp}] ${textOf(message)}`);
  let budget = OUT_OF_BAND_PROMPT_MAX_CHARS - header.length;
  let kept = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const cost = entries[index]!.length + 1;
    if (cost > budget && kept > 0) break;
    budget -= cost;
    kept += 1;
  }
  const omitted = entries.length - kept;
  const body = [
    ...(omitted > 0 ? [`(${omitted} earlier message${omitted === 1 ? "" : "s"} omitted)`] : []),
    ...entries.slice(omitted),
  ];
  return `<messages-you-sent>\n${header}\n${body.join("\n")}\n</messages-you-sent>`;
}

async function recoveredThroughSequence(
  persistence: PersistenceBackend,
  conversationId: AgentConversationId,
  targetProviderContextId: string | undefined,
): Promise<number> {
  if (!targetProviderContextId) return 0;
  const active = await persistence.providerSessions.active(conversationId);
  if (active?.internalSessionId !== targetProviderContextId) return 0;
  const value = parseMetadata(active.metadata).recoveredThroughSequence;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Sequence of the user record whose turn most recently completed, or 0 when none did. */
async function lastCompletedTurnUserSequence(
  persistence: PersistenceBackend,
  conversationId: AgentConversationId,
  beforeSequence: number,
): Promise<number> {
  const records = persistence.records;
  if (records.listRecent) {
    let olderCursor: string | undefined;
    do {
      const page = await records.listRecent(conversationId, {
        kinds: ["message"],
        limit: RECENT_PAGE_SIZE,
        ...(olderCursor ? { olderCursor } : {}),
      });
      for (let index = page.records.length - 1; index >= 0; index -= 1) {
        const found = await completedTurnUserSequence(persistence, page.records[index]!, beforeSequence);
        if (found !== undefined) return found;
      }
      olderCursor = page.olderCursor;
    } while (olderCursor);
    return 0;
  }
  // Custom backends without newest-first history pay a forward scan.
  let latest = 0;
  let cursor: string | undefined;
  do {
    const page = await records.list(conversationId, {
      kinds: ["message"],
      throughSequence: beforeSequence - 1,
      ...(cursor ? { cursor } : {}),
    });
    for (const record of page.records) {
      const found = await completedTurnUserSequence(persistence, record, beforeSequence);
      if (found !== undefined) latest = Math.max(latest, found);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return latest;
}

async function completedTurnUserSequence(
  persistence: PersistenceBackend,
  record: ConversationRecord,
  beforeSequence: number,
): Promise<number | undefined> {
  if (record.kind !== "message" || record.sequence >= beforeSequence) return undefined;
  if (record.role !== "assistant" || record.status !== "completed") return undefined;
  const metadata = parseMetadata(record.metadata);
  if (metadata.origin === OUT_OF_BAND_MESSAGE_ORIGIN) return undefined;
  const operationId = metadata.operationId;
  if (typeof operationId !== "string" || !operationId) return undefined;
  const user = await persistence.records.get(`${operationId}:user`);
  return user && user.sequence < beforeSequence ? user.sequence : undefined;
}

function textOf(message: MessageRecord): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .map((block) => block.type === "text" ? block.text : "")
    .join("")
    .trim();
}

function parseMetadata(metadata: string | undefined): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const value: unknown = JSON.parse(metadata);
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
