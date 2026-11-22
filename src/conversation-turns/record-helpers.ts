/**
 * Pure helpers the turn path uses to shape records, moved unchanged from `agent-session.ts`
 * (controller-interface spec, Brief A2 step 1). `agent-session.ts` imports the ones it still uses.
 */
import { attachmentParts } from "../media/acp.ts";
import { transcriptParts, type MessagePart } from "../media/parts.ts";
import type { MeteredOperationKind } from "../metering/record.ts";
import type { PersistenceJsonValue } from "../persistence/backend.ts";
import type { OperationKind } from "../persistence/records.ts";
import type {
  Attachment,
  ResponseMessage,
  PromptResult,
} from "../types.ts";

/** The older JSONL transcript has no media store: a message with parts keeps a line per part. */
export function legacyTranscriptText(
  text: string,
  parts?: readonly MessagePart[],
  attachments?: readonly Attachment[],
): string {
  if (!parts && !attachments?.length) return text;
  return transcriptParts([...(parts ?? [{ kind: "text", text }]), ...attachmentParts(attachments)]);
}

/** The older JSONL transcript's view of response messages, with a line per media part. */
export function legacyTranscriptMessages(messages: readonly ResponseMessage[], text: string) {
  const messageText = (message: ResponseMessage) => (message.parts ? transcriptParts(message.parts) : message.text);
  return {
    text: messages.some((message) => message.parts) ? messages.map(messageText).join("\n\n") : text,
    messages: messages.map((message) => ({
      ...(message.messageId ? { messageId: message.messageId } : {}),
      text: messageText(message),
    })),
  };
}

export function persistenceOperationKind(kind: MeteredOperationKind): OperationKind {
  if (kind === "internal_command") return "internal_session_command";
  if (
    kind === "conversation_checkpoint"
    || kind === "conversation_recovery"
    || kind === "identity_update"
  ) return "other";
  return kind;
}

export function toPersistenceJsonValue(value: unknown): PersistenceJsonValue {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : JSON.parse(serialized) as PersistenceJsonValue;
}

export function snapshotConsumerMetadata(
  value: PersistenceJsonValue | undefined,
  owned: boolean,
): PersistenceJsonValue | undefined {
  if (value === undefined) return undefined;
  if (!owned) throw new Error("consumerMetadata requires an Agent-owned conversation");
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("consumerMetadata must be a JSON value");
  return JSON.parse(serialized) as PersistenceJsonValue;
}

/** Do not let one notification observer mutate the PromptResult another observer sees. */
export function copyPromptResult(result: PromptResult): PromptResult {
  const messages = result.messages ?? (result.text ? [{ text: result.text }] : []);
  return Object.freeze({
    ...result,
    messages: Object.freeze(
      messages.map((message) => Object.freeze({ ...message })),
    ),
    usage: result.usage ? Object.freeze({ ...result.usage }) : null,
  });
}
