import { writeConversationError } from "./error-record-writer.ts";
import type { OperationStalledError } from "../operations/errors.ts";
import { randomUUID } from "node:crypto";
import {
  type AgentConversationId,
} from "../agent-ids.ts";
import type { AgentMode } from "../controller.ts";
import type { OperationMeteringRecord } from "../metering/record.ts";
import type { AgentSessionMeteringState } from "../metering/state.ts";
import {
  IMPLICIT_USER_PARTICIPANT_ID,
  type ConversationRecord,
  type NewConversationRecord,
  type ParticipantRef,
  type PersistenceScope,
} from "../persistence/backend.ts";
import type {
  AgentConversationOwnerLifecycle,
  OwnedPromptCommitResult,
  OwnedPromptCompleted,
  OwnedPromptFailed,
  OwnedPromptInput,
} from "../agent-conversation-owner.ts";
import { OwnedPromptPostCommitError } from "../agent-conversation-owner.ts";
import {
  composeProviderParts,
  pendingOutOfBandMessages,
} from "../out-of-band-messages.ts";
import type {
  ProviderAttachmentCommitAcknowledgement,
} from "../persistence/provider-attachment.ts";

import type { ManagerSettings } from "./manager-settings.ts";
import {
  updateConversationIdentity,
  persistConversationObservations,
  persistObservationsInTransaction,
  captureRuntimeRecord,
  enqueueAuditObservation,
} from "./record-capture.ts";

import type { Agent } from "../agent.ts";
import { deliverableParts, pendingOutOfBandParts } from "../media/pending.ts";
import { resolveParts } from "../media/store.ts";
import { attachmentParts } from "../media/acp.ts";
import { contentParts, persistParts } from "../media/content.ts";
import { isMediaPart, type ResolvedPart } from "../media/parts.ts";
import type { MediaStore } from "../media/store.ts";

export class PersistedConversationLifecycle implements AgentConversationOwnerLifecycle {
  private readonly outputMedia = new WeakMap<object, string>();
  private readonly deliveredMessages = new Map<string, { ids: readonly string[]; throughSequence: number }>();
  constructor(
    private readonly agent: Agent,
    private readonly conversationId: AgentConversationId,
    private readonly initialParticipants: readonly ParticipantRef[],
    private readonly settings: ManagerSettings,
    readonly recoverInPlace?: (error: unknown) => Promise<void>,
  ) {}

  async operationFailed(input: { operationId: string; error: OperationStalledError }): Promise<void> {
    const written = await writeConversationError(this.agent, this.settings, {
      agentConversationId: this.conversationId, attemptId: input.operationId,
      operationId: input.operationId, source: "operation", code: "stalled", recoverability: "retryable",
      message: "The provider stopped producing output.", details: { phase: input.error.phase },
    });
    if (written.recordingError) throw written.recordingError;
  }

