/**
 * One prompt turn, moved intact from `AgentSession.runPrompt` (controller-interface spec, Brief A2
 * step 1). The phases run in today's order and stay in one async function: splitting the awaited
 * phases into separate functions would add scheduling points between them, and the turn path's
 * record writes are sensitive to interleaving. The synchronous recording handlers (phase 3) live
 * in `recording.ts`.
 *
 * The session can replace members the turn reads (see `context.ts`), so they are read where the
 * original read them, not cached.
 *
 *   1. prepare: Agent-owned `beforePrompt` (participants, media, identity, user record), the turn's
 *      bookkeeping;
 *   2. user records and the metered operation, per persistence mode: managed opens the metered
 *      operation (preflight) before any durable record; detached appends the legacy user line
 *      first;
 *   3. the recording handlers (`createTurnRecording`);
 *   4. dispatch through the controller under the supervisor;
 *   5. assistant records; metering closed before local persistence; transcript closed;
 *   6. Agent-owned `afterPrompt` (identity delivery receipt, provider attachment);
 *   on failure: what was streamed is still recorded at its real status, metering closed once,
 *   and the error rethrown.
 */
import type { AgentSessionPromptResult } from "../agent-conversation-contracts.ts";
import { OwnedPromptPostCommitError } from "../agent-conversation-owner.ts";
import { unresolvedParts } from "../media/parts.ts";
import type { OpenOperation } from "../metering/engine.ts";
import { AgentSessionOperationError, type OperationMeteringRecord } from "../metering/record.ts";
import { OperationStalledError } from "../operations/errors.ts";
import {
  acknowledgeProviderAttachment,
  recordedProviderAttachment,
} from "../persistence/provider-attachment.ts";
import { mediaCapabilitiesOf } from "../conversation-controller/capabilities.ts";
import { isDegradedController } from "../conversation-controller/guards.ts";
import type { ResponseMessage } from "../types.ts";
import { backendTurnItem } from "./backend-turns.ts";
import type { TurnContext, TurnRunContext } from "./context.ts";
import { createTurnRecording } from "./recording.ts";
import { legacyTranscriptMessages, legacyTranscriptText, persistenceOperationKind } from "./record-helpers.ts";

