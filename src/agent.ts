import { randomUUID } from "node:crypto";
import type * as schema from "@agentclientprotocol/sdk";
import {
  createAgentConversationId,
  type AgentConversationId,
  type AgentSessionId,
} from "./agent-ids.ts";
import {
  AgentAdapterRegistry,
  type AgentAdapterRegistration,
} from "./agent-adapter-registry.ts";
import {
  AgentConversation,
  type AgentConversationConfig,
} from "./agent-session.ts";
import type { AgentMode } from "./controller.ts";
import type { OperationMeteringRecord } from "./metering/record.ts";
import type { MeteredOperationKind } from "./metering/record.ts";
import { MeteringEngine } from "./metering/engine.ts";
import { createModelsDevResolver } from "./metering/catalog/index.ts";
import type { AgentSessionMeteringState } from "./metering/state.ts";
import {
  NoopAgentIdentityRuntime,
  composeIdentityPrompt,
  type AgentIdentityRuntime,
  type IdentityConsistency,
} from "./identity.ts";
import {
  CheckpointBackedIdentityRuntime,
  type CheckpointBackedIdentityConfig,
} from "./identity/checkpoint-backed.ts";
import {
  IMPLICIT_USER_PARTICIPANT_ID,
  PersistenceCapabilityError,
  normalizeParticipantRef,
  resolveConversationRecordCapture,
  shouldCaptureProtocolMethod,
  type AgentConversationSummary,
  type ConversationListOptions,
  type ConversationPage,
  type ConversationPreviewPage,
  type ConversationErrorDetails,
  type ConversationErrorRecoverability,
  type ConversationErrorSource,
  type ConversationRecord,
  type ConversationRecordCaptureConfig,
  type ConversationRecordCapturePolicy,
  type MessageRecord,
  type MeteringRecordRetention,
  type NewConversationRecord,
  type ParticipantRef,
  type PersistenceBackend,
  type PersistenceExtension,
  type PersistenceScope,
  type RecordCaptureLevel,
} from "./persistence/backend.ts";
import { SqliteAgentPersistence } from "./persistence/sqlite-backend.ts";
import {
  projectAgentAuditObservation,
  resolveAgentAuditLogConfig,
  AgentAuditRuntime,
  type AgentAuditLogConfig,
  type NormalizedAgentObservation,
  type ResolvedAgentAuditLogConfig,
} from "./audit/index.ts";
import { noopLogger } from "./logger.ts";
import {
  CommittedRecordEventBus,
  type AgentEventBus,
} from "./observation/agent-event-bus.ts";
import type {
  AgentConversationOwnerLifecycle,
  OwnedPromptCommitResult,
  OwnedPromptCompleted,
  OwnedPromptFailed,
  OwnedPromptInput,
} from "./agent-conversation-owner.ts";
import { OwnedPromptPostCommitError } from "./agent-conversation-owner.ts";
import { ProviderSessionError } from "./agent-conversation-errors.ts";
import {
  OUT_OF_BAND_MESSAGE_ORIGIN,
  composeProviderPrompt,
  pendingOutOfBandMessages,
  type AppendAssistantMessageInput,
} from "./out-of-band-messages.ts";
import { buildConversationErrorDetails } from "./persistence/error-records.ts";
import type {
  ProviderAttachmentCommitAcknowledgement,
} from "./persistence/provider-attachment.ts";
import {
  resolveInternalInferenceConfig,
  type InternalInferenceConfig,
} from "./internal-inference/config.ts";
import type {
  InternalInferenceManager,
  InternalInferenceStrategy,
} from "./internal-inference/contracts.ts";
import { DefaultInternalInferenceManager } from "./internal-inference/coordination/manager.ts";
import type { InternalInferenceSnapshot } from "./internal-inference/contracts.ts";
import { HarnessInternalInferenceRuntime } from "./internal-inference/runtime/harness-runtime.ts";
import {
  ConversationCheckpointCoordinator,
  ConversationCheckpointStrategy,
  CONVERSATION_CHECKPOINT_STRATEGY_ID,
  buildRecoverySeed,
  classifyProviderSessionLoadError,
  resolveConversationCheckpointingConfig,
  type ConversationCheckpointingConfig,
  type ConversationRecoveryProgress,
  type ConversationRecoveryResult,
  type ResolvedConversationCheckpointingConfig,
} from "./checkpointing/index.ts";

