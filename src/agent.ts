import { randomUUID } from "node:crypto";
import {
  type AgentSessionId,
} from "./agent-ids.ts";
import {
  AgentAdapterRegistry,
  type AgentAdapterRegistration,
} from "./agent-adapter-registry.ts";
import {
  NoopAgentIdentityRuntime,
  type AgentIdentityRuntime,
  type IdentityConsistency,
} from "./identity.ts";
import {
  CheckpointBackedIdentityRuntime,
  type CheckpointBackedIdentityConfig,
} from "./identity/checkpoint-backed.ts";
import {
  PersistenceCapabilityError,
  resolveConversationRecordCapture,
  type ConversationRecord,
  type PersistenceBackend,
} from "./persistence/backend.ts";
import { SqliteAgentPersistence } from "./persistence/sqlite-backend.ts";
import {
  resolveAgentAuditLogConfig,
  AgentAuditRuntime,
  type ResolvedAgentAuditLogConfig,
} from "./audit/index.ts";
import { noopLogger } from "./logger.ts";
import {
  CommittedRecordEventBus,
  type AgentEventBus,
} from "./observation/agent-event-bus.ts";
import {
  resolveInternalInferenceConfig,
} from "./internal-inference/config.ts";
import type {
  InternalInferenceManager,
} from "./internal-inference/contracts.ts";
import { DefaultInternalInferenceManager } from "./internal-inference/coordination/manager.ts";
import { HarnessInternalInferenceRuntime } from "./internal-inference/runtime/harness-runtime.ts";
import {
  ConversationCheckpointCoordinator,
  ConversationCheckpointStrategy,
  CONVERSATION_CHECKPOINT_STRATEGY_ID,
  resolveConversationCheckpointingConfig,
} from "./checkpointing/index.ts";

import {
  enqueueAuditObservation,
} from "./agent/record-capture.ts";
import {
  DefaultAgentConversationManager,
} from "./agent/conversation-manager.ts";
import type {
  AgentConfig,
  AgentConversationManager,
} from "./agent/config.ts";

export type {
  AdoptProviderSessionConfig,
  ListProviderSessionsOptions,
  ProviderSessionSummary,
} from "./agent/adoption/index.ts";

export type {
  AgentConversationAuditCaptureConfig,
  AgentConversationPersistenceOverride,
  AgentScopeAuditObservationKind,
  ConversationPersistenceContext,
  ConversationPersistenceResolver,
} from "./agent/persistence-policy/index.ts";

export type {
  AgentConfig,
  AgentConversationManager,
  ClearTranscriptOptions,
  ClearTranscriptResult,
  DeleteConversationOptions,
  DeleteConversationResult,
  AgentConversationRuntimeDefaults,
  AgentPersistenceConfig,
  CreateAgentConversationConfig,
  OpenAgentConversationConfig,
  OpenOwnedAgentConversationResult,
} from "./agent/config.ts";

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
    if (config.conversationPersistence !== undefined && typeof config.conversationPersistence !== "function") {
      throw new Error("conversationPersistence must be a function");
    }
    this.manager = new DefaultAgentConversationManager(this, {
      defaultAdapterId: config.defaultAdapterId,
      identityConsistency: config.identityConsistency ?? "eventual",
      identityTimeoutMs: config.identityTimeoutMs,
      capture: resolveConversationRecordCapture(config.capture),
      ...(config.capture ? { captureConfig: config.capture } : {}),
      ...(config.conversationPersistence ? { conversationPersistence: config.conversationPersistence } : {}),
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

export type { AgentAdapterRegistration, AgentIdentityRuntime, IdentityConsistency };
