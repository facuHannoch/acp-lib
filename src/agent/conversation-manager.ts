import { randomUUID } from "node:crypto";
import {
  createAgentConversationId,
  type AgentConversationId,
} from "../agent-ids.ts";
import {
  AgentConversation,
} from "../agent-session.ts";
import type { AgentMode } from "../controller.ts";
import { MeteringEngine } from "../metering/engine.ts";
import { createModelsDevResolver } from "../metering/catalog/index.ts";
import {
  type AgentConversationSummary,
  type ConversationListOptions,
  type ConversationPage,
  type ConversationPreviewPage,
  type ConversationErrorDetails,
  type ConversationErrorRecoverability,
  type ConversationErrorSource,
  type ConversationRecord,
  type MessageRecord,
  type NewConversationRecord,
  type ParticipantRef,
} from "../persistence/backend.ts";
import { ProviderSessionError } from "../agent-conversation-errors.ts";
import {
  OUT_OF_BAND_MESSAGE_ORIGIN,
  type AppendAssistantMessageInput,
} from "../out-of-band-messages.ts";
import type {
  ProviderAttachmentCommitAcknowledgement,
} from "../persistence/provider-attachment.ts";
import type { InternalInferenceSnapshot } from "../internal-inference/contracts.ts";
import {
  buildRecoverySeed,
  classifyProviderSessionLoadError,
  type ConversationRecoveryResult,
} from "../checkpointing/index.ts";

import type { ManagerSettings } from "./manager-settings.ts";
import {
  updateConversationIdentity,
  persistConversationObservations,
  normalizeParticipants,
  internalInferenceMeteringKind,
  captureRuntimeRecord,
  enqueueAuditObservation,
  providerSessionErrorDetails,
} from "./record-capture.ts";
import {
  PersistedConversationLifecycle,
} from "./persisted-lifecycle.ts";
import type {
  AgentConversationManager,
  AgentConversationRuntimeDefaults,
  CreateAgentConversationConfig,
  OpenAgentConversationConfig,
  OpenOwnedAgentConversationResult,
} from "./config.ts";

import type { Agent } from "../agent.ts";

export class DefaultAgentConversationManager implements AgentConversationManager {
  private readonly live = new Map<AgentConversationId, AgentConversation>();
  private readonly openings = new Map<AgentConversationId, Promise<OpenOwnedAgentConversationResult>>();
  private readonly meteringSetupLocks = new Map<AgentConversationId, Promise<void>>();
  private readonly detachedMeteringBarriers = new Map<AgentConversationId, Promise<void>>();
  private agentMeteringBarrier: Promise<void> | undefined;

  constructor(private readonly agent: Agent, private readonly settings: ManagerSettings) {}

  async create(config: CreateAgentConversationConfig = {}): Promise<AgentConversation> {
    const id = config.id ?? createAgentConversationId();
    const participants = normalizeParticipants(config.participants);
    // Validate caller input before the durable row: a mistake must not orphan a
    // conversation, and must not be recorded as a provider-session failure.
    this.prepareStart({ ...config, providerSession: "new" });
    await this.agent.persistence.conversations.create({
      agentSessionId: this.agent.id,
      agentConversationId: id,
      participants,
      ...(config.title !== undefined ? { title: config.title } : {}),
      ...(config.metadata !== undefined ? { metadata: config.metadata } : {}),
    });
    const attemptId = `provider-create-${randomUUID()}`;
    try {
      return await this.start(id, participants, {
        ...config,
        providerSession: "new",
      });
    } catch (error) {
      return await this.throwCreateFailure(id, attemptId, error);
    }
  }

  async open(
    id: AgentConversationId,
    config: OpenAgentConversationConfig = {},
  ): Promise<OpenOwnedAgentConversationResult> {
    const existing = this.live.get(id);
    if (existing && existing.state.phase !== "stopped") {
      return Object.freeze({ conversation: existing, providerSession: "already_open" });
    }
    const pending = this.openings.get(id);
    if (pending) return await pending;
    const opening = this.openOnce(id, config);
    this.openings.set(id, opening);
    try {
      return await opening;
    } finally {
      if (this.openings.get(id) === opening) this.openings.delete(id);
    }
  }