export type AgentPersistenceConfig =
  | {
      readonly kind: "sqlite";
      readonly path: string;
      readonly metadata?: string;
      readonly busyTimeoutMs?: number;
      readonly extensions?: readonly PersistenceExtension[];
      readonly allowUnsafeWalVersion?: boolean;
    }
  | { readonly kind: "custom"; readonly backend: PersistenceBackend };

type OwnerControlledConversationKey =
  | "adapter"
  | "adapterId"
  | "agentSessionId"
  | "agentConversationId"
  | "ownerAgentSessionId"
  | "participants"
  | "ownerLifecycle"
  | "providerSession"
  | "persistence"
  | "transcriptPath"
  | "transcriptDir"
  | "sessions";

export type AgentConversationRuntimeDefaults = Omit<
  AgentConversationConfig,
  OwnerControlledConversationKey
>;

export interface AgentConfig {
  readonly id?: AgentSessionId;
  readonly persistence: AgentPersistenceConfig;
  readonly adapters: Readonly<Record<string, import("./adapters.ts").Adapter>>
    | readonly AgentAdapterRegistration[];
  readonly defaultAdapterId?: string;
  readonly identity?: AgentIdentityRuntime | CheckpointBackedIdentityConfig;
  readonly identityConsistency?: IdentityConsistency;
  readonly identityTimeoutMs?: number;
  readonly capture?: ConversationRecordCaptureConfig;
  readonly conversationDefaults?: AgentConversationRuntimeDefaults;
  /** Bounded metering state is always persisted; this controls detailed local history. */
  readonly meteringPersistence?: {
    readonly meteringRecords?: MeteringRecordRetention;
  };
  readonly internalInference?: InternalInferenceConfig & {
    readonly strategies?: readonly InternalInferenceStrategy[];
  };
  readonly checkpointing?: ConversationCheckpointingConfig;
  readonly auditLog?: false | AgentAuditLogConfig;
}

export interface CreateAgentConversationConfig {
  readonly id?: AgentConversationId;
  readonly adapterId?: string;
  readonly mode?: AgentMode;
  readonly participants?: readonly ParticipantRef[];
  readonly title?: string;
  readonly metadata?: string;
  readonly mcpServers?: schema.McpServer[];
  readonly runtime?: AgentConversationRuntimeDefaults;
}

export interface OpenAgentConversationConfig {
  readonly adapterId?: string;
  readonly mode?: AgentMode;
  readonly mcpServers?: schema.McpServer[];
  readonly runtime?: AgentConversationRuntimeDefaults;
  readonly onRecoveryProgress?: (event: ConversationRecoveryProgress) => void;
}

export interface OpenOwnedAgentConversationResult {
  readonly conversation: AgentConversation;
  readonly providerSession: "already_open" | "loaded" | "new" | "recovered";
  readonly recovery?: ConversationRecoveryResult;
}

export interface AgentConversationManager {
  create(config?: CreateAgentConversationConfig): Promise<AgentConversation>;
  open(
    id: AgentConversationId,
    config?: OpenAgentConversationConfig,
  ): Promise<OpenOwnedAgentConversationResult>;
  get(id: AgentConversationId): Promise<AgentConversationSummary | null>;
  list(options?: ConversationListOptions): Promise<ConversationPage>;
  listPreviews(options?: ConversationListOptions): Promise<ConversationPreviewPage>;
  delete(id: AgentConversationId, deletedAt?: string): Promise<void>;
  /**
   * Append a completed assistant message the provider did not produce, without a turn or a
   * live provider session. It is published on `agent.events`, and the conversation's next
   * turn shows it to the provider ahead of the user's text.
   */
  appendAssistantMessage(
    id: AgentConversationId,
    input: AppendAssistantMessageInput,
  ): Promise<MessageRecord>;
}