  async beforePrompt(input: OwnedPromptInput) {
    // A combined prompt records each original message as it was sent, under the same operation.
    const parts = input.parts ?? [{
      id: input.operationId,
      text: input.text,
      messageParts: input.messageParts,
      attachments: input.attachments,
      ...(input.participantId ? { participantId: input.participantId } : {}),
      ...(input.consumerMetadata !== undefined ? { consumerMetadata: input.consumerMetadata } : {}),
    }];
    const resolved = await Promise.all(parts.map((message) => resolveParts([
      ...(message.messageParts ?? [{ kind: "text" as const, text: message.text }]),
      ...attachmentParts(message.attachments),
    ], {
      cwd: input.mediaContext?.cwd ?? process.cwd(),
      capabilities: input.mediaContext?.capabilities,
      thresholds: this.agent.media.thresholds,
      owner: this.conversationId,
      store: this.mediaStore(),
    })));
    if (input.mediaContext?.degraded && resolved.some((message) => message.some(isMediaPart))) {
      throw new Error("PTY mode does not support non-text parts");
    }
    const participants: ParticipantRef[] = [];
    for (const part of parts) participants.push(await this.resolveParticipant(part.participantId));
    const participant = participants[0]!;
    const identity = await this.agent.identity.load({
      agentSessionId: this.agent.id,
      agentConversationId: this.conversationId,
      targetProviderContextId: input.targetProviderContextId,
      participant,
      prompt: input.text,
      consistency: this.settings.identityConsistency,
      ...(this.settings.identityTimeoutMs !== undefined
        ? { timeoutMs: this.settings.identityTimeoutMs }
        : {}),
    });
    const records: ConversationRecord[] = [];
    await this.agent.persistence.transaction(async (scope) => {
      const contents = await Promise.all(resolved.map((message) =>
        persistParts(message, this.conversationId, this.mediaStore(scope), this.settings.capture.media)));
      const userRecords = parts.map((part, index): NewConversationRecord => ({
        recordId: index === 0 ? `${input.operationId}:user` : `${input.operationId}:user:${index + 1}`,
        agentSessionId: this.agent.id,
        agentConversationId: this.conversationId,
        kind: "message",
        timestamp: new Date().toISOString(),
        operationId: input.operationId,
        role: "user",
        participantId: participants[index]!.id,
        ...(part.consumerMetadata !== undefined ? { consumerMetadata: part.consumerMetadata } : {}),
        content: contents[index]!,
        status: "completed",
        metadata: JSON.stringify({ operationId: input.operationId }),
      }));
      await this.persistObservationsInTransaction(scope, userRecords, true, records);
    });
    this.agent.publishCommittedRecords(records);
    if (this.settings.auditLog) this.agent.audit?.notifyPending();
    await this.updateIdentity(records);
    // Read after the user record commits so a concurrent append falls in this turn or the next.
    const currentUserSequence = records[0]?.sequence
      ?? ((await this.agent.persistence.conversations.get(this.conversationId))!.latestSequence + 1);
    const outOfBand = await pendingOutOfBandMessages(this.agent.persistence, this.conversationId,
      input.targetProviderContextId, currentUserSequence);
    const ordered: ResolvedPart[] = resolved.flatMap((parts, index) => [
      ...(index ? [{ kind: "text" as const, text: "\n\n" }] : []), ...parts,
    ]);
    this.deliveredMessages.set(input.operationId, {
      ids: outOfBand.map((message) => message.recordId),
      throughSequence: currentUserSequence - 1,
    });
    const store = this.mediaStore();
    const pending = pendingOutOfBandParts(this.agent);
    const providerParts = await composeProviderParts(ordered, identity.promptPreamble, outOfBand, async (message) =>
      deliverableParts(
        pending.get(message.recordId)?.parts ?? await contentParts(message.content, store),
        input.mediaContext?.capabilities,
        input.mediaContext?.degraded,
      ));
    return Object.freeze({
      providerParts,
      participant,
      participants: Object.freeze(participants),
      ...(identity.deliveryReceipt ? { identityDeliveryReceipt: identity.deliveryReceipt } : {}),
    });
  }

  async afterPrompt(input: OwnedPromptCompleted): Promise<OwnedPromptCommitResult> {
    const timestamp = new Date().toISOString();
    const status = input.result.status === "error" ? "failed" : input.result.status;
    const ends = input.messageEnds ?? [];
    const records = input.result.messages.map((message, index): NewConversationRecord => ({
      recordId: `${input.operationId}:assistant:${index + 1}`,
      agentSessionId: this.agent.id,
      agentConversationId: this.conversationId,
      kind: "message",
      timestamp: ends[index] ?? timestamp,
      operationId: input.operationId,
      role: "assistant",
      logicalMessageId: `message:${input.operationId}:assistant:${index + 1}`,
      content: message.text,
      status: ends[index] ? "completed" : status,
      metadata: JSON.stringify({
        operationId: input.operationId,
        ...(message.messageId ? { providerMessageId: message.messageId } : {}),
      }),
    }));
    const persisted: ConversationRecord[] = [];
    const pending: Array<readonly [object, string]> = [];
    let providerAttachment: ProviderAttachmentCommitAcknowledgement | undefined;
    await this.agent.persistence.transaction(async (persistence) => {
      const prepared = await this.withStoredParts(
        persistence, records, input.result.messages.map((message) => message.parts), pending);
      await this.persistObservationsInTransaction(persistence, prepared, true, persisted);
      if (status === "completed") {
        await persistence.workerDelivery?.recordFinal(
          this.conversationId, input.operationId, input.result.messages.map((message) => message.text).join("\n"),
        );
      }
      // Delivery is tracked per provider context, so it holds when no user or assistant text is captured.
      const delivered = this.deliveredMessages.get(input.operationId);
      if (status === "completed" && delivered) {
        const providerContext = input.providerAttachment.kind === "absent"
          ? input.targetProviderContextId ?? ""
          : input.providerAttachment.descriptor.internalSessionId;
        await persistence.outOfBandDelivery?.advance(this.conversationId, providerContext, delivered.throughSequence);
      }
      if (status === "completed" && input.providerAttachment.kind === "runtime_only") {
        const descriptor = input.providerAttachment.descriptor;
        const providerSessionRecordId = `provider-${randomUUID()}`;
        await persistence.identityDelivery?.reset(
          this.conversationId,
          descriptor.internalSessionId,
        );
        await persistence.providerSessions.append({
          providerSessionRecordId,
          agentConversationId: this.conversationId,
          internalSessionId: descriptor.internalSessionId,
          adapterId: descriptor.adapterId,
          mode: descriptor.mode,
          ...(descriptor.model ? { model: descriptor.model } : {}),
          activatedAt: descriptor.acquiredAt,
          ...(descriptor.transitionId ? { transitionId: descriptor.transitionId } : {}),
        });
        providerAttachment = Object.freeze({
          attachmentAttemptId: descriptor.attachmentAttemptId,
          providerSessionRecordId,
        });
      }
    });
    const deliveredIds = this.deliveredMessages.get(input.operationId)?.ids ?? [];
    if (status === "completed") for (const id of deliveredIds) pendingOutOfBandParts(this.agent).delete(id);
    this.deliveredMessages.delete(input.operationId);
    for (const [part, ref] of pending) this.outputMedia.set(part, ref);
    this.agent.publishCommittedRecords(persisted);
    if (this.settings.auditLog) this.agent.audit?.notifyPending();
    const commit: OwnedPromptCommitResult = Object.freeze({
      ...(providerAttachment ? { providerAttachment } : {}),
    });
    try {
      await this.updateIdentity(Object.freeze(persisted));
      if (status === "completed" && input.identityDeliveryReceipt) {
        await this.agent.identity.delivered?.(input.identityDeliveryReceipt);
      }
      if (status === "completed") {
        await this.agent.checkpointing?.afterSuccessfulResponse(this.conversationId);
      }
    } catch (error) {
      throw new OwnedPromptPostCommitError(commit, error);
    }
    return commit;
  }