  private async openOnce(
    id: AgentConversationId,
    config: OpenAgentConversationConfig,
  ): Promise<OpenOwnedAgentConversationResult> {
    const summary = await this.agent.persistence.conversations.get(id);
    if (!summary || summary.deletedAt) throw new Error(`unknown active conversation: ${id}`);
    const active = await this.agent.persistence.providerSessions.active(id);
    if (active && config.adapterId && config.adapterId !== active.adapterId) {
      throw new Error(
        `conversation ${id} is active on ${active.adapterId}; use a conversation switch instead of loading it with ${config.adapterId}`,
      );
    }
    const startConfig = {
      ...config,
      runtime: {
        ...(summary.title ? { title: summary.title } : {}),
        ...config.runtime,
      },
      adapterId: config.adapterId ?? active?.adapterId,
    };
    // Validate caller input before the recorded region so a configuration mistake is not
    // persisted as a provider-session failure.
    this.prepareStart({ ...startConfig, providerSession: active ? "load" : "new" });
    const attemptId = active ? `provider-load-${randomUUID()}` : `provider-create-${randomUUID()}`;
    try {
      const conversation = await this.start(id, summary.participants, {
        ...startConfig,
        providerSession: active ? "load" : "new",
        internalSessionId: active?.internalSessionId,
      });
      return Object.freeze({
        conversation,
        providerSession: active ? "loaded" : "new",
      });
    } catch (error) {
      // No recorded mapping means this open was creating a thread, not loading one.
      if (!active) return await this.throwCreateFailure(id, attemptId, error);
      const recovery = this.settings.checkpointing?.recovery;
      const classification = classifyProviderSessionLoadError(error, recovery?.isMissingProviderSession);
      const recorded = await this.recordConversationError({
        agentConversationId: id,
        attemptId,
        source: "provider_session",
        code: classification.code,
        recoverability: classification.recoverability,
        message: "The provider session could not be loaded.",
        transitionId: attemptId,
        internalSessionId: active.internalSessionId,
        details: providerSessionErrorDetails(error),
      });
      const structuredError = (): ProviderSessionError => new ProviderSessionError({
        agentSessionId: this.agent.id,
        agentConversationId: id,
        attemptId,
        internalSessionId: active.internalSessionId,
        code: classification.code,
        source: "provider_session",
        recoverability: classification.recoverability,
        ...(recorded.record ? { recordId: recorded.record.recordId } : {}),
        ...(recorded.recordingError ? { recordingError: recorded.recordingError } : {}),
        cause: error,
      });
      if (recovery?.onLoadFailure !== "recover" || !classification.missing) throw structuredError();
      config.onRecoveryProgress?.({ stage: "load_failed" });
      config.onRecoveryProgress?.({ stage: "loading_checkpoint" });
      const checkpoint = await this.agent.persistence.recoveryCheckpoints?.latest(id);
      if (!checkpoint) throw structuredError();
      config.onRecoveryProgress?.({ stage: "loading_checkpoint", checkpointId: checkpoint.checkpointId });
      const recoveryAttemptId = `recovery-${randomUUID()}`;
      try {
        const seed = await buildRecoverySeed(
          this.agent.persistence.messages,
          id,
          checkpoint,
          summary.latestSequence,
          recovery,
        );
        config.onRecoveryProgress?.({ stage: "creating_session", checkpointId: checkpoint.checkpointId });
        const conversation = await this.start(id, summary.participants, {
          ...startConfig,
          providerSession: "new",
        });
        try {
          config.onRecoveryProgress?.({ stage: "seeding", checkpointId: checkpoint.checkpointId });
          await conversation.seedRecoveryContext(seed.prompt);
          const acknowledgement = await this.persistProviderSession(conversation, id, {
            transitionId: recoveryAttemptId,
            metadata: JSON.stringify({
              recoveryCheckpointId: checkpoint.checkpointId,
              previousInternalSessionId: active.internalSessionId,
              recoveredThroughSequence: seed.recoveredThroughSequence,
            }),
          }, true);
          conversation.acknowledgeProviderAttachment(acknowledgement);
        } catch (recoveryError) {
          this.live.delete(id);
          await conversation.stop().catch(() => undefined);
          throw recoveryError;
        }
        const result: ConversationRecoveryResult = Object.freeze({
          checkpointId: checkpoint.checkpointId,
          coveredSequence: checkpoint.coveredSequence,
          recoveredThroughSequence: seed.recoveredThroughSequence,
          previousInternalSessionId: active.internalSessionId,
          newInternalSessionId: conversation.internalSessionId!,
        });
        config.onRecoveryProgress?.({ stage: "completed", checkpointId: checkpoint.checkpointId });
        return Object.freeze({ conversation, providerSession: "recovered", recovery: result });
      } catch (recoveryError) {
        // A recovery failure is a distinct root cause from the load failure already
        // recorded above; it prevents the logical conversation from reopening.
        const recoveryRecorded = await this.recordConversationError({
          agentConversationId: id,
          attemptId: recoveryAttemptId,
          source: "recovery",
          code: "recovery_failed",
          recoverability: "recoverable",
          message: "The conversation could not be recovered from its checkpoint.",
          transitionId: recoveryAttemptId,
          internalSessionId: active.internalSessionId,
        });
        throw new ProviderSessionError({
          agentSessionId: this.agent.id,
          agentConversationId: id,
          attemptId: recoveryAttemptId,
          internalSessionId: active.internalSessionId,
          code: "recovery_failed",
          source: "recovery",
          recoverability: "recoverable",
          message: "The conversation could not be recovered from its checkpoint.",
          ...(recoveryRecorded.record ? { recordId: recoveryRecorded.record.recordId } : {}),
          ...(recoveryRecorded.recordingError ? { recordingError: recoveryRecorded.recordingError } : {}),
          cause: recoveryError,
        });
      }
    }
  }

