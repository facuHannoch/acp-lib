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
  IMPLICIT_USER_PARTICIPANT_ID,
  normalizeParticipantRef,
  resolveConversationRecordCapture,
  type AgentConversationSummary,
  type ConversationListOptions,
  type ConversationPage,
  type ConversationRecord,
  type ConversationRecordCapturePolicy,
  type MeteringRecordRetention,
  type NewConversationRecord,
  type ParticipantRef,
  type PersistenceBackend,
  type PersistenceExtension,
} from "./persistence/backend.ts";
import { SqliteAgentPersistence } from "./persistence/sqlite-backend.ts";
import type {
  AgentConversationOwnerLifecycle,
  OwnedPromptCompleted,
  OwnedPromptFailed,
  OwnedPromptInput,
} from "./agent-conversation-owner.ts";
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
  isMissingProviderSessionError,
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
  readonly identity?: AgentIdentityRuntime;
  readonly identityConsistency?: IdentityConsistency;
  readonly identityTimeoutMs?: number;
  readonly capture?: Partial<ConversationRecordCapturePolicy>;
  readonly conversationDefaults?: AgentConversationRuntimeDefaults;
  /** Bounded metering state is always persisted; this controls detailed local history. */
  readonly meteringPersistence?: {
    readonly meteringRecords?: MeteringRecordRetention;
  };
  readonly internalInference?: InternalInferenceConfig & {
    readonly strategies?: readonly InternalInferenceStrategy[];
  };
  readonly checkpointing?: ConversationCheckpointingConfig;
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
  delete(id: AgentConversationId, deletedAt?: string): Promise<void>;
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

  private readonly manager: DefaultAgentConversationManager;
  private closed = false;

  private constructor(
    id: AgentSessionId,
    persistence: PersistenceBackend,
    identity: AgentIdentityRuntime,
    adapters: AgentAdapterRegistry,
    config: AgentConfig,
  ) {
    this.id = id;
    this.persistence = persistence;
    this.identity = identity;
    this.adapters = adapters;
    const checkpointing = config.checkpointing
      ? resolveConversationCheckpointingConfig(config.checkpointing)
      : null;
    this.manager = new DefaultAgentConversationManager(this, {
      defaultAdapterId: config.defaultAdapterId,
      identityConsistency: config.identityConsistency ?? "eventual",
      identityTimeoutMs: config.identityTimeoutMs,
      capture: resolveConversationRecordCapture(config.capture),
      defaults: config.conversationDefaults ?? {},
      meteringRecords: config.meteringPersistence?.meteringRecords ?? "all",
      checkpointing,
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
    return new Agent(
      id,
      persistence,
      config.identity ?? new NoopAgentIdentityRuntime(),
      adapters,
      config,
    );
  }

  static async create(config: AgentConfig): Promise<Agent> {
    return await Agent.open(config);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.checkpointing?.close();
    await (this.internalInferences as DefaultInternalInferenceManager | undefined)?.close();
    await this.manager.stopAll();
    await this.persistence.close();
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
    await this.agent.persistence.conversations.create({
      agentSessionId: this.agent.id,
      agentConversationId: id,
      participants,
      ...(config.title !== undefined ? { title: config.title } : {}),
      ...(config.metadata !== undefined ? { metadata: config.metadata } : {}),
    });
    return await this.start(id, participants, {
      ...config,
      providerSession: "new",
    });
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
      const recovery = this.settings.checkpointing?.recovery;
      if (
        !active
        || recovery?.onLoadFailure !== "recover"
        || !isMissingProviderSessionError(error, recovery.isMissingProviderSession)
      ) throw error;
      config.onRecoveryProgress?.({ stage: "load_failed" });
      config.onRecoveryProgress?.({ stage: "loading_checkpoint" });
      const checkpoint = await this.agent.persistence.recoveryCheckpoints?.latest(id);
      if (!checkpoint) throw error;
      config.onRecoveryProgress?.({ stage: "loading_checkpoint", checkpointId: checkpoint.checkpointId });
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
        deferProviderSessionPersistence: true,
      });
      try {
        config.onRecoveryProgress?.({ stage: "seeding", checkpointId: checkpoint.checkpointId });
        await conversation.seedRecoveryContext(seed.prompt);
        await this.persistProviderSession(conversation, id, conversation.adapterId, {
          transitionId: `recovery-${randomUUID()}`,
          metadata: JSON.stringify({
            recoveryCheckpointId: checkpoint.checkpointId,
            previousInternalSessionId: active.internalSessionId,
            recoveredThroughSequence: seed.recoveredThroughSequence,
          }),
        });
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
    }
  }

  async get(id: AgentConversationId): Promise<AgentConversationSummary | null> {
    return await this.agent.persistence.conversations.get(id);
  }

  async list(options?: ConversationListOptions): Promise<ConversationPage> {
    return await this.agent.persistence.conversations.list(options);
  }

  async delete(id: AgentConversationId, deletedAt?: string): Promise<void> {
    const live = this.live.get(id);
    if (live) await live.stop();
    this.live.delete(id);
    await this.agent.persistence.conversations.delete(id, deletedAt);
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
      readonly deferProviderSessionPersistence?: boolean;
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
      this.live.set(id, conversation);
      conversation.subscribe((notification) => {
        if (notification.event.kind === "state_changed" && notification.event.state.phase === "stopped") {
          if (this.live.get(id) === conversation) this.live.delete(id);
        }
      });
      if (conversation.internalSessionId && !config.deferProviderSessionPersistence) {
        await this.persistProviderSession(conversation, id, adapterId);
      }
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

  private async persistProviderSession(
    conversation: AgentConversation,
    id: AgentConversationId,
    adapterId: string,
    extra: { readonly transitionId?: string; readonly metadata?: string } = {},
  ): Promise<void> {
    if (!conversation.internalSessionId) throw new Error("provider session has no internal session id");
    await this.agent.persistence.providerSessions.append({
      providerSessionRecordId: `provider-${randomUUID()}`,
      agentConversationId: id,
      internalSessionId: conversation.internalSessionId,
      adapterId,
      mode: conversation.mode,
      ...(conversation.model ? { model: conversation.model } : {}),
      activatedAt: new Date().toISOString(),
      ...extra,
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
      content: capturedMessageContent(input.text, this.settings.capture),
      status: "completed",
      metadata: JSON.stringify({ operationId: input.operationId }),
    }]);
    await this.updateIdentity(records);
    return Object.freeze({
      providerText: composeIdentityPrompt(input.text, identity),
      participant,
    });
  }

  async afterPrompt(input: OwnedPromptCompleted): Promise<void> {
    const timestamp = new Date().toISOString();
    const status = input.result.status === "error" ? "failed" : input.result.status;
    const records = input.result.messages.map((message, index): NewConversationRecord => ({
      recordId: `${input.operationId}:assistant:${index + 1}`,
      agentSessionId: this.agent.id,
      agentConversationId: this.conversationId,
      kind: "message",
      timestamp,
      role: "assistant",
      content: capturedMessageContent(message.text, this.settings.capture),
      status,
      metadata: JSON.stringify({
        operationId: input.operationId,
        ...(message.messageId ? { providerMessageId: message.messageId } : {}),
      }),
    }));
    await this.updateIdentity(await this.appendMessages(records));
    if (status === "completed") {
      await this.agent.checkpointing?.afterSuccessfulResponse(this.conversationId);
    }
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
      content: capturedMessageContent(message.text, this.settings.capture),
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
    await this.agent.persistence.providerSessions.append({
      providerSessionRecordId: `provider-${randomUUID()}`,
      agentConversationId: input.agentConversationId,
      internalSessionId: input.internalSessionId,
      adapterId: input.adapterId,
      mode: input.mode,
      ...(input.model ? { model: input.model } : {}),
      activatedAt: input.activatedAt,
      transitionId: input.transitionId,
    });
  }

  async record(record: NewConversationRecord): Promise<void> {
    const level = this.settings.capture[record.kind];
    if (level === "none") return;
    const persisted = await this.agent.persistence.records.append(
      captureRuntimeRecord(record, level),
    );
    await this.updateIdentity([persisted]);
  }

  async meteringRecorded(record: OperationMeteringRecord): Promise<void> {
    await this.agent.persistence.metering.commit({
      agentConversationId: this.conversationId,
      record,
      meteringRecords: this.settings.meteringRecords,
    });
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
    if (this.settings.capture.message === "none" || records.length === 0) return Object.freeze([]);
    return await this.agent.persistence.records.appendMany(records);
  }

  private async updateIdentity(records: readonly ConversationRecord[]): Promise<void> {
    await this.agent.identity.update({
      agentSessionId: this.agent.id,
      agentConversationId: this.conversationId,
      records,
    });
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

function capturedMessageContent(
  content: string,
  capture: ConversationRecordCapturePolicy,
): string {
  return capture.message === "metadata" ? "" : content;
}

function captureRuntimeRecord(
  record: NewConversationRecord,
  level: ConversationRecordCapturePolicy[keyof ConversationRecordCapturePolicy],
): NewConversationRecord {
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
  }
}

export { AgentAdapterRegistry, NoopAgentIdentityRuntime, composeIdentityPrompt };
export type { AgentAdapterRegistration, AgentIdentityRuntime, IdentityConsistency };