/** Durable owner of one agent identity, its adapters, identity runtime, and conversations. */
export class Agent {
  readonly id: AgentSessionId;
  readonly persistence: PersistenceBackend;
  readonly identity: AgentIdentityRuntime;
  readonly adapters: AgentAdapterRegistry;
  readonly conversations: AgentConversationManager;
  readonly internalInferences?: InternalInferenceManager;
  readonly checkpointing?: ConversationCheckpointCoordinator;
  readonly audit?: AgentAuditRuntime;
  /** Process-local stream of committed canonical conversation records. */
  readonly events: AgentEventBus;

  private readonly eventBus: CommittedRecordEventBus;
  private readonly manager: DefaultAgentConversationManager;
  private auditObservationTail: Promise<void> = Promise.resolve();
  private auditObservationError: unknown;
  private detachInternalInferenceAudit?: () => void;
  private closed = false;

  private constructor(
    id: AgentSessionId,
    persistence: PersistenceBackend,
    identity: AgentIdentityRuntime | CheckpointBackedIdentityConfig | undefined,
    adapters: AgentAdapterRegistry,
    config: AgentConfig,
    private readonly auditLog: ResolvedAgentAuditLogConfig | null,
    audit: AgentAuditRuntime | undefined,
  ) {
    this.id = id;
    this.persistence = persistence;
    this.adapters = adapters;
    this.audit = audit;
    const logger = config.conversationDefaults?.logger ?? noopLogger;
    this.eventBus = new CommittedRecordEventBus({
      agentSessionId: id,
      onListenerError: ({ error, event }) => {
        // A subscriber is observation, never operation authority: log and move on. It must
        // not become an error record, which would recursively emit another event.
        logger.warn("agent_event_listener_failed", {
          error: error instanceof Error ? error.message : String(error),
          deliverySequence: event.deliverySequence,
        });
      },
    });
    this.events = this.eventBus;
    const checkpointing = config.checkpointing
      ? resolveConversationCheckpointingConfig(config.checkpointing)
      : null;
    const checkpointBackedIdentity = identity && !("load" in identity) && identity.kind === "checkpoint-backed"
      ? identity
      : null;
    if (identity && !("load" in identity) && !checkpointBackedIdentity) {
      throw new Error("unknown built-in identity configuration");
    }
    if (checkpointBackedIdentity) {
      if (!checkpointing?.enabled) {
        throw new Error("checkpoint-backed identity requires enabled conversation checkpointing");
      }
      if (!persistence.identityDelivery || !persistence.recoveryCheckpoints) {
        throw new Error("checkpoint-backed identity requires delivery cursor persistence");
      }
    }
    this.identity = checkpointBackedIdentity
      ? new CheckpointBackedIdentityRuntime(
        persistence,
        checkpointBackedIdentity,
        async (source) => { await this.checkpointing?.request(source); },
      )
      : identity && "load" in identity
        ? identity
        : new NoopAgentIdentityRuntime();
    this.manager = new DefaultAgentConversationManager(this, {
      defaultAdapterId: config.defaultAdapterId,
      identityConsistency: config.identityConsistency ?? "eventual",
      identityTimeoutMs: config.identityTimeoutMs,
      capture: resolveConversationRecordCapture(config.capture),
      defaults: config.conversationDefaults ?? {},
      meteringRecords: config.meteringPersistence?.meteringRecords ?? "all",
      checkpointing,
      auditLog,
      auditIdentityUpdate: async (agentConversationId, records) => {
        if (records.length === 0) return;
        await this.recordAgentAuditObservation("identity", "updated", {
          agentConversationId,
          sourceRecordIds: records.map((record) => record.recordId),
        }, `identity:${records.map((record) => record.recordId).join(":")}`);
      },
    });
    this.conversations = this.manager;
    if (checkpointing?.enabled) {
      const messageCapture = resolveConversationRecordCapture(config.capture).message;
      if (messageCapture !== "content" && messageCapture !== "raw") {
        throw new Error("conversation checkpointing requires message capture at content or raw level");
      }
    }
    if (config.internalInference || checkpointing?.enabled) {
      const inferenceConfig = config.internalInference ?? {};
      const settings = resolveInternalInferenceConfig(inferenceConfig);
      if (!persistence.internalInferences) {
        throw new Error("persistence backend does not support internal inference");
      }
      const runtime = settings.runtime ?? new HarnessInternalInferenceRuntime({
        controllerConfig: (request) => ({
          adapter: adapters.require(request.adapterId),
          adapterId: request.adapterId,
          ...(config.conversationDefaults?.launcher
            ? { launcher: config.conversationDefaults.launcher }
            : {}),
          ...(config.conversationDefaults?.execPrefix
            ? { execPrefix: config.conversationDefaults.execPrefix }
            : {}),
          ...(config.conversationDefaults?.env ? { env: config.conversationDefaults.env } : {}),
          ...(config.conversationDefaults?.cwd ? { cwd: config.conversationDefaults.cwd } : {}),
          ...(config.conversationDefaults?.clientInfo
            ? { clientInfo: config.conversationDefaults.clientInfo }
            : {}),
          ...(config.conversationDefaults?.clientCapabilities
            ? { clientCapabilities: config.conversationDefaults.clientCapabilities }
            : {}),
          ...(config.conversationDefaults?.logger
            ? { logger: config.conversationDefaults.logger }
            : {}),
          ...(config.conversationDefaults?.wire ? { wire: config.conversationDefaults.wire } : {}),
        }),
      });
      const strategies = [...(inferenceConfig.strategies ?? [])];
      if (checkpointing?.enabled) {
        if (strategies.some((strategy) =>
          strategy.purpose === "conversation_checkpoint"
          && strategy.strategyId === CONVERSATION_CHECKPOINT_STRATEGY_ID
          && strategy.version === 1)) {
          throw new Error("the built-in conversation checkpoint strategy is already registered");
        }
        strategies.push(new ConversationCheckpointStrategy());
      }
      this.internalInferences = new DefaultInternalInferenceManager({
        agentSessionId: id,
        repository: persistence.internalInferences,
        persistence,
        runtime,
        settings,
        strategies,
        meteringRecords: config.meteringPersistence?.meteringRecords ?? "all",
        beginMetering: async (attempt, session) => {
          return await this.manager.beginInternalInferenceMetering(attempt, session);
        },
        onCommittedRecords: (records) => this.publishCommittedRecords(records),
        resolveAdapterId: async (requestedAdapterId, agentConversationId) => {
          if (requestedAdapterId) {
            adapters.require(requestedAdapterId);
            return requestedAdapterId;
          }
          if (settings.adapter !== "same") {
            adapters.require(settings.adapter);
            return settings.adapter;
          }
          if (agentConversationId) {
            const active = await persistence.providerSessions.active(agentConversationId);
            if (active) {
              adapters.require(active.adapterId);
              return active.adapterId;
            }
          }
          const fallback = config.defaultAdapterId ?? adapters.list()[0]?.id;
          if (!fallback) throw new Error("internal inference could not resolve an adapter");
          adapters.require(fallback);
          return fallback;
        },
      });
      if (auditLog) {
        this.detachInternalInferenceAudit = this.internalInferences.subscribe((event) => {
          this.queueAgentAuditObservation(
            "internal_inference",
            event.snapshot.stage,
            event.snapshot as unknown as import("./persistence/backend.ts").PersistenceJsonValue,
            `internal-inference:${event.inferenceId}:${event.sequence}`,
            event.inferenceId,
          );
        });
      }
      if (checkpointing?.enabled) {
        this.checkpointing = new ConversationCheckpointCoordinator(
          persistence,
          this.internalInferences,
          checkpointing,
        );
      }
    }
  }