  async get(id: AgentConversationId): Promise<AgentConversationSummary | null> {
    return await this.agent.persistence.conversations.get(id);
  }

  async list(options?: ConversationListOptions): Promise<ConversationPage> {
    return await this.agent.persistence.conversations.list(options);
  }

  async listPreviews(options?: ConversationListOptions): Promise<ConversationPreviewPage> {
    if (!this.agent.persistence.conversations.listPreviews) {
      throw new Error("conversation previews are unavailable on this persistence backend");
    }
    return await this.agent.persistence.conversations.listPreviews(options);
  }

  async delete(id: AgentConversationId, deletedAt?: string): Promise<void> {
    const live = this.live.get(id);
    if (live) await live.stop();
    this.live.delete(id);
    await this.agent.persistence.conversations.delete(id, deletedAt);
  }

  async appendAssistantMessage(
    id: AgentConversationId,
    input: AppendAssistantMessageInput,
  ): Promise<MessageRecord> {
    if (typeof input.text !== "string" || !input.text.trim()) {
      throw new Error("assistant message text cannot be blank");
    }
    const level = this.settings.capture.message;
    if (level !== "content" && level !== "raw") {
      throw new Error(
        `appending an assistant message requires message capture "content" or "raw", not "${level}"`,
      );
    }
    const summary = await this.agent.persistence.conversations.get(id);
    if (!summary || summary.deletedAt) throw new Error(`unknown active conversation: ${id}`);
    const appendId = `append-${randomUUID()}`;
    const [record] = await persistConversationObservations(this.agent, this.settings, [{
      recordId: `${appendId}:assistant`,
      agentSessionId: this.agent.id,
      agentConversationId: id,
      kind: "message",
      timestamp: new Date().toISOString(),
      role: "assistant",
      logicalMessageId: `message:${appendId}:assistant`,
      ...(input.consumerMetadata !== undefined ? { consumerMetadata: input.consumerMetadata } : {}),
      content: input.text,
      status: "completed",
      metadata: JSON.stringify({ origin: OUT_OF_BAND_MESSAGE_ORIGIN, appendId }),
    }]);
    if (record?.kind !== "message") throw new Error("assistant message was not persisted");
    await updateConversationIdentity(this.agent, this.settings, id, [record]);
    return record;
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.openings.values()]);
    const conversations = [...this.live.values()];
    this.live.clear();
    await Promise.allSettled(conversations.map((conversation) => conversation.stop()));
  }

  async beginInternalInferenceMetering(
    attempt: InternalInferenceSnapshot,
    session: { readonly internalSessionId: string; readonly model: string | null },
  ): Promise<import("../internal-inference/contracts.ts").InternalInferenceMeteringOperation | null> {
    const conversationId = attempt.agentConversationId;
    const releaseSetup = conversationId
      ? await this.acquireMeteringSetupLock(conversationId)
      : () => {};
    let barrier: Promise<void> | undefined;
    let releaseBarrier = () => {};
    try {
      const conversation = conversationId ? this.live.get(conversationId) : undefined;
      if (conversation && conversation.state.phase !== "stopped") {
        const operation = await conversation.beginDetachedMetering({
          operationId: attempt.id,
          operationKind: internalInferenceMeteringKind(attempt.purpose),
          internalSessionId: session.internalSessionId,
          model: session.model,
        });
        let closed = false;
        releaseSetup();
        return {
          close: async ({ outcome, result, error }) => {
            if (closed) throw new Error(`internal inference metering already closed: ${attempt.id}`);
            closed = true;
            return await conversation.closeDetachedMetering(operation, {
              outcome,
              usage: result?.usage ?? null,
              ...(error ? { usageFailureReason: String(error) } : {}),
            });
          },
          settled() {},
        };
      }

      const previous = conversationId
        ? this.detachedMeteringBarriers.get(conversationId) ?? Promise.resolve()
        : this.agentMeteringBarrier ?? Promise.resolve();
      const ownBarrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
      barrier = previous.then(() => ownBarrier);
      if (conversationId) this.detachedMeteringBarriers.set(conversationId, barrier);
      else this.agentMeteringBarrier = barrier;
      releaseSetup();
      // Detached operations for one closed conversation must restore and commit in order.
      // Otherwise two workers can derive the same next operation count from one snapshot.
      await previous;
      const persisted = conversationId
        ? await this.agent.persistence.metering.state(conversationId)
        : await this.agent.persistence.metering.agentState(this.agent.id);
      const meteringConfig = this.settings.defaults.metering;
      const engine = new MeteringEngine({
      agentSessionId: this.agent.id,
      adapterId: attempt.adapterId,
      enforcement: meteringConfig?.enforcement ?? "best_effort",
      pricing: meteringConfig?.pricing ?? createModelsDevResolver(),
      ...(persisted ? { initialState: persisted.state } : {}),
      createdActiveThread: false,
      ...(meteringConfig?.counterInterpretation
        ? { counterInterpretation: meteringConfig.counterInterpretation }
        : {}),
      ...(meteringConfig?.inferenceSource
        ? { inferenceSource: meteringConfig.inferenceSource }
        : {}),
    });
      const operation = await engine.openDetached({
      operationId: attempt.id,
      operationKind: internalInferenceMeteringKind(attempt.purpose),
      internalSessionId: session.internalSessionId,
      providerId: null,
      model: session.model,
    });
      let closed = false;
      let settled = false;
      return {
      close: async ({ outcome, result, error }) => {
        if (closed) throw new Error(`internal inference metering already closed: ${attempt.id}`);
        closed = true;
        return await engine.closeDetached(operation, {
          outcome,
          reportedCumulative: result?.usage ?? null,
          ...(error ? { usageFailureReason: String(error) } : {}),
          contextAfter: null,
          providerCostAfter: null,
        });
      },
      settled: () => {
        if (settled) return;
        settled = true;
        if (conversationId && this.detachedMeteringBarriers.get(conversationId) === barrier) {
          this.detachedMeteringBarriers.delete(conversationId);
        } else if (!conversationId && this.agentMeteringBarrier === barrier) {
          this.agentMeteringBarrier = undefined;
        }
        releaseBarrier();
      },
      };
    } catch (error) {
      releaseSetup();
      if (barrier && conversationId && this.detachedMeteringBarriers.get(conversationId) === barrier) {
        this.detachedMeteringBarriers.delete(conversationId);
      } else if (barrier && !conversationId && this.agentMeteringBarrier === barrier) {
        this.agentMeteringBarrier = undefined;
      }
      releaseBarrier();
      throw error;
    }
  }

  private async start(
    id: AgentConversationId,
    participants: readonly ParticipantRef[],
    config: (CreateAgentConversationConfig | OpenAgentConversationConfig) & {
      readonly providerSession: "new" | "load";
      readonly internalSessionId?: string;
    },
  ): Promise<AgentConversation> {
    const releaseSetup = await this.acquireMeteringSetupLock(id);
    let conversation: AgentConversation | undefined;
    try {
      const adapterId = this.resolveAdapterId(config.adapterId);
      const adapter = this.agent.adapters.require(adapterId);
      const runtime = { ...this.settings.defaults, ...config.runtime };
      await this.detachedMeteringBarriers.get(id);
      const persistedMetering = await this.agent.persistence.metering.state(id);
      const lifecycle = new PersistedConversationLifecycle(
        this.agent,
        id,
        participants,
        this.settings,
      );
      conversation = await AgentConversation.create({
        ...runtime,
        ...(persistedMetering
          ? { metering: { ...runtime.metering, initialState: persistedMetering.state } }
          : {}),
        ...("title" in config && config.title !== undefined ? { title: config.title } : {}),
        adapter,
        adapterId,
        agentSessionId: this.agent.id,
        ownerAgentSessionId: this.agent.id,
        agentConversationId: id,
        participants,
        ownerLifecycle: lifecycle,
        mode: config.mode ?? runtime.mode,
        ...(config.mcpServers ? { mcpServers: [...config.mcpServers] } : {}),
        providerSession: config.providerSession === "load"
          ? { kind: "load", internalSessionId: config.internalSessionId!, onFailure: "error" }
          : { kind: "new" },
        persistence: false,
      });
      const openedConversation = conversation;
      this.live.set(id, openedConversation);
      openedConversation.subscribe((notification) => {
        if (notification.event.kind === "state_changed" && notification.event.state.phase === "stopped") {
          // The stopped state is published before the active turn finishes its
          // error/finalization path. Keep it discoverable to stopAll() until stop()
          // has drained those writes, or Agent.close() may close SQLite too early.
          void openedConversation.stop().then(() => {
            if (this.live.get(id) === openedConversation) this.live.delete(id);
          }, () => {
            if (this.live.get(id) === openedConversation) this.live.delete(id);
          });
        }
      });
      return conversation;
    } catch (error) {
      this.live.delete(id);
      await conversation?.stop().catch(() => undefined);
      throw error;
    } finally {
      releaseSetup();
    }
  }

  private async acquireMeteringSetupLock(id: AgentConversationId): Promise<() => void> {
    const previous = this.meteringSetupLocks.get(id) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const current = previous.then(() => gate);
    this.meteringSetupLocks.set(id, current);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.meteringSetupLocks.get(id) === current) this.meteringSetupLocks.delete(id);
      releaseGate();
    };
  }

  private resolveAdapterId(requested?: string): string {
    if (requested) return requested;
    if (this.settings.defaultAdapterId) return this.settings.defaultAdapterId;
    const registrations = this.agent.adapters.list();
    if (registrations.length === 1) return registrations[0]!.id;
    throw new Error("adapterId is required when an Agent has no unique default adapter");
  }

  /**
   * Persist one conversation error record and its audit intent in a single transaction,
   * then publish it through the committed-record bus.
   *
   * A recording failure never replaces the primary provider diagnosis: it is returned so
   * the caller can attach it to the structured exception instead.
   */
  private async recordConversationError(input: {
    readonly agentConversationId: AgentConversationId;
    readonly attemptId: string;
    readonly source: ConversationErrorSource;
    readonly code: string;
    readonly recoverability: ConversationErrorRecoverability;
    readonly message?: string;
    readonly operationId?: string;
    readonly transitionId?: string;
    readonly internalSessionId?: string;
    readonly details?: ConversationErrorDetails;
  }): Promise<{ readonly record?: ConversationRecord; readonly recordingError?: Error }> {
    const record: NewConversationRecord = {
      recordId: `${input.attemptId}:error`,
      agentSessionId: this.agent.id,
      agentConversationId: input.agentConversationId,
      kind: "error",
      timestamp: new Date().toISOString(),
      source: input.source,
      code: input.code,
      recoverability: input.recoverability,
      ...(input.message === undefined ? {} : { message: input.message }),
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      ...(input.transitionId === undefined ? {} : { transitionId: input.transitionId }),
      ...(input.internalSessionId === undefined ? {} : { internalSessionId: input.internalSessionId }),
      ...(input.details === undefined ? {} : { details: input.details }),
    };
    const level = this.settings.capture.error;
    const audit = this.settings.auditLog;
    let persisted: ConversationRecord | undefined;
    try {
      await this.agent.persistence.transaction(async (persistence) => {
        if (level !== "none") {
          persisted = await persistence.records.append(captureRuntimeRecord(record, level));
        }
        if (audit) {
          await enqueueAuditObservation(persistence, {
            scope: "conversation",
            sourceObservationId: record.recordId,
            ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
            record,
          }, audit);
        }
      });
    } catch (error) {
      return { recordingError: error instanceof Error ? error : new Error(String(error)) };
    }
    if (persisted) this.agent.publishCommittedRecords([persisted]);
    if (audit) this.agent.audit?.notifyPending();
    return persisted ? { record: persisted } : {};
  }

  /**
   * Validate caller-supplied start configuration before any durable write or recorded
   * region.
   *
   * Adapter resolution and mode/provider-thread compatibility are caller mistakes, not
   * conversation failures. Persisting them as provider-session errors would violate the
   * spec and mislead a UI (for example, `retryable` for an adapter that can never resolve).
   */
  private prepareStart(config: {
    readonly adapterId?: string;
    readonly mode?: AgentMode;
    readonly runtime?: AgentConversationRuntimeDefaults;
    readonly providerSession: "new" | "load";
  }): void {
    const adapterId = this.resolveAdapterId(config.adapterId);
    this.agent.adapters.require(adapterId);
    const mode = config.mode ?? config.runtime?.mode ?? this.settings.defaults.mode;
    if (mode === "degraded" && config.providerSession === "load") {
      throw new Error("providerSession.kind=load requires ACP (normal) mode");
    }
  }

  /**
   * Record a failed provider-session creation and throw the structured error. Used where
   * the durable conversation row already exists, so the caller always learns which logical
   * conversation holds the error.
   */
  private async throwCreateFailure(
    id: AgentConversationId,
    attemptId: string,
    error: unknown,
  ): Promise<never> {
    const recorded = await this.recordConversationError({
      agentConversationId: id,
      attemptId,
      source: "provider_session",
      code: "provider_session_create_failed",
      recoverability: "retryable",
      message: "The provider session could not be created.",
      transitionId: attemptId,
    });
    throw new ProviderSessionError({
      agentSessionId: this.agent.id,
      agentConversationId: id,
      attemptId,
      code: "provider_session_create_failed",
      source: "provider_session",
      recoverability: "retryable",
      message: "The provider session could not be created.",
      ...(recorded.record ? { recordId: recorded.record.recordId } : {}),
      ...(recorded.recordingError ? { recordingError: recorded.recordingError } : {}),
      cause: error,
    });
  }

  private async persistProviderSession(
    conversation: AgentConversation,
    id: AgentConversationId,
    extra: { readonly transitionId?: string; readonly metadata?: string } = {},
    newContext = false,
  ): Promise<ProviderAttachmentCommitAcknowledgement> {
    const attachment = conversation.providerAttachmentState;
    if (attachment.kind !== "runtime_only") {
      throw new Error("provider attachment is not awaiting persistence");
    }
    const descriptor = attachment.descriptor;
    const providerSessionRecordId = `provider-${randomUUID()}`;
    await this.agent.persistence.transaction(async (persistence) => {
      if (newContext) await persistence.identityDelivery?.reset(id, descriptor.internalSessionId);
      await persistence.providerSessions.append({
        providerSessionRecordId,
        agentConversationId: id,
        internalSessionId: descriptor.internalSessionId,
        adapterId: descriptor.adapterId,
        mode: descriptor.mode,
        ...(descriptor.model ? { model: descriptor.model } : {}),
        activatedAt: descriptor.acquiredAt,
        ...extra,
      });
    });
    return Object.freeze({
      attachmentAttemptId: descriptor.attachmentAttemptId,
      providerSessionRecordId,
    });
  }
}
