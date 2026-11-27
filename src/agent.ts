import { channelSettingsLive, type NativeChannelSettings, type NativeChannelSettingsResult, type NativeRestartOptions, type NativeRestartPreview, type NativeRestartResult, type NativeToolSetting } from "./agent/native-operations.ts";
import { createAgentReminderService, type ReminderService } from "./native/reminders/service.ts";
import { resolveProviderStart } from "./conversation-startup.ts";
import { withDelegationTools } from "./orchestrator/native-delegation.ts";
import { AcpWorkerDelivery } from "./orchestrator/acp-delivery.ts";
import { DurableWorkerAssignments } from "./orchestrator/durable-assignments.ts";
import { workerConsumerApi, type WorkerConsumerApi } from "./orchestrator/consumer-api.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { resolveDelegationToolNames, validateOrchestrator } from "./orchestrator/config.ts";
import { validatePermissionConsumerConfig } from "./permissions/consumer-config.ts";
import { inheritPermissionConfig, ownPermissions } from "./permissions/policy.ts";
import { randomUUID } from "node:crypto";
import {
  type AgentSessionId,
} from "./agent-ids.ts";
import { NativeHarnessHost } from "./native/host.ts";
import { protectedChannels } from "./agent/native-channel-lifecycle.ts";
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
import { withoutHarnessBackgroundWork } from "./internal-inference/runtime/disposable-session-env.ts";
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
import { forgetPendingParts } from "./media/pending.ts";
import type { AgentConversationId } from "./agent-ids.ts";
import type { MediaConfig } from "./media/store.ts";

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
  ProviderStart,
} from "./agent/config.ts";

/** Durable owner of one agent identity, its adapters, identity runtime, and conversations. */
export class Agent {
  readonly media: MediaConfig;
  readonly id: AgentSessionId;
  readonly persistence: PersistenceBackend;
  readonly identity: AgentIdentityRuntime;
  readonly adapters: AgentAdapterRegistry;
  /**
   * The shared native harness host, when `harness` is configured: one process and one durable session
   * for every native conversation of this Agent. Null otherwise.
   */
  readonly nativeHarness: NativeHarnessHost | null;
  readonly reminders: ReminderService;
  readonly conversations: AgentConversationManager;
  /** @internal Delegation routes use this pool. */
  readonly orchestrator?: Orchestrator;
  private readonly acpWorkerDelivery?: AcpWorkerDelivery;
  readonly workers?: WorkerConsumerApi;
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

  /** Remove a kept copy's bytes. Records keep its metadata and a ref that now resolves to nothing. */
  async deleteMedia(ref: string): Promise<void> {
    await (this.media.store ?? this.persistence.media)?.delete(ref);
  }

  /** Remove the bytes of every copy one conversation kept, and its waiting out-of-band parts. */
  async deleteMediaForConversation(owner: AgentConversationId): Promise<void> {
    forgetPendingParts(this, owner);
    const store = this.media.store ?? this.persistence.media;
    if (store) for (const media of await store.list(owner)) await store.delete(media.ref);
  }

