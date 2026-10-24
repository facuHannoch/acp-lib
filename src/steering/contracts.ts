import type { AgentSessionPromptResult } from "../agent-conversation-contracts.ts";
import type { PersistenceJsonValue } from "../persistence/backend.ts";
import type { Attachment, PromptHandlers } from "../types.ts";

/**
 * How a prompt sent while a turn is running waits.
 *
 * - `steer`: delivered at the next tool boundary, by cancelling the running turn and sending the
 *   message (together with any other `steer` messages waiting at the head of the queue).
 * - `queue`: delivered after the running turn ends, as its own turn.
 */
export type PromptDelivery = "steer" | "queue";

/** Identifies one prompt while it waits. It is the prompt's operation id. */
export type PendingMessageId = string;

/** Why a pending message was delivered when it was. */
export type MessageDeliveryVia = "tool_boundary" | "interrupt" | "turn_end" | "stall";

/** Why a turn was cancelled. Reported only when the turn really ended cancelled. */
export type PromptEndedBy = "steer" | "interrupt" | "stalled" | "error";

export interface PendingMessage {
  readonly id: PendingMessageId;
  /** What the consumer asked for. */
  readonly delivery: PromptDelivery;
  readonly participantId?: string;
  readonly text: string;
  readonly heldBy?: string;
}

/**
 * What `prompt()` returns: the promise of that prompt's result, plus its id and a way to take it
 * back while it still waits.
 */
export interface PromptHandle extends Promise<AgentSessionPromptResult> {
  readonly id: PendingMessageId;
  /** Remove the message if it has not been delivered yet. Returns whether it was still pending. */
  withdraw(): boolean;
}

/** Events about messages that wait. They go on the conversation event stream. */
export type MessageEvent =
  | { readonly kind: "message_held"; readonly id: PendingMessageId; readonly failedTurnId: string }
  | { readonly kind: "message_released"; readonly id: PendingMessageId; readonly failedTurnId: string }
  | {
      readonly kind: "message_pending";
      readonly id: PendingMessageId;
      /** The mode in effect: `queue` while the active operation is not a consumer prompt turn. */
      readonly delivery: PromptDelivery;
    }
  | {
      readonly kind: "message_delivered";
      /** Every message sent in the prompt, in order. One id unless several were combined. */
      readonly ids: readonly PendingMessageId[];
      readonly via: MessageDeliveryVia;
      /** The operation id of the prompt (equals the first id). */
      readonly turnId: string;
    }
  | { readonly kind: "message_withdrawn"; readonly id: PendingMessageId };

/** One original message of a combined prompt. */
export interface CombinedMessage {
  readonly id: PendingMessageId;
  readonly text: string;
  readonly participantId?: string;
  readonly consumerMetadata?: PersistenceJsonValue;
}

/** @deprecated Use CombinedMessage. */
export type PromptPart = CombinedMessage;

/** The fields of a queued prompt that steering reads and writes. */
export interface SteeringPrompt {
  readonly kind: "prompt";
  readonly turnId: string;
  readonly operationKind: string;
  readonly delivery: PromptDelivery;
  /** True when it had to wait behind other work (so it emits message events). */
  readonly waited: boolean;
  text: string;
  participantId?: string;
  consumerMetadata?: PersistenceJsonValue;
  handlers?: PromptHandlers;
  attachments?: Attachment[];
  /** Present only on a combined prompt: the original messages, in order. */
  parts?: readonly CombinedMessage[];
  resolve: (result: AgentSessionPromptResult) => void;
  reject: (error: unknown) => void;
}
