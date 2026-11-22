import { nativePermissionRequests, permissionOutcome } from "../permissions/conversation.ts";
import { recordingPermissionHandlers } from "../permissions/policy.ts";
/**
 * Phase 3 of a turn: the handlers that record and present what the provider streams (assistant
 * messages, activity, permissions), wrapping the consumer's own handlers. Moved unchanged from
 * `AgentSession.runPrompt` (controller-interface spec, Brief A2 step 1). Building them is
 * synchronous; they only run once the provider call starts.
 */
import { transcriptParts, type ResolvedPart } from "../media/parts.ts";
import { ResponseAccumulator } from "../response.ts";
import type { PromptHandlers } from "../types.ts";
import type { TurnRunContext } from "./context.ts";
import {
  toPersistenceJsonValue,
} from "./record-helpers.ts";

export type AssistantStatus = "in_progress" | "completed" | "cancelled" | "error";

export interface TurnRecording {
  readonly chunks: string[];
  readonly response: ResponseAccumulator;
  /** When each message that ended before the turn did received its last text, in order. */
  readonly messageEnds: string[];
  /** How many assistant messages the turn has begun. */
  readonly assistantOrdinal: number;
  readonly handlers: PromptHandlers;
  beginAssistantMessage(providerMessageId?: string): { text: string; dirty: boolean };
  flushAssistantMessage(status: AssistantStatus, stopReason?: string, force?: boolean, ended?: boolean): void;
}