  private constructor(
    id: AgentSessionId,
    persistence: PersistenceBackend,
    identity: AgentIdentityRuntime | CheckpointBackedIdentityConfig | undefined,
    adapters: AgentAdapterRegistry,
    config: AgentConfig,
    private readonly auditLog: ResolvedAgentAuditLogConfig | null,
    audit: AgentAuditRuntime | undefined,
  ) {
    this.media = config.media ?? {};
    this.id = id;
    if (config.orchestrator) validateOrchestrator(config.orchestrator, persistence, resolveConversationRecordCapture(config.capture).message);
    this.persistence = persistence;
    this.adapters = adapters;
    const orchestration = config.orchestrator;
    if (orchestration) {
      const toolNames = resolveDelegationToolNames(orchestration.toolNames, orchestration.workerApprovals);
      this.wrapNativeFunctions = functions => withDelegationTools(functions, orchestration,
        () => this.orchestrator!, () => this.conversations, toolNames, id => this.manager.liveConversation(id));
    }
    const channels = config.harness ? protectedChannels(persistence) : undefined;
    this.nativeHarness = config.harness
      ? new NativeHarnessHost({
        sessionId: id,
        ...config.harness,
        ...(this.wrapNativeFunctions ? { functions: this.wrapNativeFunctions(config.harness.functions) } : {}),
        ...(config.harness.launcher ?? config.conversationDefaults?.launcher
          ? { launcher: config.harness.launcher ?? config.conversationDefaults!.launcher }
          : {}),
        ...(config.conversationDefaults?.logger ? { logger: config.conversationDefaults.logger } : {}),
      }, channels, persistence.workerDelivery)
      : null;
    this.reminders = createAgentReminderService(this.nativeHarness, persistence, config.reminders, config.conversationDefaults?.logger);
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
      ...(config.auditLog && config.auditLog.capture ? { auditCaptureConfig: config.auditLog.capture } : {}),
      ...(config.conversationPersistence ? { conversationPersistence: config.conversationPersistence } : {}),
      defaults: {
        ...config.conversationDefaults,
        ...inheritPermissionConfig(config, config.conversationDefaults),
        ...(config.operationLifecycle ? { operationLifecycle: config.operationLifecycle } : {}),
      },
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
    if (config.orchestrator) {
      const workerOptions = config.orchestrator.workers;
      const adapterId = workerOptions.adapterId ?? config.defaultAdapterId ?? adapters.list()[0]?.id;
      if (!adapterId || adapters.native(adapterId)) throw new Error("orchestrator workers require an ACP adapter");
      adapters.require(adapterId);
      const acpDelivery = this.acpWorkerDelivery = new AcpWorkerDelivery(persistence.workerDelivery!,
        (id, input, stableId) => this.manager.appendAssistantMessage(id, input, stableId), logger);
      const assignments = new DurableWorkerAssignments(persistence, () => acpDelivery.flush(),
        () => this.nativeHarness?.flushWorkerDelivery());
      this.orchestrator = new Orchestrator(persistence.workers!, this.conversations, { ...workerOptions, adapterId,
        defaultPermissions: config.orchestrator.defaults?.workerPermissions }, logger,
        event => this.eventBus.publishWorker(event), assignments, id => this.manager.liveConversation(id),
        this.nativeHarness && config.orchestrator.workerApprovals && config.orchestrator.workerApprovals !== "consumer" ? {
          config: config.orchestrator, send: this.nativeHarness.sendWorkerApprovalNotice.bind(this.nativeHarness),
        } : undefined);
      this.workers = workerConsumerApi(this.orchestrator);
    }
    if (checkpointing?.enabled) {
      // Checkpoints summarize stored messages, so `metadata` (messages with no text) would checkpoint nothing
      // useful. `none` is allowed: a conversation that stores no messages has nothing to checkpoint, and the
      // conversations that need recovery override to `content` through the resolver.
      const messageCapture = resolveConversationRecordCapture(config.capture).message;
      if (messageCapture === "metadata") {
        throw new Error('conversation checkpointing cannot use message capture "metadata"');
      }
    }
    if (config.internalInference || checkpointing?.enabled) {
      const inferenceConfig = config.internalInference ?? {};
      const settings = resolveInternalInferenceConfig(inferenceConfig);
      if (!persistence.internalInferences) {
        throw new Error("persistence backend does not support internal inference");
      }
      const suppressBackgroundWork = inferenceConfig.suppressHarnessBackgroundWork !== false;
      const runtime = settings.runtime ?? new HarnessInternalInferenceRuntime({
        controllerConfig: (request) => {
          const adapter = adapters.require(request.adapterId);
          const defaults = config.conversationDefaults;
          const launch = suppressBackgroundWork
            ? withoutHarnessBackgroundWork(request.adapterId, adapter, {
              ...(defaults?.env ? { env: defaults.env } : {}),
              ...(defaults?.launcher ? { launcher: defaults.launcher } : {}),
            })
            : { env: defaults?.env, launcher: defaults?.launcher };
          return {
            adapter,
            adapterId: request.adapterId,
            operationLifecycle: config.operationLifecycle ?? defaults?.operationLifecycle,
            ...(launch.launcher ? { launcher: launch.launcher } : {}),
            ...(defaults?.execPrefix ? { execPrefix: defaults.execPrefix } : {}),
            ...(launch.env ? { env: launch.env } : {}),
            ...(defaults?.cwd ? { cwd: defaults.cwd } : {}),
            ...(defaults?.clientInfo ? { clientInfo: defaults.clientInfo } : {}),
            ...(defaults?.clientCapabilities ? { clientCapabilities: defaults.clientCapabilities } : {}),
            ...(defaults?.logger ? { logger: defaults.logger } : {}),
            ...(defaults?.wire ? { wire: defaults.wire } : {}),
          };
        },
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
        onCommittedRecords: (records) => {
          this.publishCommittedRecords(records);
          // A record appended under a conversation's audit policy queued an audit entry in the same transaction.
          this.audit?.notifyPending();
        },
        resolveConversationWrites: (agentConversationId) => this.manager.writePolicyFor(agentConversationId),
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
            event.snapshot.agentConversationId,
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
    validatePermissionConsumerConfig(config.conversationDefaults);
    resolveProviderStart(config.conversationDefaults?.providerStart);
    config = {
      ...config,
      permissions: ownPermissions(config.permissions),
      conversationDefaults: config.conversationDefaults && {
        ...config.conversationDefaults,
        permissions: ownPermissions(config.conversationDefaults.permissions),
      },
    };
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
    if (!config.harness && adapters.list().some((registration) => adapters.native(registration.id))) {
      throw new Error("a native adapter requires AgentConfig.harness");
    }

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
      await agent.acpWorkerDelivery?.flush();
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

  private nativeOperationHost(): NativeHarnessHost {
    if (this.closed) throw new Error("Agent is closed");
    if (!this.nativeHarness) throw new Error("Agent has no native harness");
    return this.nativeHarness;
  }

  async previewNativeRestart(): Promise<NativeRestartPreview> {
    this.nativeOperationHost();
    const conversationIds: AgentConversationId[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.conversations.list({ cursor });
      for (const conversation of page.conversations) {
        if (!conversation.deletedAt && conversation.controllerKind === "native") conversationIds.push(conversation.agentConversationId);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return { conversationIds, conversationCount: conversationIds.length };
  }

  private readonly nativeOperationsLifetime = new AbortController();

  waitForNativeIdle(options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.nativeOperationHost().waitForIdle(options.signal ? AbortSignal.any([options.signal, this.nativeOperationsLifetime.signal]) : this.nativeOperationsLifetime.signal);
  }

  private readonly wrapNativeFunctions?: (functions: NonNullable<AgentConfig["harness"]>["functions"]) => NonNullable<AgentConfig["harness"]>["functions"];
  private nativeRestart?: Promise<NativeRestartResult>;
  private readonly nativeRestartListeners = new Set<(result: NativeRestartResult) => void>();

  subscribeNativeRestart(listener: (result: NativeRestartResult) => void): () => void {
    this.nativeRestartListeners.add(listener);
    return () => { this.nativeRestartListeners.delete(listener); };
  }

  restartNative(options: NativeRestartOptions = {}): Promise<NativeRestartResult> {
    if (this.nativeRestart) return this.nativeRestart;
    const host = this.nativeOperationHost();
    return this.nativeRestart = (async () => {
      const preview = await this.previewNativeRestart();
      const interruptedTurns: { channel: string; turnId: string }[] = [];
      let result: NativeRestartResult;
      try {
        const signal = options.signal ? AbortSignal.any([options.signal, this.nativeOperationsLifetime.signal]) : this.nativeOperationsLifetime.signal;
        const functions = options.functions !== undefined && this.wrapNativeFunctions
          ? this.wrapNativeFunctions(options.functions ?? undefined) : options.functions;
        await host.restartForAgent({ ...options, signal, functions }, interruptedTurns);
        const mcp = host.mcpSnapshot();
        result = { ...preview, kind: "restarted", interruptedTurns, mcp, conversations: preview.conversationIds.map(id =>
          ({ id, outcome: host.channel(id) ? "reconnected" : "deferred" })) };
      } catch (error) {
        result = { ...preview, kind: "restart_failed", interruptedTurns, error,
          conversations: preview.conversationIds.map(id => ({ id, outcome: "failed" })) };
      }
      for (const listener of this.nativeRestartListeners) {
        try { listener(result); } catch { /* Observers cannot change the restart outcome. */ }
      }
      return result;
    })().finally(() => { this.nativeRestart = undefined; });
  }

  nativeMcpStatus() { return this.nativeOperationHost().mcpStatus(); }

  readonly channelSettingsLive = channelSettingsLive;

  async applyNativeChannelSettings(id: AgentConversationId, settings: NativeChannelSettings): Promise<NativeChannelSettingsResult> {
    const host = this.nativeOperationHost();
    const conversation = await this.conversations.get(id);
    if (!conversation || conversation.deletedAt || conversation.controllerKind !== "native") {
      return { state: "unsupported", code: "not_native_conversation" } as const;
    }
    const unsupported = Object.keys(settings).filter(key => !channelSettingsLive.channel.some(field => field === key));
    if (unsupported.length) return { state: "unsupported", code: "channel_settings_not_live", fields: unsupported } as const;
    const { displayName, policy, lifecycle } = settings;
    if ([displayName, policy].some(value => value !== undefined && value !== null && typeof value !== "string")
      || (lifecycle !== undefined && !["open", "suspended", "retired"].includes(lifecycle))) {
      return { state: "unsupported", code: "invalid_channel_settings" } as const;
    }
    if (displayName === undefined && policy === undefined && lifecycle === undefined) return { state: "applied" } as const;
    return host.changeChannel(id, { ...(displayName === undefined ? {} : { displayName }),
      ...(policy === undefined ? {} : { policy }), ...(lifecycle === undefined ? {} : { lifecycle }) });
  }

  applyNativeToolSetting(name: string, setting: NativeToolSetting) {
    const host = this.nativeOperationHost();
    switch (setting) {
      case "enable": return host.enableTool(name);
      case "remove": return host.removeTool(name);
      case "revoke": return host.revokeTool(name);
      case "restore": return host.restoreTool(name);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.nativeOperationsLifetime.abort(new Error("Agent is closed"));
    await this.nativeRestart;
    this.nativeHarness?.closeReminderSupervisors();
    this.manager.cancelStarts();
    let shutdownError: unknown;
    try {
      this.checkpointing?.close();
      await (this.internalInferences as DefaultInternalInferenceManager | undefined)?.close();
      this.detachInternalInferenceAudit?.();
      this.detachInternalInferenceAudit = undefined;
      await this.auditObservationTail;
      const observationError = this.auditObservationError;
      await this.orchestrator?.close();
      await this.manager.stopAll();
      await this.orchestrator?.waitForCompletions();
      await this.acpWorkerDelivery?.flush();
      await this.nativeHarness?.stop();
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
    agentConversationId?: import("./agent-ids.ts").AgentConversationId,
  ): Promise<void> {
    const auditLog = this.auditLog;
    if (!auditLog) return;
    // An observation about a conversation that is kept out of the audit stream is not written. If its policy
    // cannot be resolved the observation is not written either (it never falls back to the Agent's levels,
    // which could record more than the consumer allowed); the error is kept as the pending audit error.
    if (agentConversationId && await this.manager.auditExcluded(agentConversationId)) return;
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
    agentConversationId?: import("./agent-ids.ts").AgentConversationId,
  ): void {
    const write = this.auditObservationTail.then(() => this.recordAgentAuditObservation(
      kind,
      state,
      payload,
      sourceObservationId,
      operationId,
      agentConversationId,
    ));
    this.auditObservationTail = write.catch((error) => {
      if (this.auditObservationError === undefined) this.auditObservationError = error;
    });
  }
}

export type { AgentAdapterRegistration, AgentIdentityRuntime, IdentityConsistency };