  static async open(config: AgentConfig): Promise<Agent> {
    const auditLog = config.auditLog && resolveAgentAuditLogConfig(config.auditLog);
    if (auditLog && config.persistence.kind === "custom") {
      throw new PersistenceCapabilityError("auditOutbox");
    }
    const registrations = Array.isArray(config.adapters)
      ? config.adapters
      : Object.entries(config.adapters).map(([id, adapter]) => ({ id, adapter }));
    const adapters = new AgentAdapterRegistry(registrations);
    if (adapters.list().length === 0) throw new Error("Agent requires at least one adapter");
    if (config.defaultAdapterId) adapters.require(config.defaultAdapterId);

    let persistence: PersistenceBackend;
    let id: AgentSessionId;
    if (config.persistence.kind === "custom") {
      persistence = config.persistence.backend;
      id = config.id ?? persistence.identityRecord.agentSessionId;
      if (persistence.identityRecord.agentSessionId !== id) {
        throw new Error(
          `custom persistence belongs to ${persistence.identityRecord.agentSessionId}, not ${id}`,
        );
      }
    } else {
      persistence = await SqliteAgentPersistence.open({
        path: config.persistence.path,
        ...(config.id ? { agentSessionId: config.id } : {}),
        ...(config.persistence.metadata !== undefined ? { metadata: config.persistence.metadata } : {}),
        ...(config.persistence.busyTimeoutMs !== undefined
          ? { busyTimeoutMs: config.persistence.busyTimeoutMs }
          : {}),
        ...(config.persistence.extensions ? { extensions: config.persistence.extensions } : {}),
        ...(config.persistence.allowUnsafeWalVersion !== undefined
          ? { allowUnsafeWalVersion: config.persistence.allowUnsafeWalVersion }
          : {}),
      });
      id = persistence.identityRecord.agentSessionId;
    }
    let audit: AgentAuditRuntime | undefined;
    try {
      if (auditLog) {
        if (!persistence.auditOutbox) throw new PersistenceCapabilityError("auditOutbox");
        const state = await persistence.auditOutbox.state();
        const initialized = await persistence.auditOutbox.initialize(
          state?.auditLogId ?? `audlog-${randomUUID()}`,
          auditLog.captureFingerprint,
        );
        audit = await AgentAuditRuntime.open({
          persistence,
          agentSessionId: id,
          config: auditLog,
          auditState: initialized,
        });
      }
      const agent = new Agent(
        id,
        persistence,
        config.identity,
        adapters,
        config,
        auditLog || null,
        audit,
      );
      await agent.recordAgentAuditObservation("agent_lifecycle", "opened");
      return agent;
    } catch (error) {
      await audit?.close().catch(() => undefined);
      await persistence.close().catch(() => undefined);
      throw error;
    }
  }