export async function runTurn(ctx: TurnRunContext, turn: TurnContext): Promise<AgentSessionPromptResult> {
  const { turnId } = turn;
  // Today's preparation needs the turn's messages. A turn the backend started has none: it is metered and
  // recorded like any turn, but has no user message, no ACP content and only the session's own handlers.
  const sent = turn.messages !== undefined;
  const item = turn.messages ?? backendTurnItem(turnId, turn.handlers);
  // Phase 1: prepare.
  const targetProviderContextId = ctx.owner.lifecycle
    ? ctx.session.internalSessionId ?? `runtime:${ctx.owner.contextNonce()}`
    : undefined;
  const owned = ctx.owner.lifecycle && sent
    ? await ctx.owner.lifecycle.beforePrompt({
        operationId: turnId,
        agentSessionId: ctx.owner.agentSessionId!,
        agentConversationId: ctx.owner.agentConversationId,
        targetProviderContextId,
        ...(item.participantId ? { participantId: item.participantId } : {}),
        ...(item.consumerMetadata !== undefined ? { consumerMetadata: item.consumerMetadata } : {}),
        ...(item.parts ? { parts: item.parts } : {}),
        text: item.text,
        messageParts: item.messageParts,
        attachments: item.attachments,
        mediaContext: {
          cwd: ctx.session.cwd ?? process.cwd(),
          ...(isDegradedController(ctx.controller)
            ? { degraded: true }
            : { capabilities: mediaCapabilitiesOf(ctx.controller.conversationCapabilities.backend) }),
        },
      })
    : undefined;
  for (const participant of owned?.participants ?? (owned?.participant ? [owned.participant] : [])) {
    ctx.session.learnParticipant(participant);
  }
  ctx.turn.begin(turnId);

  // Phase 2: user records and the metered operation, per persistence mode.
  let operation: OpenOperation;
  if (ctx.persistence.v2Transcript) {
    let transcriptStarted = false;
    try {
      // Metering preflight has no provider side effect. Run it before minting durable
      // operation evidence so a strict pricing/policy rejection needs no abort record.
      operation = await ctx.metering.open(item);
      await ctx.persistence.v2Transcript!.beginOperation(turnId, persistenceOperationKind(item.operationKind));
      transcriptStarted = true;
      // A combined prompt shows each original message, as it was sent; a backend-started turn has none.
      const userTexts = !sent ? [] : item.parts
        ? item.parts.map((part) => legacyTranscriptText(part.text, part.messageParts, part.attachments))
        : [legacyTranscriptText(item.text, item.messageParts, item.attachments)];
      const userRecords = [];
      for (const [index, text] of userTexts.entries()) {
        userRecords.push(await ctx.persistence.v2Transcript!.appendPresentationEvent({
          kind: "message",
          operationId: turnId,
          role: "user",
          text,
          status: "completed",
          presentation: { id: `message:${turnId}:user${index === 0 ? "" : `:${index + 1}`}`, revision: 1 },
        }));
      }
      await ctx.persistence.v2Transcript!.syncBeforeDispatch();
      for (const userRecord of userRecords) ctx.presentation.emitPersistedRecord(userRecord);
    } catch (error) {
      ctx.turn.end(turnId, item.handlers);
      if (transcriptStarted) {
        await ctx.persistence.v2Transcript!.abortOperation("pre_dispatch_persistence_failure").catch(
          (abortError) => ctx.log.warn("transcript_predispatch_abort_failed", { error: String(abortError) }),
        );
      }
      throw error;
    }
  } else {
    if (sent) {
      await ctx.persistence.appendTranscript({
        v: 1,
        t: "msg",
        role: "user",
        text: legacyTranscriptText(item.text, item.messageParts, item.attachments),
        ts: Date.now(),
      });
    }
    operation = await ctx.metering.open(item);
  }

  // Phase 3: the recording handlers.
  const recording = createTurnRecording(ctx, turnId, item.handlers);
  const { chunks, response, messageEnds } = recording;

  let closed: OperationMeteringRecord | null = null;
  let transcriptClosed = false;
  let providerSettled = false;
  // A lazily created thread acquires its provider session during dispatch, so this is the
  // closest observable acquisition time when `session/new` happens inside `prompt()`.
  const dispatchedAt = new Date().toISOString();
  try {
    // Phase 4: dispatch under the supervisor.
    // The prepared turn starts nothing; the supervisor subscribes to its output, then calls its
    // `prompt()` (the attachment barrier).
    let res = await ctx.supervisedPrompt(ctx.controller, turnId, "turn",
      ctx.controller.prepareTurn(turnId, {
        // An owned conversation already resolved the parts and wrapped them with the provider-only
        // text (identity, out-of-band messages); otherwise the client resolves them.
        ...(!sent ? {} : {
          input: owned?.providerParts
            ? { parts: unresolvedParts(owned.providerParts) }
            : item.messageParts
              ? { parts: item.messageParts, attachments: item.attachments }
              : { text: item.text, attachments: item.attachments },
        }),
        handlers: recording.handlers,
      }));
    if (res.cancel === "forced") {
      const messages = response.snapshot();
      res = { ...res, messages, text: response.text || chunks.join("") };
    }
    providerSettled = true;

    // Phase 5: assistant records, metering, transcript.
    if (ctx.persistence.v2Transcript) {
      if (recording.assistantOrdinal === 0) {
        for (const message of res.messages) {
          const current = recording.beginAssistantMessage(message.messageId);
          current.text = message.text;
          current.dirty = true;
          recording.flushAssistantMessage(res.status, res.stopReason, true);
        }
      } else {
        recording.flushAssistantMessage(res.status, res.stopReason, true);
      }
    }
    // Before the assistant msg: `msg` delimits a turn, so anything still open has to
    // land inside those fences.
    ctx.turn.end(turnId, item.handlers);
    if (!ctx.session.title && item.text.trim()) {
      ctx.session.title = item.text.trim().replace(/\s+/g, " ").slice(0, 60);
    }
    // A session may have been created lazily on first prompt (degraded has none).
    const observedInternalSessionId = ctx.controller.currentSessionId ?? ctx.session.internalSessionId;
    if (observedInternalSessionId) {
      if (
        ctx.session.providerAttachment.kind === "absent"
        || ctx.session.providerAttachment.descriptor.internalSessionId !== observedInternalSessionId
      ) {
        ctx.session.installProviderAttachment(observedInternalSessionId, "runtime_only", true, {
          acquiredAt: dispatchedAt,
        });
      }
    } else {
      ctx.session.setInternalSessionId(observedInternalSessionId);
    }
    // Metering closes BEFORE local persistence. The provider has already been paid and
    // has already told us what it charged; letting a transcript or catalog write failure
    // send us down the catch path would discard usage we are holding and, in a strict
    // mode, block the session over a local disk problem.
    //
    // `closed` then guards the catch path. Closing twice would accrue the operation
    // twice and emit a second record for it — double-counting tokens and cost, which is
    // a worse failure than the one closing early prevents.
    const record = await ctx.metering.close(operation, res.status, res.usage);
    closed = record;
    await ctx.owner.lifecycle?.meteringRecorded?.(record);
    // The Agent-owned and transcript paths record the attachment inside their own
    // commit. A catalog-backed conversation has one mutable row, so the completed turn
    // is simply what makes the live thread the selected one.
    const pending = ctx.session.providerAttachment;
    if (res.status === "completed"
      && !ctx.owner.lifecycle
      && !ctx.persistence.v2Transcript
      && pending.kind === "runtime_only") {
      ctx.session.providerAttachment = recordedProviderAttachment(pending.descriptor);
      ctx.session.lastRecordedInternalSessionId = pending.descriptor.internalSessionId;
    }
    await ctx.persistence.persist();
    if (ctx.persistence.v2Transcript) {
      await ctx.presentation.drain();
      await ctx.persistence.finishV2Prompt(res.status, record);
      transcriptClosed = true;
    } else {
      await ctx.persistence.appendTranscript({
        v: 1,
        t: "msg",
        role: "assistant",
        ...legacyTranscriptMessages(res.messages, res.text),
        ts: Date.now(),
        usage: res.usage,
        stopReason: res.stopReason,
        status: res.status,
      });
    }
    const result = Object.freeze({
      ...res,
      operationId: turnId,
      metering: record,
      ...ctx.steering.resultFields(turnId, res.stopReason),
    });

    // Phase 6: Agent-owned afterPrompt.
    await ctx.owner.recordWrite;
    if (ctx.owner.lifecycle) {
      const completed = {
        operationId: turnId,
        agentSessionId: ctx.owner.agentSessionId!,
        agentConversationId: ctx.owner.agentConversationId,
        targetProviderContextId,
        ...(owned?.identityDeliveryReceipt
          ? { identityDeliveryReceipt: owned.identityDeliveryReceipt }
          : {}),
        ...(item.participantId ? { participantId: item.participantId } : {}),
        text: item.text,
        result,
        messageEnds,
        providerAttachment: ctx.session.providerAttachment,
      };
      try {
        const committed = await ctx.owner.lifecycle.afterPrompt(completed);
        if (committed?.providerAttachment) {
          ctx.session.providerAttachment = acknowledgeProviderAttachment(
            ctx.session.providerAttachment,
            committed.providerAttachment,
          );
        }
      } catch (error) {
        if (error instanceof OwnedPromptPostCommitError) {
          if (error.commit.providerAttachment) {
            ctx.session.providerAttachment = acknowledgeProviderAttachment(
              ctx.session.providerAttachment,
              error.commit.providerAttachment,
            );
          }
          throw error.cause ?? error;
        }
        throw error;
      }
    }
    await ctx.owner.recordWrite;
    return result;
  } catch (err) {
    // Failure: easy to miss, and the whole point of R4: a turn that died mid-tool still records
    // what it was doing, at its real status.
    ctx.turn.end(turnId, item.handlers);
    const structured = response.snapshot();
    const text = structured.length > 0 ? response.text : chunks.join("");
    const messages: readonly ResponseMessage[] = structured.length > 0
      ? structured
      : text
        ? Object.freeze([{ text }])
        : Object.freeze([]);
    if (!providerSettled) {
      await ctx.owner.recordWrite.catch((persistenceError) => {
        ctx.log.warn("owned_runtime_persistence_failed", { error: String(persistenceError) });
      });
      await ctx.owner.lifecycle?.promptFailed({
        operationId: turnId,
        agentSessionId: ctx.owner.agentSessionId!,
        agentConversationId: ctx.owner.agentConversationId,
        ...(item.participantId ? { participantId: item.participantId } : {}),
        text: item.text,
        messages,
        messageEnds,
        error: err,
      }).catch((persistenceError) => {
        ctx.log.warn("owned_prompt_failure_persistence_failed", { error: String(persistenceError) });
      });
    }
    await ctx.owner.recordWrite.catch((persistenceError) => {
      ctx.log.warn("owned_runtime_persistence_failed", { error: String(persistenceError) });
    });
    if (ctx.persistence.v2Transcript) {
      if (!transcriptClosed && recording.assistantOrdinal === 0 && messages.length > 0) {
        for (const message of messages) {
          const current = recording.beginAssistantMessage(message.messageId);
          current.text = message.text;
          current.dirty = true;
          recording.flushAssistantMessage("error", "error", true);
        }
      } else if (!transcriptClosed) {
        recording.flushAssistantMessage("error", "error", true);
      }
      await ctx.presentation.drain().catch(() => undefined);
    } else {
      await ctx.persistence.appendTranscript({
        v: 1,
        t: "msg",
        role: "assistant",
        ...legacyTranscriptMessages(messages, text),
        ts: Date.now(),
        stopReason: "error",
        status: "error",
      });
    }
    // A failed operation may still have consumed tokens, so its record has to survive
    // the rejection rather than only reaching event subscribers.
    // Already metered: the failure happened after the operation closed (a transcript or
    // catalog write), so the record stands and must not be minted a second time.
    const outcome = err instanceof OperationStalledError ? "cancelled" : "error";
    const record = closed ?? (await ctx.metering.close(operation, outcome, null, String(err)));
    await ctx.owner.lifecycle?.meteringRecorded?.(record);
    if (ctx.persistence.v2Transcript && !transcriptClosed) {
      await ctx.persistence.finishV2Prompt("error", record, "unknown").catch(
        (persistenceError) => ctx.log.warn("transcript_terminal_write_failed", { error: String(persistenceError) }),
      );
    }
    if (err instanceof OperationStalledError) {
      err.messages = messages;
      err.metering = record;
      await ctx.owner.lifecycle?.operationFailed?.({ operationId: turnId, error: err }).catch((error) => {
        ctx.log.warn("operation_failure_recording_failed", { error: String(error) });
      });
      throw err;
    }
    throw new AgentSessionOperationError(turnId, record, err);
  }
}
