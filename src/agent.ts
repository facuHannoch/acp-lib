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
}

export interface OpenOwnedAgentConversationResult {
  readonly conversation: AgentConversation;
  readonly providerSession: "already_open" | "loaded" | "new";
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
    this.manager = new DefaultAgentConversationManager(this, {
      defaultAdapterId: config.defaultAdapterId,
      identityConsistency: config.identityConsistency ?? "eventual",
      identityTimeoutMs: config.identityTimeoutMs,
      capture: resolveConversationRecordCapture(config.capture),
      defaults: config.conversationDefaults ?? {},
    });
    this.conversations = this.manager;
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
}

class DefaultAgentConversationManager implements AgentConversationManager {
  private readonly live = new Map<AgentConversationId, AgentConversation>();

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
    const summary = await this.agent.persistence.conversations.get(id);
    if (!summary || summary.deletedAt) throw new Error(`unknown active conversation: ${id}`);
    const active = await this.agent.persistence.providerSessions.active(id);
    if (active && config.adapterId && config.adapterId !== active.adapterId) {
      throw new Error(
        `conversation ${id} is active on ${active.adapterId}; use a conversation switch instead of loading it with ${config.adapterId}`,
      );
    }
    const conversation = await this.start(id, summary.participants, {
      ...config,
      runtime: {
        ...(summary.title ? { title: summary.title } : {}),
        ...config.runtime,
      },
      adapterId: config.adapterId ?? active?.adapterId,
      providerSession: active ? "load" : "new",
      internalSessionId: active?.internalSessionId,
    });
    return Object.freeze({
      conversation,
      providerSession: active ? "loaded" : "new",
    });
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
    const conversations = [...this.live.values()];
    this.live.clear();
    await Promise.allSettled(conversations.map((conversation) => conversation.stop()));
  }

  private async start(
    id: AgentConversationId,
    participants: readonly ParticipantRef[],
    config: (CreateAgentConversationConfig | OpenAgentConversationConfig) & {
      readonly providerSession: "new" | "load";
      readonly internalSessionId?: string;
    },
  ): Promise<AgentConversation> {
    const adapterId = this.resolveAdapterId(config.adapterId);
    const adapter = this.agent.adapters.require(adapterId);
    const runtime = { ...this.settings.defaults, ...config.runtime };
    const lifecycle = new PersistedConversationLifecycle(
      this.agent,
      id,
      participants,
      this.settings,
    );
    let conversation: AgentConversation | undefined;
    try {
      conversation = await AgentConversation.create({
        ...runtime,
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
      if (conversation.internalSessionId) {
        await this.agent.persistence.providerSessions.append({
          providerSessionRecordId: `provider-${randomUUID()}`,
          agentConversationId: id,
          internalSessionId: conversation.internalSessionId,
          adapterId,
          mode: conversation.mode,
          ...(conversation.model ? { model: conversation.model } : {}),
          activatedAt: new Date().toISOString(),
        });
      }
      return conversation;
    } catch (error) {
      this.live.delete(id);
      await conversation?.stop().catch(() => undefined);
      throw error;
    }
  }

  private resolveAdapterId(requested?: string): string {
    if (requested) return requested;
    if (this.settings.defaultAdapterId) return this.settings.defaultAdapterId;
    const registrations = this.agent.adapters.list();
    if (registrations.length === 1) return registrations[0]!.id;
    throw new Error("adapterId is required when an Agent has no unique default adapter");
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
      ...(message.messageId ? { metadata: JSON.stringify({ providerMessageId: message.messageId }) } : {}),
    }));
    await this.updateIdentity(await this.appendMessages(records));
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
      ...(message.messageId ? { metadata: JSON.stringify({ providerMessageId: message.messageId }) } : {}),
    }));
    await this.updateIdentity(await this.appendMessages(records));
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

function capturedMessageContent(
  content: string,
  capture: ConversationRecordCapturePolicy,
): string {
  return capture.message === "metadata" ? "" : content;
}

export { AgentAdapterRegistry, NoopAgentIdentityRuntime, composeIdentityPrompt };
export type { AgentAdapterRegistration, AgentIdentityRuntime, IdentityConsistency };