  async promptFailed(input: OwnedPromptFailed): Promise<void> {
    this.deliveredMessages.delete(input.operationId);
    const timestamp = new Date().toISOString();
    const ends = input.messageEnds ?? [];
    const records = input.messages.map((message, index): NewConversationRecord => ({
      recordId: `${input.operationId}:assistant:${index + 1}`,
      agentSessionId: this.agent.id,
      agentConversationId: this.conversationId,
      kind: "message",
      timestamp: ends[index] ?? timestamp,
      operationId: input.operationId,
      role: "assistant",
      logicalMessageId: `message:${input.operationId}:assistant:${index + 1}`,
      content: message.text,
      // A message that ended before the failure was complete; only the one cut off failed.
      status: ends[index] ? "completed" : "failed",
      metadata: JSON.stringify({
        operationId: input.operationId,
        ...(message.messageId ? { providerMessageId: message.messageId } : {}),
      }),
    }));
    const parts = input.messages.map((message) => message.parts);
    await this.updateIdentity(await this.persistMessagesWithParts(records, parts));
  }

  resolveAdapter(adapterId: string) {
    return this.agent.adapters.require(adapterId);
  }

  async transitionActivated(input: {
    readonly transitionId: string;
    readonly agentConversationId: AgentConversationId;
    readonly internalSessionId: string;
    readonly adapterId: string;
    readonly mode: AgentMode;
    readonly model?: string;
    readonly activatedAt: string;
  }): Promise<void> {
    await this.agent.persistence.transaction(async (persistence) => {
      await persistence.identityDelivery?.reset(input.agentConversationId, input.internalSessionId);
      await persistence.providerSessions.append({
        providerSessionRecordId: `provider-${randomUUID()}`,
        agentConversationId: input.agentConversationId,
        internalSessionId: input.internalSessionId,
        adapterId: input.adapterId,
        mode: input.mode,
        ...(input.model ? { model: input.model } : {}),
        activatedAt: input.activatedAt,
        transitionId: input.transitionId,
      });
    });
  }

  async importParticipant(): Promise<ParticipantRef> {
    return await this.resolveParticipant();
  }

  async record(record: NewConversationRecord, parts?: readonly ResolvedPart[]): Promise<void> {
    const streamingSnapshot = record.kind === "message" && record.status === "in_progress";
    const persisted = parts
      ? await this.persistMessagesWithParts([record], [parts], !streamingSnapshot)
      : await this.persistObservations([record], !streamingSnapshot);
    if (!streamingSnapshot) await this.updateIdentity(persisted);
  }

  /** The consumer's store when the Agent has one, otherwise the persistence backend's. */
  private mediaStore(scope: PersistenceScope = this.agent.persistence): MediaStore | undefined {
    return this.agent.media.store ?? scope.media;
  }

