import type * as schema from "@agentclientprotocol/sdk";
import type { AgentConversationId, AgentSessionId } from "../agent-ids.ts";
import type { AgentAdapterRegistration } from "../agent-adapter-registry.ts";
import type { AgentConversation, AgentConversationConfig } from "../agent-session.ts";
import type { AgentMode } from "../controller.ts";
import type { AgentIdentityRuntime, IdentityConsistency } from "../identity.ts";
import type { CheckpointBackedIdentityConfig } from "../identity/checkpoint-backed.ts";
import type {
  AgentConversationSummary,
  ConversationListOptions,
  ConversationPage,
  ConversationPreviewPage,
  ConversationRecordCaptureConfig,
  MessageRecord,
  MeteringRecordRetention,
  ParticipantRef,
  PersistenceBackend,
  PersistenceExtension,
} from "../persistence/backend.ts";
import type { AgentAuditLogConfig } from "../audit/index.ts";
import type { InternalInferenceConfig } from "../internal-inference/config.ts";
import type { InternalInferenceStrategy } from "../internal-inference/contracts.ts";
import type {
  ConversationCheckpointingConfig,
  ConversationRecoveryProgress,
  ConversationRecoveryResult,
} from "../checkpointing/index.ts";
import type { AppendAssistantMessageInput } from "../out-of-band-messages.ts";

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
  readonly adapters: Readonly<Record<string, import("../adapters.ts").Adapter>>
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
