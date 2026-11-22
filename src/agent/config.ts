import type { OrchestratorConfig } from "../orchestrator/config.ts";
import type { ConversationPermissionConfig, PermissionPolicyConfig } from "../permissions/policy.ts";
import type { OperationLifecycleConfig } from "../operations/contracts.ts";
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
import type { ConversationPersistenceResolver } from "./persistence-policy/index.ts";
import type { AdoptProviderSessionConfig, ListProviderSessionsOptions, ProviderSessionSummary } from "./adoption/index.ts";
import type { MediaConfig } from "../media/store.ts";

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
  | "isNativeAdapter"
  | "providerSession"
  | "persistence"
  | "transcriptPath"
  | "transcriptDir"
  | "sessions";

export type AgentConversationRuntimeDefaults = Omit<
  AgentConversationConfig,
  OwnerControlledConversationKey
>;

export interface AgentConfig extends PermissionPolicyConfig {
  readonly orchestrator?: OrchestratorConfig;
  readonly media?: MediaConfig;
  readonly operationLifecycle?: OperationLifecycleConfig;
  readonly id?: AgentSessionId;
  readonly persistence: AgentPersistenceConfig;
  readonly adapters: Readonly<Record<string, import("../adapters.ts").AgentAdapter>>
    | readonly AgentAdapterRegistration[];
  readonly defaultAdapterId?: string;
  /**
   * The Agent's own harness: one durable session, with every conversation on a native adapter
   * (`{ kind: "native" }`) as one of its channels. Required when a native adapter is registered. The
   * process starts on first use, not when the Agent or a conversation opens.
   */
  readonly harness?: AgentHarnessConfig;
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
  /**
   * Chooses, per conversation, what it persists differently from the Agent defaults. Synchronous,
   * side-effect free and stable for a given conversation; see `ConversationPersistenceResolver`.
   */
  readonly conversationPersistence?: ConversationPersistenceResolver;
}

export interface AgentHarnessConfig {
  /** The harness configuration, sent on every open. */
  readonly config: import("../native-harness/src/client.ts").ProtocolConfig;
  /** The harness home, a path in the harness's environment. It must survive process restarts. */
  readonly home: string;
  /** How to start the harness server. Defaults to this package's harness in `serve --stdio` mode. */
  readonly command?: readonly string[];
  /** Defaults to `conversationDefaults.launcher`. */
  readonly launcher?: import("../launcher.ts").AcpLauncher;
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  /** Unresolved submissions, and pending channel changes when the backend has no channel repository. */
  readonly records?: import("../native/records.ts").NativeHostRecords;
  /** `final`: complete assistant messages only (default). `stream`: text deltas too. */
  readonly text?: "final" | "stream";
  /** Functions the model can call in native conversations, served by this process. */
  readonly functions?: import("../native/functions.ts").NativeFunctionsConfig;
  readonly approvalResponder?: import("../native/host.ts").NativeApprovalResponder;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly restart?: { readonly limit: number; readonly windowMs: number };
  readonly onChannelChangeBlocked?: (result: import("../native-harness/src/client.ts").ChannelChangeResult) => void;
}

export interface CreateAgentConversationConfig extends ConversationPermissionConfig {
  readonly id?: AgentConversationId;
  readonly adapterId?: string;
  readonly mode?: AgentMode;
  readonly participants?: readonly ParticipantRef[];
  readonly title?: string;
  readonly metadata?: string;
  readonly mcpServers?: schema.McpServer[];
  readonly runtime?: AgentConversationRuntimeDefaults;
  /**
   * Create the conversation around an existing provider session and load it, instead of starting a new
   * one. Requires message capture `content` or `raw` for this conversation.
   */
  readonly adopt?: AdoptProviderSessionConfig;
}

export interface OpenAgentConversationConfig extends ConversationPermissionConfig {
  readonly adapterId?: string;
  readonly mode?: AgentMode;
  readonly mcpServers?: schema.McpServer[];
  readonly runtime?: AgentConversationRuntimeDefaults;
  readonly onRecoveryProgress?: (event: ConversationRecoveryProgress) => void;
}

export interface DeleteConversationOptions {
  /** When it was deleted. Default now. */
  readonly deletedAt?: string;
  /**
   * `"best-effort"` also asks the provider to delete the conversation's active session (`session/delete`);
   * `"no"` (the default) leaves it alone. Not every provider offers it; the result says what happened.
   */
  readonly providerSession?: "best-effort" | "no";
  /** Also delete the conversation's recovery checkpoints. */
  readonly checkpoints?: boolean;
}

export interface DeleteConversationResult {
  /** `true` if the provider deleted its session, `"unsupported"` if it cannot, `false` if not asked or it failed. */
  readonly providerDeleted: boolean | "unsupported";
  readonly checkpointsDeleted: number;
}

export interface ClearTranscriptOptions {
  /** Also delete the conversation's recovery checkpoints, which summarize the records being deleted. */
  readonly checkpoints?: boolean;
}

export interface ClearTranscriptResult {
  readonly recordsDeleted: number;
  readonly checkpointsDeleted: number;
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
  /**
   * The sessions the provider holds (`session/list`), for choosing one to adopt with `create({ adopt })`.
   * Starts the harness for the call. Each session says which conversation already owns it, if any.
   */
  listProviderSessions(options?: ListProviderSessionsOptions): Promise<readonly ProviderSessionSummary[]>;
  listPreviews(options?: ConversationListOptions): Promise<ConversationPreviewPage>;
  /**
   * Delete a conversation (a soft delete: the records stay, and the conversation stops being listed and frees
   * its provider session). A string is the deletion time, as before. Returns what else was done.
   */
  delete(id: AgentConversationId, options?: string | DeleteConversationOptions): Promise<DeleteConversationResult>;
  /**
   * Physically delete the stored records of a conversation (messages, tool calls, and the rest), keeping the
   * conversation, its participants and provider session. This is a local deletion, not forgetting: audit
   * entries already written, checkpoint summaries delivered to other conversations, and the provider's own
   * session are not touched.
   */
  clearTranscript(id: AgentConversationId, options?: ClearTranscriptOptions): Promise<ClearTranscriptResult>;
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