  static async create(config: AgentConfig): Promise<Agent> {
    return await Agent.open(config);
  }

  /**
   * Publish records whose persistence transaction has already committed.
   *
   * Internal to the Agent-owned persistence boundary; it is not a public write API. Keeping
   * publication here is what makes "an event requires an assigned canonical sequence"
   * mechanically true rather than a convention each producer must remember.
   *
   * @internal
   */
  publishCommittedRecords(records: readonly ConversationRecord[]): void {
    this.eventBus.publish(records);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let shutdownError: unknown;
    try {
      this.checkpointing?.close();
      await (this.internalInferences as DefaultInternalInferenceManager | undefined)?.close();
      this.detachInternalInferenceAudit?.();
      this.detachInternalInferenceAudit = undefined;
      await this.auditObservationTail;
      const observationError = this.auditObservationError;
      await this.manager.stopAll();
      // Every authorized shutdown write has finished; nothing may be observed after this.
      this.eventBus.close();
      await this.recordAgentAuditObservation("agent_lifecycle", "closed");
      if (observationError !== undefined) throw observationError;
    } catch (error) {
      shutdownError = error;
    }
    const cleanupErrors: unknown[] = [];
    try {
      await this.audit?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await this.persistence.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (shutdownError !== undefined) cleanupErrors.unshift(shutdownError);
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "agent shutdown failed");
  }

  private async recordAgentAuditObservation(
    kind: "agent_lifecycle" | "identity" | "internal_inference",
    state: string,
    payload?: import("./persistence/backend.ts").PersistenceJsonValue,
    sourceObservationId = `${kind}-${randomUUID()}`,
    operationId?: string,
  ): Promise<void> {
    const auditLog = this.auditLog;
    if (!auditLog) return;
    await enqueueAuditObservation(this.persistence, {
      scope: "agent",
      sourceObservationId,
      agentSessionId: this.id,
      kind,
      occurredAt: new Date().toISOString(),
      state,
      ...(operationId ? { operationId } : {}),
      ...(payload !== undefined ? { payload } : {}),
    }, auditLog);
    this.audit?.notifyPending();
  }