  /**
   * Message records whose content is their parts, with the kept copies stored. A copy stored by an
   * earlier revision of the same message keeps its ref, so a streamed message stores it once.
   */
  private async withStoredParts(
    scope: PersistenceScope,
    records: readonly NewConversationRecord[],
    parts: readonly (readonly ResolvedPart[] | undefined)[],
    pending: Array<readonly [object, string]>,
  ): Promise<NewConversationRecord[]> {
    return await Promise.all(records.map(async (record, index) => {
      const messageParts = parts[index];
      if (!messageParts || record.kind !== "message") return record;
      const content = await persistParts(messageParts, this.conversationId, this.mediaStore(scope),
        this.settings.capture.media, { cache: this.outputMedia, pending });
      return { ...record, content };
    }));
  }

  private async persistMessagesWithParts(
    records: readonly NewConversationRecord[],
    parts: readonly (readonly ResolvedPart[] | undefined)[],
    audit = true,
  ): Promise<readonly ConversationRecord[]> {
    const persisted: ConversationRecord[] = [];
    const pending: Array<readonly [object, string]> = [];
    await this.agent.persistence.transaction(async (scope) => {
      const prepared = await this.withStoredParts(scope, records, parts, pending);
      await this.persistObservationsInTransaction(scope, prepared, audit, persisted);
    });
    for (const [part, ref] of pending) this.outputMedia.set(part, ref);
    this.agent.publishCommittedRecords(persisted);
    if (audit && this.settings.auditLog) this.agent.audit?.notifyPending();
    return persisted;
  }

  async meteringRecorded(record: OperationMeteringRecord): Promise<void> {
    const level = this.settings.capture.metering;
    let reference: ConversationRecord | undefined;
    await this.agent.persistence.transaction(async (persistence) => {
      await persistence.metering.commit({
        agentConversationId: this.conversationId,
        record,
        meteringRecords: this.settings.meteringRecords,
      });
      const timelineRecord: NewConversationRecord = {
        recordId: `${record.operationId}:metering`,
        agentSessionId: this.agent.id,
        agentConversationId: this.conversationId,
        kind: "metering",
        timestamp: new Date(record.completedAt).toISOString(),
        operationId: record.operationId,
        meteringRecordId: record.operationId,
        status: record.usage.status === "metered" ? "available" : "unavailable",
        metadata: JSON.stringify({ operationId: record.operationId }),
      };
      if (level !== "none") {
        reference = await persistence.records.append(captureRuntimeRecord(timelineRecord, level));
      }
      if (this.settings.auditLog) {
        await enqueueAuditObservation(persistence, {
          scope: "conversation",
          sourceObservationId: timelineRecord.recordId,
          operationId: record.operationId,
          record: timelineRecord,
          meteringRecord: record,
        }, this.settings.auditLog);
      }
    });
    if (reference) this.agent.publishCommittedRecords([reference]);
    if (this.settings.auditLog) this.agent.audit?.notifyPending();
    if (reference) await this.updateIdentity([reference]);
  }

  async meteringStateChanged(state: AgentSessionMeteringState): Promise<void> {
    await this.agent.persistence.metering.saveState(this.conversationId, state);
  }

  private async resolveParticipant(participantId?: string): Promise<ParticipantRef> {
    const id = participantId
      ?? (this.initialParticipants.length === 1
        ? this.initialParticipants[0]!.id
        : IMPLICIT_USER_PARTICIPANT_ID);
    const existing = (await this.agent.persistence.conversations.get(this.conversationId))
      ?.participants.find((participant) => participant.id === id);
    if (existing) return existing;
    return await this.agent.persistence.conversations.ensureParticipant(this.conversationId, {
      id,
      kind: "user",
    });
  }

  private async appendMessages(
    records: readonly NewConversationRecord[],
  ): Promise<readonly ConversationRecord[]> {
    return await this.persistObservations(records);
  }

  private async persistObservations(
    records: readonly NewConversationRecord[],
    audit = true,
  ): Promise<readonly ConversationRecord[]> {
    return await persistConversationObservations(this.agent, this.settings, records, audit);
  }

  private async persistObservationsInTransaction(
    persistence: PersistenceScope,
    records: readonly NewConversationRecord[],
    audit: boolean,
    persisted: ConversationRecord[],
  ): Promise<void> {
    await persistObservationsInTransaction(this.settings, persistence, records, audit, persisted);
  }

  private async updateIdentity(records: readonly ConversationRecord[]): Promise<void> {
    await updateConversationIdentity(this.agent, this.settings, this.conversationId, records);
  }
}