/** `consumer` are the handlers of the turn's messages, wrapped by the recording handlers. */
export function createTurnRecording(
  ctx: TurnRunContext,
  turnId: string,
  consumer: PromptHandlers | undefined,
): TurnRecording {
  const chunks: string[] = [];
  const response = new ResponseAccumulator();
  let assistantOrdinal = 0;
  let assistantMessage: {
    readonly id: string;
    providerMessageId?: string;
    text: string;
    parts?: readonly ResolvedPart[];
    revision: number;
    dirty: boolean;
  } | null = null;
  const beginAssistantMessage = (providerMessageId?: string) => {
    assistantOrdinal++;
    assistantMessage = {
      id: `message:${turnId}:assistant:${assistantOrdinal}`,
      ...(providerMessageId === undefined ? {} : { providerMessageId }),
      text: "",
      revision: 0,
      dirty: false,
    };
    return assistantMessage;
  };
  // When each message that ended before the turn did received its last text, in order. The
  // turn's commit records those messages as completed at these times; only the last message
  // takes the turn's own outcome.
  const messageEnds: string[] = [];
  const flushAssistantMessage = (
    status: AssistantStatus,
    stopReason?: string,
    force = false,
    ended = false,
  ) => {
    if ((!ctx.persistence.v2Transcript && !ctx.owner.lifecycle) || !assistantMessage
      || (!assistantMessage.dirty && !force)) return;
    assistantMessage.revision++;
    assistantMessage.dirty = false;
    const message = assistantMessage;
    const timestamp = new Date().toISOString();
    if (ended) messageEnds.push(timestamp);
    if (ctx.owner.agentSessionId && (status === "in_progress" || ended)) {
      ctx.owner.queueRecord({
        recordId: `${message.id}:snapshot:${message.revision}`,
        agentSessionId: ctx.owner.agentSessionId,
        agentConversationId: ctx.owner.agentConversationId,
        kind: "message",
        timestamp,
        operationId: turnId,
        role: "assistant",
        logicalMessageId: message.id,
        content: message.text,
        status: ended ? "completed" : "in_progress",
        metadata: JSON.stringify({ operationId: turnId,
          ...(message.providerMessageId ? { providerMessageId: message.providerMessageId } : {}) }),
      }, message.parts);
    }
    if (ctx.persistence.v2Transcript) ctx.presentation.queuePresentation({
      kind: "message",
      operationId: turnId,
      role: "assistant",
      text: message.parts ? transcriptParts(message.parts) : message.text,
      ...(message.providerMessageId === undefined ? {} : { providerMessageId: message.providerMessageId }),
      structured: {
        version: 1,
        messages: [message.providerMessageId === undefined
          ? { text: message.text }
          : { messageId: message.providerMessageId, text: message.text }],
      },
      status,
      ...(stopReason === undefined ? {} : { stopReason }),
      presentation: { id: message.id, revision: message.revision },
    });
  };
  // A message receives no more text once the next message or a tool call begins. Record it
  // completed then, rather than leaving it open until the turn ends.
  const endAssistantMessage = () => {
    flushAssistantMessage("completed", undefined, true, true);
    assistantMessage = null;
  };
  const handlers: PromptHandlers = {
    ...consumer,
    // Fired from here, from the one aggregator this session owns — nothing below needs
    // to know the handler exists, and two places firing it would be two folds.
    onRecord: undefined,
    onChunk: (chunk) => {
      chunks.push(chunk);
      consumer?.onChunk?.(chunk);
    },
    onResponseChunk: (chunk) => {
      const settledReasoning = ctx.presentation.closeReasoningBoundary();
      if (settledReasoning) {
        ctx.turn.queueActivityRecords(turnId, [settledReasoning]);
        consumer?.onRecord?.({ current: null, delta: null, emitted: [settledReasoning] });
      }
      response.append(chunk);
      if (ctx.persistence.v2Transcript || ctx.owner.lifecycle) {
        if (chunk.startsMessage) {
          endAssistantMessage();
          beginAssistantMessage(chunk.messageId);
        }
        const current = assistantMessage ?? beginAssistantMessage(chunk.messageId);
        if (current.providerMessageId === undefined && chunk.messageId !== undefined) {
          current.providerMessageId = chunk.messageId;
        }
        current.text += chunk.text;
        current.parts = response.currentParts();
        current.dirty = true;
        // Persist the first usable snapshot. Later token chunks remain in memory until
        // an interleaving item, a new message, or the operation boundary.
        if (current.revision === 0) flushAssistantMessage("in_progress");
      }
      consumer?.onResponseChunk?.(chunk);
    },
    onActivity: (event) => {
      // The message snapshot must enter the shared queue before an activity first seen
      // after it. Later activity revisions keep their original presentation position.
      if (event.kind === "tool") endAssistantMessage();
      else flushAssistantMessage("in_progress");
      if (!ctx.supervising) ctx.steering.observeActivity(turnId, event);
      const result = ctx.presentation.applyActivity(event);
      ctx.turn.queueActivityRecords(turnId, result.emitted);
      consumer?.onRecord?.(result);
      consumer?.onActivity?.(event);
    },
    onPermissionRequest: async (request, signal) => {
      const permissionBase = `${turnId}:permission:${request.toolCallId}`;
      const agentSessionId = nativePermissionRequests.get(request)?.hostHandled ? null : ctx.owner.agentSessionId;
      const resolution = await ctx.permissions.request(turnId, request, ctx.session.permissionPolicy, consumer, signal,
        agentSessionId ? () => ctx.owner.recordNow({
          recordId: `${permissionBase}:requested`,
          agentSessionId,
          agentConversationId: ctx.owner.agentConversationId,
          kind: "permission",
          timestamp: new Date().toISOString(),
          operationId: turnId,
          permissionId: request.toolCallId,
          state: "requested",
          request: toPersistenceJsonValue({
            toolCallId: request.toolCallId,
            ...(request.title ? { title: request.title } : {}),
            options: request.options,
            raw: request.raw,
          }),
        }) : undefined);
      if (agentSessionId) {
        const recorded = ctx.owner.recordNow({
          recordId: `${permissionBase}:resolved`,
          agentSessionId,
          agentConversationId: ctx.owner.agentConversationId,
          kind: "permission",
          timestamp: new Date().toISOString(),
          operationId: turnId,
          permissionId: request.toolCallId,
          state: "resolved",
          outcome: permissionOutcome(request, resolution),
        });
        // The owner tail keeps the record ordered. A timed-out refusal can reach the provider now.
        if (resolution.by === "timeout") void recorded.catch(() => undefined);
        else await recorded;
      }
      return resolution.outcome;
    },
  };

  recordingPermissionHandlers.add(handlers.onPermissionRequest!);
  return {
    chunks,
    response,
    messageEnds,
    get assistantOrdinal() { return assistantOrdinal; },
    handlers,
    beginAssistantMessage,
    flushAssistantMessage,
  };
}