  private queueAgentAuditObservation(
    kind: "agent_lifecycle" | "identity" | "internal_inference",
    state: string,
    payload?: import("./persistence/backend.ts").PersistenceJsonValue,
    sourceObservationId?: string,
    operationId?: string,
  ): void {
    const write = this.auditObservationTail.then(() => this.recordAgentAuditObservation(
      kind,
      state,
      payload,
      sourceObservationId,
      operationId,
    ));
    this.auditObservationTail = write.catch((error) => {
      if (this.auditObservationError === undefined) this.auditObservationError = error;
    });
  }
}

interface ManagerSettings {
  readonly defaultAdapterId?: string;
  readonly identityConsistency: IdentityConsistency;
  readonly identityTimeoutMs?: number;
  readonly capture: ConversationRecordCapturePolicy;
  readonly defaults: AgentConversationRuntimeDefaults;
  readonly meteringRecords: MeteringRecordRetention;
  readonly checkpointing: ResolvedConversationCheckpointingConfig | null;
  readonly auditLog: ResolvedAgentAuditLogConfig | null;
  readonly auditIdentityUpdate: (
    agentConversationId: AgentConversationId,
    records: readonly ConversationRecord[],
  ) => Promise<void>;
}

class DefaultAgentConversationManager implements AgentConversationManager {
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
  ): Promise<import("./internal-inference/contracts.ts").InternalInferenceMeteringOperation | null> {
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

class PersistedConversationLifecycle implements AgentConversationOwnerLifecycle {
  constructor(
    private readonly agent: Agent,
    private readonly conversationId: AgentConversationId,
    private readonly initialParticipants: readonly ParticipantRef[],
    private readonly settings: ManagerSettings,
  ) {}

  async beforePrompt(input: OwnedPromptInput) {
    const participant = await this.resolveParticipant(input.participantId);
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
    const records = await this.appendMessages([{
      recordId: `${input.operationId}:user`,
      agentSessionId: this.agent.id,
      agentConversationId: this.conversationId,
      kind: "message",
      timestamp: new Date().toISOString(),
      role: "user",
      participantId: participant.id,
      ...(input.consumerMetadata !== undefined ? { consumerMetadata: input.consumerMetadata } : {}),
      content: input.text,
      status: "completed",
      metadata: JSON.stringify({ operationId: input.operationId }),
    }]);
    await this.updateIdentity(records);
    // Read after the user record commits so a concurrent append falls in this turn or the next.
    const outOfBand = records[0]
      ? await pendingOutOfBandMessages(
          this.agent.persistence,
          this.conversationId,
          input.targetProviderContextId,
          records[0].sequence,
        )
      : [];
    return Object.freeze({
      providerText: composeProviderPrompt(input.text, identity.promptPreamble, outOfBand),
      participant,
      ...(identity.deliveryReceipt ? { identityDeliveryReceipt: identity.deliveryReceipt } : {}),
    });
  }

  async afterPrompt(input: OwnedPromptCompleted): Promise<OwnedPromptCommitResult> {
    const timestamp = new Date().toISOString();
    const status = input.result.status === "error" ? "failed" : input.result.status;
    const records = input.result.messages.map((message, index): NewConversationRecord => ({
      recordId: `${input.operationId}:assistant:${index + 1}`,
      agentSessionId: this.agent.id,
      agentConversationId: this.conversationId,
      kind: "message",
      timestamp,
      role: "assistant",
      logicalMessageId: `message:${input.operationId}:assistant:${index + 1}`,
      content: message.text,
      status,
      metadata: JSON.stringify({
        operationId: input.operationId,
        ...(message.messageId ? { providerMessageId: message.messageId } : {}),
      }),
    }));
    const persisted: ConversationRecord[] = [];
    let providerAttachment: ProviderAttachmentCommitAcknowledgement | undefined;
    await this.agent.persistence.transaction(async (persistence) => {
      await this.persistObservationsInTransaction(persistence, records, true, persisted);
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
    const timestamp = new Date().toISOString();
    const records = input.messages.map((message, index): NewConversationRecord => ({
      recordId: `${input.operationId}:assistant:${index + 1}`,
      agentSessionId: this.agent.id,
      agentConversationId: this.conversationId,
      kind: "message",
      timestamp,
      role: "assistant",
      logicalMessageId: `message:${input.operationId}:assistant:${index + 1}`,
      content: message.text,
      status: "failed",
      metadata: JSON.stringify({
        operationId: input.operationId,
        ...(message.messageId ? { providerMessageId: message.messageId } : {}),
      }),
    }));
    await this.updateIdentity(await this.appendMessages(records));
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

  async record(record: NewConversationRecord): Promise<void> {
    const streamingSnapshot = record.kind === "message" && record.status === "in_progress";
    const persisted = await this.persistObservations([record], !streamingSnapshot);
    // A streaming snapshot is a display revision, not a second completed response.
    if (!streamingSnapshot) {
      await this.updateIdentity(persisted);
    }
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

async function updateConversationIdentity(
  agent: Agent,
  settings: ManagerSettings,
  conversationId: AgentConversationId,
  records: readonly ConversationRecord[],
): Promise<void> {
  await agent.identity.update({
    agentSessionId: agent.id,
    agentConversationId: conversationId,
    records,
  });
  await settings.auditIdentityUpdate(conversationId, records);
}

/** Persist canonical records and their audit intents in one transaction, then publish them. */
async function persistConversationObservations(
  agent: Agent,
  settings: ManagerSettings,
  records: readonly NewConversationRecord[],
  audit = true,
): Promise<readonly ConversationRecord[]> {
  if (records.length === 0) return Object.freeze([]);
  if ((!audit || !settings.auditLog) && records.every((record) => {
    if (record.kind !== "protocol") return settings.capture[record.kind] === "none";
    return settings.capture.protocol.level === "none"
      || !shouldCaptureProtocolMethod(settings.capture.protocol, record.method);
  })) return Object.freeze([]);
  const persisted: ConversationRecord[] = [];
  await agent.persistence.transaction(async (persistence) => {
    await persistObservationsInTransaction(settings, persistence, records, audit, persisted);
  });
  agent.publishCommittedRecords(persisted);
  if (audit && settings.auditLog) agent.audit?.notifyPending();
  return Object.freeze(persisted);
}

async function persistObservationsInTransaction(
  settings: ManagerSettings,
  persistence: PersistenceScope,
  records: readonly NewConversationRecord[],
  audit: boolean,
  persisted: ConversationRecord[],
): Promise<void> {
  for (const record of records) {
    const level = record.kind === "protocol"
      ? settings.capture.protocol.level
      : settings.capture[record.kind];
    const canonicalAccepted = level !== "none" && (
      record.kind !== "protocol"
      || shouldCaptureProtocolMethod(settings.capture.protocol, record.method)
    );
    if (canonicalAccepted) {
      persisted.push(await persistence.records.append(captureRuntimeRecord(record, level)));
    }
    if (audit && settings.auditLog) {
      await enqueueAuditObservation(persistence, {
        scope: "conversation",
        sourceObservationId: record.recordId,
        operationId: operationIdFromMetadata(record.metadata),
        record,
      }, settings.auditLog);
    }
  }
}

function normalizeParticipants(participants?: readonly ParticipantRef[]): readonly ParticipantRef[] {
  const values = participants?.length
    ? participants.map(normalizeParticipantRef)
    : [{ id: IMPLICIT_USER_PARTICIPANT_ID, kind: "user" as const }];
  const seen = new Set<string>();
  for (const participant of values) {
    if (seen.has(participant.id)) throw new Error(`duplicate participant id: ${participant.id}`);
    seen.add(participant.id);
  }
  return Object.freeze(values);
}

function internalInferenceMeteringKind(purpose: string): MeteredOperationKind {
  if (
    purpose === "conversation_checkpoint"
    || purpose === "conversation_recovery"
    || purpose === "identity_update"
  ) return purpose;
  return "internal_command";
}

function captureRuntimeRecord(
  record: NewConversationRecord,
  level: RecordCaptureLevel,
): NewConversationRecord {
  if (record.kind === "error") {
    // `metadata` omits the display message and details; `content` keeps the message but
    // still omits details; `raw` retains the allow-listed details.
    if (level === "raw") return record;
    const { details: _details, message, ...rest } = record;
    return level === "content"
      ? { ...rest, ...(message === undefined ? {} : { message }) }
      : rest;
  }
  if (level !== "metadata") return record;
  switch (record.kind) {
    case "message":
      return { ...record, content: "" };
    case "tool_call":
      return {
        recordId: record.recordId,
        agentSessionId: record.agentSessionId,
        agentConversationId: record.agentConversationId,
        kind: record.kind,
        timestamp: record.timestamp,
        ...(record.metadata ? { metadata: record.metadata } : {}),
        toolCallId: record.toolCallId,
        state: record.state,
        ...(record.name ? { name: record.name } : {}),
      };
    case "permission":
      return {
        recordId: record.recordId,
        agentSessionId: record.agentSessionId,
        agentConversationId: record.agentConversationId,
        kind: record.kind,
        timestamp: record.timestamp,
        ...(record.metadata ? { metadata: record.metadata } : {}),
        permissionId: record.permissionId,
        state: record.state,
        ...(record.outcome ? { outcome: record.outcome } : {}),
      };
    case "configuration":
      return { ...record, value: undefined };
    case "protocol":
      return { ...record, message: undefined };
    case "native_action":
    case "agent_action":
      return { ...record, input: undefined, output: undefined };
    case "thinking":
      return { ...record, content: "" };
    case "activity":
      return { ...record, content: undefined, data: undefined };
    case "metering":
      return record;
  }
}

async function enqueueAuditObservation(
  persistence: PersistenceBackend | PersistenceScope,
  observation: NormalizedAgentObservation,
  config: ResolvedAgentAuditLogConfig,
): Promise<void> {
  const projected = projectAgentAuditObservation(observation, config.capture);
  if (!projected) return;
  if (!persistence.auditOutbox) throw new PersistenceCapabilityError("auditOutbox");
  await persistence.auditOutbox.enqueue({
    outboxId: `aud-${randomUUID()}`,
    sourceObservationId: projected.sourceObservationId,
    ...(projected.sourceRecordId ? { sourceRecordId: projected.sourceRecordId } : {}),
    ...(projected.operationId ? { operationId: projected.operationId } : {}),
    ...(projected.agentConversationId ? { agentConversationId: projected.agentConversationId } : {}),
    occurredAt: projected.occurredAt,
    kind: projected.kind,
    captureLevel: projected.captureLevel,
    captureFingerprint: config.captureFingerprint,
    payload: projected.payload,
    createdAt: new Date().toISOString(),
  });
}

/** Allow-listed machine-readable detail from a raw ACP error, when it exposes any. */
function providerSessionErrorDetails(error: unknown): ConversationErrorDetails | undefined {
  const value = typeof error === "object" && error !== null
    ? error as { code?: unknown; data?: unknown }
    : null;
  const data = typeof value?.data === "object" && value.data !== null
    ? value.data as Record<string, unknown>
    : undefined;
  return buildConversationErrorDetails({
    rpcCode: typeof value?.code === "number" ? value.code : undefined,
    service: data?.service,
    providerCode: data?.providerCode,
  });
}

function operationIdFromMetadata(metadata: string | undefined): string | undefined {
  if (!metadata) return undefined;
  try {
    const value = JSON.parse(metadata) as { operationId?: unknown };
    return typeof value.operationId === "string" && value.operationId ? value.operationId : undefined;
  } catch {
    return undefined;
  }
}

export { AgentAdapterRegistry, NoopAgentIdentityRuntime, composeIdentityPrompt };
export type { AgentAdapterRegistration, AgentIdentityRuntime, IdentityConsistency };
