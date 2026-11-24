import type * as schema from "@agentclientprotocol/sdk";
import type { Adapter } from "./adapters.ts";
import type { AgentConversationId, AgentSessionId } from "./agent-ids.ts";
import type { NativeControllerBinding } from "./conversation-controller/index.ts";
import type { AgentControllerConfig, AgentMode } from "./controller.ts";
import type { Logger } from "./logger.ts";
import type { MeteringConfig } from "./metering/record.ts";
import type { OperationLifecycleConfig } from "./operations/contracts.ts";
import type { ConversationPermissionConfig } from "./permissions/policy.ts";
import type { AgentSessionCheckpoint } from "./persistence/checkpoint.ts";
import type { AgentSessionPersistenceOptions } from "./persistence/config.ts";
import type { ParticipantRef } from "./persistence/backend.ts";
import type { SessionManager } from "./session-manager.ts";
import type { PromptDelivery } from "./steering/index.ts";
import type { WireEntry } from "./types.ts";
import type { AgentConversationOwnerLifecycle } from "./agent-conversation-owner.ts";
import type { OpenContinuationOptions, ProviderSession, TranscriptActivityConfig } from "./agent-conversation-contracts.ts";

export interface AgentSessionConfig extends ConversationPermissionConfig {
  /** Cancels the factory's startup before it returns the conversation. */
  signal?: AbortSignal;
  /** @internal Agent-owned ACP startup policy. */
  deferProviderStart?: boolean;
  /** The resolved adapter this conversation talks to. */
  adapter: Adapter;
  /** Stable adapter id for the catalog/display (e.g. "codex"). */
  adapterId: string;
  /** Talk over ACP ("normal") or scrape a pty ("degraded"). Default "normal". */
  mode?: AgentMode;
  /** Runtime-specific launcher shared by normal ACP and degraded PTY modes. */
  launcher?: AgentControllerConfig["launcher"];
  /**
   * Binds this conversation to a channel of a shared native harness instead of an external harness
   * process. Opt-in: absent for every ACP conversation. `adapter` is then display only.
   */
  native?: NativeControllerBinding;
  /** Override the owning Agent’s idle stop window for this conversation. */
  idleStopWindowMs?: number;
  /** @internal Resolves native routes in the owning Agent. */
  isNativeAdapter?: (adapterId: string) => boolean;
  /** @deprecated Use launcher. */
  execPrefix?: string[];
  /** @deprecated Use launcher and its exact spawnEnv. */
  env?: Record<string, string>;
  cwd?: string;
  /** Additional absolute directories declared to the provider. */
  additionalDirectories?: string[];
  /** Default MCP servers bound at session creation/switch, unless a call overrides them. */
  mcpServers?: schema.McpServer[];
  /**
   * How a prompt sent while a turn is running waits when the prompt does not say. `queue` runs it after
   * the turn ends; `steer` delivers it at the next tool boundary. Default `steer`.
   */
  busyDelivery?: PromptDelivery;
  clientInfo?: { name: string; title?: string; version?: string };
  /** What we let the agent do through us (terminals, filesystem). All on by default. */
  clientCapabilities?: AgentControllerConfig["clientCapabilities"];
  /** Client-side ACP implementations; their presence determines advertisement. */
  clientHandlers?: AgentControllerConfig["clientHandlers"];
  logger?: Logger;
  /** Raw protocol traffic for debugging — see `AcpClientConfig.wire`. */
  wire?: (entry: WireEntry) => void;
  /** Optional catalog. When present, the session records itself here. */
  sessions?: SessionManager;
  /** New v2 persistence. Direct sessions remain persistence-free when omitted. */
  persistence?: false | AgentSessionPersistenceOptions;
  /** Stable creation transaction/incarnation ID; required by direct v2 persistence. */
  creationId?: string;
  /**
   * Absolute path to an append-only transcript file. This selects history storage only;
   * file existence never selects the provider thread. Omitted means no transcript.
   */
  transcriptPath?: string;
  /**
   * Directory for `<encoded-agentSessionId>.jsonl`. This selects history storage only;
   * the directory is not a session catalog and is not scanned during creation.
   */
  transcriptDir?: string;
  /**
   * Also record activity (thinking, tool calls and their output, plans) as `t:"activity"`
   * lines. Off by default — it makes transcripts larger, and `readTranscript()` ignores
   * them either way; read them with `readTranscriptLines()`.
   *
   * Lines are SETTLED records, not raw deltas: the session folds the delta stream and
   * writes checkpoints (announced → input → settled), typically 2–3 lines per tool call
   * instead of one per notification. Fold them back with `foldRecords()`, last-wins on
   * `recordId`. `true` selects the defaults below.
   */
  transcriptActivity?: boolean | TranscriptActivityConfig;
  /** Stable logical identity. Minted if omitted; always available on the created object. */
  agentSessionId?: string;
  /** Provider-thread startup intent. Default `{ kind: "new" }`. */
  providerSession?: ProviderSession;
  /** Stale limits per operation kind (turns, internal inference, recap). */
  operationLifecycle?: OperationLifecycleConfig;
  /**
   * Token/cost metering policy. Optional: omitting it selects best-effort enforcement
   * with the pinned models.dev catalog and no restored state. Metering is not something a
   * consumer must turn on merely to see protocol facts.
   */
  metering?: MeteringConfig;
  /**
   * @deprecated Use `providerSession: { kind: "load", internalSessionId, onFailure }`.
   * Retains the historical fallback-to-new behavior for compatibility.
   */
  internalSessionId?: string;
  title?: string;
  /** Stable conversation identity when this runtime is owned by an Agent. */
  agentConversationId?: AgentConversationId;
  /** Stable owning agent identity. Omitted for detached compatibility conversations. */
  ownerAgentSessionId?: AgentSessionId;
  /** Other sides of this conversation. The owning agent is implied. */
  participants?: readonly ParticipantRef[];
  /** @internal Installed by AgentConversationManager. */
  ownerLifecycle?: AgentConversationOwnerLifecycle;
}

/** Direct restoration input. Phase 5A intentionally supports the safe recorded-thread path. */
export interface AgentSessionOpenConfig extends Omit<
  AgentSessionConfig,
  | "agentSessionId"
  | "creationId"
  | "providerSession"
  | "internalSessionId"
  | "mode"
  | "persistence"
  | "sessions"
> {
  /** Required for directory/default path resolution; exact-file inference is a later slice. */
  agentSessionId: string;
  persistence: AgentSessionPersistenceOptions;
  /** Optional consumer copy must exactly match transcript authority in this first slice. */
  checkpoint?: AgentSessionCheckpoint;
  continuation?: OpenContinuationOptions;
}
