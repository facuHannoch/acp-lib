// AgentSession — the durable conversation and the library's FRONT FACE. This is what a
// consumer (the orchestration hub, the CLI) holds: a conversation with a stable identity
// that persists across reconnects/mode-swaps, backed by a SessionManager catalog.
//
// It owns identity (our `agentSessionId`, adapter, mode, internalSessionId, title) and persistence, and
// HOLDS an AgentController for the live connection (the control plane). It implements
// AgentClient, so the REPL and any caller can prompt it directly.
//
// Adapter lives HERE, not on the controller: switching adapter = a new AgentSession (the
// agent dies on switch). Mode-swap (degrade/upgrade) stays within one AgentSession.

import { AgentController, type AgentControllerConfig, type AgentMode } from "./controller.ts";
import type * as schema from "@agentclientprotocol/sdk";
import { join } from "node:path";
import { ActivityAggregator, type ActivitySnapshot, type AggregatedRecord } from "./activity.ts";
import type { Adapter } from "./adapters.ts";
import type { AgentClient, Bridgeable, BridgeOptions, InterruptOptions } from "./agent-client.ts";
import type { Capabilities } from "./capabilities.ts";
import type { ConfigOption, ConfigOptions } from "./config-options.ts";
import type { ConnectResult } from "./client.ts";
import { noopLogger, type Logger } from "./logger.ts";
import { ResponseAccumulator } from "./response.ts";
import { MeteringEngine, type OpenOperation } from "./metering/engine.ts";
import {
  AgentSessionHandoffError,
  AgentSessionOperationError,
  type AgentSessionMeteringSnapshot,
  type MeteredOperationKind,
  type MeteringConfig,
  type MeteringReconciliation,
  type OperationMeteringRecord,
} from "./metering/record.ts";
import { createModelsDevResolver } from "./metering/catalog/index.ts";
import { activeModel, resolveModelReference } from "./metering/provider.ts";
import { restoreMeteringState, type AgentSessionMeteringState } from "./metering/state.ts";
import {
  contextWindowChanged,
  parseContextWindow,
  parseProviderCost,
  providerCostChanged,
  type ContextWindowStatus,
  type ProviderCostSnapshot,
} from "./metering/context.ts";
import type { SessionManager, MergedSession } from "./session-manager.ts";
import {
  appendTranscriptLine,
  type TranscriptActivityLine,
  type TranscriptLine,
} from "./transcript.ts";
import type {
  ActivityEvent,
  InternalSessionCommand,
  Attachment,
  PromptHandlers,
  PromptResult,
  SessionListEntry,
  TokenUsage,
  WireEntry,
} from "./types.ts";
import {
  resolveDirectPersistence,
  type AgentSessionPersistenceOptions,
  type ResolvedAgentSessionPersistence,
} from "./persistence/config.ts";
import { resolveSessionLogPaths } from "./persistence/paths.ts";
import {
  createAgentSessionCheckpoint,
  validateAgentSessionCheckpoint,
  type AgentSessionCheckpoint,
  type JsonValue,
  type PersistedSessionConfigSelection,
  type SessionConfigurationCheckpoint,
} from "./persistence/checkpoint.ts";
import { EMPTY_HISTORY_DIGEST } from "./persistence/reducer.ts";
import type {
  InternalSessionHistoryEntry,
  InternalSessionDescriptor,
  TranscriptHeaderRecord,
  OperationKind,
} from "./persistence/records.ts";
import { TranscriptPersistenceRuntime } from "./persistence/transcript-runtime.ts";
import { RegistryPersistenceRuntime, type PersistenceStateRuntime } from "./persistence/state-runtime.ts";
import { TranscriptReader } from "./persistence/transcript-reader.ts";
import {
  snapshotSessionConfiguration,
  snapshotSessionConfigurationAfterSelection,
  snapshotAcceptedEffectiveConfiguration,
} from "./persistence/configuration-state.ts";
import { persistenceEventFromActivity } from "./persistence/activity-projection.ts";
import {
  canonicalizeJson,
  sha256CanonicalJson,
  type PersistedMachineCode,
} from "./persistence/integrity.ts";
import type { PersistenceRepair, SessionRecoveryStatus } from "./persistence/reducer.ts";
import type { StagedContinuationState } from "./persistence/registry.ts";
import type { SessionLogWriterLock } from "./persistence/session-log-writer.ts";

interface PromptQueueItem {
  kind: "prompt";
  turnId: string;
  /** How this operation is classified in its metering record. */
  operationKind: MeteredOperationKind;
  text: string;
  handlers?: PromptHandlers;
  attachments?: Attachment[];
  resolve: (r: AgentSessionPromptResult) => void;
  reject: (e: unknown) => void;
}

interface HandoffQueueItem {
  kind: "handoff";
  handoffId: string;
  options: HandoffOptions;
  resolve: (result: HandoffResult) => void;
  reject: (error: unknown) => void;
}

interface ConfigQueueItem {
  kind: "set_config";
  operationId: string;
  configId: string;
  value: unknown;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface ModeQueueItem {
  kind: "set_mode";
  transitionId: string;
  mode: AgentMode;
  resolve: (result: ConnectResult) => void;
  reject: (error: unknown) => void;
}

interface ConfigResolutionQueueItem {
  kind: "resolve_config";
  resolution: ConfigurationMismatchResolution;
  resolve: (result: ConfigurationMismatchResolutionResult) => void;
  reject: (error: unknown) => void;
}

interface RecoveryResolutionQueueItem {
  kind: "resolve_recovery";
  resolution: AgentSessionRecoveryResolution;
  resolve: (result: AgentSessionRecoveryResolutionResult) => void;
  reject: (error: unknown) => void;
}

type QueueItem = PromptQueueItem | HandoffQueueItem | ConfigQueueItem | ModeQueueItem | ConfigResolutionQueueItem | RecoveryResolutionQueueItem;

/** What the stable logical session is doing right now. */
export type AgentSessionPhase =
  | "idle"
  | "prompting"
  | "handoff"
  | "configuring"
  | "recovering"
  | "switching_mode"
  | "stopped";

/** Authoritative, immutable point-in-time state for orchestration consumers. */
export interface AgentSessionState {
  readonly phase: AgentSessionPhase;
  /** True only while an operation is executing; queued work is reported separately. */
  readonly isBusy: boolean;
  /** Operations waiting behind the active one. Does not count the active operation. */
  readonly queuedOperationCount: number;
  readonly agentSessionId: string;
  readonly internalSessionId: string | null;
  readonly adapterId: string;
  readonly mode: AgentMode;
  readonly promptability: AgentSessionPromptability;
}

export type ConfigurationRestoreStatus =
  | { readonly kind: "matched" }
  | { readonly kind: "partial"; readonly omittedConfigIds: readonly string[] }
  | {
      readonly kind: "mismatch";
      readonly configIds: readonly string[];
      readonly reasons: readonly string[];
    };

export type PromptBlocker =
  | "continuation_unavailable"
  | "recovery_required"
  | "configuration_mismatch"
  | "persistence_unhealthy"
  | "maintenance_pending"
  | "session_stopped";

export type AgentSessionPromptability =
  | { readonly promptable: true; readonly blockers: readonly [] }
  | { readonly promptable: false; readonly blockers: readonly PromptBlocker[] };

export interface ContinuationAttempt {
  readonly strategy: ContinuationStrategy["kind"];
  readonly status: "succeeded" | "failed" | "skipped";
  readonly errorCode?: PersistedMachineCode;
  readonly reason?: string;
}

export interface ContinuationReport {
  readonly recordedAdapterId: string;
  readonly recordedInternalSessionId: string | null;
  readonly requestedAdapterId: string;
  readonly recordedConversationAvailability: "available" | "partial" | "not_captured";
  readonly recordedThreadAvailability: "available" | "unavailable" | "not_checked";
  readonly attempts: readonly ContinuationAttempt[];
  readonly outcome:
    | { readonly kind: "loaded"; readonly activeInternalSessionId: string }
    | {
        readonly kind: "reconstructed";
        readonly source: "transcript" | "consumer";
        readonly activeInternalSessionId: string;
        readonly transitionId: string;
      }
    | { readonly kind: "unavailable" };
}

export interface TranscriptContinuationBuilderContext {
  readonly agentSessionId: string;
  readonly checkpoint: AgentSessionCheckpoint;
  /** Snapshot-bound access to captured history; the builder decides how much to read. */
  readonly transcript: TranscriptReader;
  readonly targetAdapterId: string;
}

export type TranscriptContinuationBuilder = (
  context: TranscriptContinuationBuilderContext,
) => Promise<{ readonly continuation: string; readonly metadata?: Readonly<Record<string, JsonValue>> }>;

export type ContinuationStrategy =
  | { readonly kind: "load_internal_session" }
  | {
      readonly kind: "new_from_transcript";
      readonly strategyId: string;
      readonly buildContinuation: TranscriptContinuationBuilder;
    }
  | {
      readonly kind: "new_from_consumer_continuation";
      readonly continuationId: string;
      readonly continuation: string;
    };

export interface OpenContinuationOptions {
  /** Defaults to only `load_internal_session`; an empty array is invalid. */
  readonly strategies?: readonly ContinuationStrategy[];
}

export interface AgentSessionOpenResult {
  readonly session: AgentSession;
  readonly continuation: ContinuationReport;
  readonly recovery: SessionRecoveryStatus;
  readonly configuration: ConfigurationRestoreStatus;
  readonly promptability: AgentSessionPromptability;
  readonly repairs: readonly PersistenceRepair[];
}

export type ConfigurationMismatchResolution =
  | { readonly strategy: "accept_effective" }
  | {
      readonly strategy: "replace_restoration_targets";
      readonly selections: readonly { readonly configId: string; readonly value: JsonValue }[];
    };

export interface ConfigurationMismatchResolutionResult {
  readonly configuration: ConfigurationRestoreStatus;
  readonly appliedConfigIds: readonly string[];
}

export type AgentSessionRecoveryResolution =
  | { readonly strategy: "accept_harness_state" }
  | {
      readonly strategy: "start_new_internal_session";
      /** When omitted, the currently loaded harness thread generates portable context. */
      readonly continuation?: string;
    };

export interface AgentSessionRecoveryResolutionResult {
  readonly previous: Extract<SessionRecoveryStatus, { readonly kind: "uncertain" }>;
  readonly recovery: Extract<SessionRecoveryStatus, { readonly kind: "clean" }>;
  /** Present when resolution deliberately replaced the provider thread. */
  readonly handoff?: HandoffResult;
}

export class AgentSessionPromptBlockedError extends Error {
  constructor(readonly blockers: readonly PromptBlocker[]) {
    super(`AgentSession cannot mutate while blocked: ${blockers.join(", ")}`);
    this.name = "AgentSessionPromptBlockedError";
  }
}

export class ContinuationUnavailableError extends Error {
  constructor(readonly continuation: ContinuationReport, options?: ErrorOptions) {
    super("recorded internal session could not be loaded", options);
    this.name = "ContinuationUnavailableError";
  }
}

export class AdapterMismatchError extends Error {
  constructor(readonly recordedAdapterId: string, readonly requestedAdapterId: string) {
    super(`adapter mismatch: transcript requires ${recordedAdapterId}, received ${requestedAdapterId}`);
    this.name = "AdapterMismatchError";
  }
}

export interface HandoffOptions {
  /** Portable continuation context. When omitted, the current thread generates it. */
  readonly summary?: string;
}

export interface HandoffResult {
  readonly handoffId: string;
  readonly agentSessionId: string;
  readonly fromInternalSessionId: string | null;
  readonly toInternalSessionId: string;
  readonly summary: string;
  /** One record per token-consuming operation the handoff performed, in order. */
  readonly meteringRecords: readonly OperationMeteringRecord[];
}

/** Session-owned lifecycle events. Harness activity remains in PromptHandlers.onActivity. */
export type AgentSessionEvent =
  | { kind: "state_changed"; state: AgentSessionState }
  | { kind: "turn_started"; turnId: string }
  | { kind: "turn_completed"; turnId: string; result: PromptResult }
  | { kind: "turn_failed"; turnId: string; error: string }
  /** The active ACP harness changed the slash commands it advertises. */
  | { kind: "internal_session_commands_changed"; commands: readonly InternalSessionCommand[] }
  | {
      kind: "handoff_started";
      handoffId: string;
      fromInternalSessionId: string | null;
    }
  | { kind: "handoff_completed"; result: HandoffResult }
  | {
      kind: "handoff_failed";
      handoffId: string;
      fromInternalSessionId: string | null;
      toInternalSessionId?: string;
      error: string;
      /** Records produced before and during the failure. */
      meteringRecords: readonly OperationMeteringRecord[];
    }
  | { kind: "configuration_started"; operationId: string; configId: string }
  | { kind: "configuration_completed"; operationId: string; configId: string }
  | { kind: "configuration_failed"; operationId: string; configId: string; error: string }
  | { kind: "mode_change_started"; transitionId: string; from: AgentMode; to: AgentMode }
  | { kind: "mode_change_completed"; transitionId: string; from: AgentMode; to: AgentMode }
  | { kind: "mode_change_failed"; transitionId: string; from: AgentMode; to: AgentMode; error: string }
  | {
      kind: "configuration_mismatch_resolved";
      configuration: ConfigurationRestoreStatus;
      appliedConfigIds: readonly string[];
    }
  | {
      kind: "recovery_resolved";
      strategy: AgentSessionRecoveryResolution["strategy"];
      previous: Extract<SessionRecoveryStatus, { kind: "uncertain" }>;
      recovery: Extract<SessionRecoveryStatus, { kind: "clean" }>;
    }
  /** Latest context-window observation for the ACTIVE provider thread, or null. */
  | { kind: "context_window_changed"; contextWindow: ContextWindowStatus | null }
  /** Latest cumulative provider-reported cost. Telemetry, never asserted to be an invoice. */
  | { kind: "provider_cost_changed"; providerCost: ProviderCostSnapshot | null }
  /** One immutable record per observed operation, emitted before its turn completes. */
  | { kind: "metering_recorded"; record: OperationMeteringRecord }
  /** A strict mode detected a metering failure; later token-consuming work will reject. */
  | { kind: "metering_blocked"; reason: string }
  | { kind: "metering_unblocked" }
  | {
      kind: "metering_reconciled";
      before: AgentSessionMeteringState;
      after: AgentSessionMeteringState;
      reason: string;
      reference?: string;
      reconciledAt: number;
    };

/** A prompt result enriched with the operation's metering record. */
export interface AgentSessionPromptResult extends PromptResult {
  readonly operationId: string;
  /**
   * The operation's record, or null when the operation never reached the provider.
   *
   * Null happens only for a queued prompt cancelled before dispatch (§16). Such an
   * operation consumed nothing, and minting a record for it would put a fabricated
   * entry in the consumer's ledger — so the field is honestly empty instead.
   */
  readonly metering: OperationMeteringRecord | null;
}

/** Ordered envelope delivered to every AgentSession subscriber. */
export interface AgentSessionNotification {
  readonly seq: number;
  readonly ts: number;
  readonly agentSessionId: string;
  readonly event: AgentSessionEvent;
}

export type AgentSessionListener = (notification: AgentSessionNotification) => void;

/** What to record when `transcriptActivity` is on. */
export interface TranscriptActivityConfig {
  /**
   * Which record kinds to persist. Default: `tool`, `thinking`, `plan`, `plan_update`,
   * `plan_removed`, `usage`, `mode`, `unknown` — everything except client state
   * (`commands`, `config`, `session_info`) and `user_message`, which duplicates `t:"msg"`.
   */
  kinds?: Array<ActivityEvent["kind"]>;
  /**
   * Write an extra line the first time a tool call learns its arguments. Default true —
   * agents routinely announce a call long before they know what it will run, so without
   * this a turn that dies mid-call leaves a record naming the tool but not the command.
   *
   * This is an aggregator-level knob, so it also shapes `onRecord`'s `emitted` when no
   * transcript is configured.
   */
  checkpointOnInput?: boolean;
  /**
   * Persist `rawOutput`. Default false: in practice it is a byte-identical duplicate of
   * `content` (measured on live Kimi), so it doubles the largest field on the line.
   */
  rawOutput?: boolean;
  /**
   * Cap each individual string field (terminal output, text content, a stringified
   * `rawInput`) at this many bytes, appending `… [truncated N bytes]` and marking the
   * line `truncated: true`. Default off. Per-field on purpose — capping the serialized
   * line would emit unparseable JSON.
   */
  maxBytes?: number;
}

const DEFAULT_ACTIVITY_KINDS: Array<ActivityEvent["kind"]> = [
  "tool",
  "thinking",
  "plan",
  "plan_update",
  "plan_removed",
  "usage",
  "mode",
  "unknown",
];

const HANDOFF_SUMMARY_PROMPT = [
  "Create portable continuation context for a new agent thread.",
  "Summarize the objective, decisions, completed work, current state, important files or identifiers,",
  "and concrete next steps. Preserve unresolved risks and constraints. Return only the continuation context.",
].join(" ");

function continuationPrompt(summary: string): string {
  return [
    "Continue this conversation using the following portable continuation context.",
    "Treat it as prior context, not as a new user request. Confirm internally and continue from this state.",
    "",
    summary,
  ].join("\n");
}

/** Explicit selection of the provider thread backing a newly opened AgentSession. */
export type ProviderSession =
  | { readonly kind: "new" }
  | {
      readonly kind: "load";
      readonly internalSessionId: string;
      /** Default "error": never silently replace a requested thread. */
      readonly onFailure?: "error" | "new";
    };

export interface AgentSessionConfig {
  /** The resolved adapter this conversation talks to. */
  adapter: Adapter;
  /** Stable adapter id for the catalog/display (e.g. "codex"). */
  adapterId: string;
  /** Talk over ACP ("normal") or scrape a pty ("degraded"). Default "normal". */
  mode?: AgentMode;
  /** Runtime-specific launcher shared by normal ACP and degraded PTY modes. */
  launcher?: AgentControllerConfig["launcher"];
  /** @deprecated Use launcher. */
  execPrefix?: string[];
  /** @deprecated Use launcher and its exact spawnEnv. */
  env?: Record<string, string>;
  cwd?: string;
  /** Default MCP servers bound at session creation/switch, unless a call overrides them. */
  mcpServers?: schema.McpServer[];
  defaultPermission?: "approve" | "cancel";
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

interface AgentSessionOpenBootstrap {
  readonly transcript: TranscriptPersistenceRuntime;
  readonly transcriptPath: string;
}

/** @internal Transaction hooks supplied only by SessionManager managed creation. */
export interface ManagedAgentSessionCreationBootstrap {
  readonly requestDigest: string;
  readonly transcriptLock?: SessionLogWriterLock;
  readonly stageContinuation: (state: StagedContinuationState) => Promise<StagedContinuationState>;
}

export interface ManagedAgentSessionPersistenceSnapshot {
  readonly checkpoint: AgentSessionCheckpoint;
  readonly internalSessionHistory: readonly InternalSessionHistoryEntry[];
}

export class AgentSession implements AgentClient, Bridgeable {
  /** Our stable AgentSession id — decoupled from the ACP/harness session id. */
  readonly agentSessionId: string;
  readonly adapterId: string;

  private readonly controller: AgentController;
  private readonly sessions?: SessionManager;
  private readonly _transcriptPath?: string;
  private readonly persistence: false | ResolvedAgentSessionPersistence;
  private readonly creationId: string;
  private v2Transcript: PersistenceStateRuntime | null = null;
  private v2TranscriptPath: string | null = null;
  private v2ActivityWrite: Promise<void> = Promise.resolve();
  private readonly transcriptActivity: boolean;
  private readonly activityKinds: Set<string>;
  private readonly activityRawOutput: boolean;
  private readonly activityMaxBytes: number | null;
  /**
   * THE aggregator — one per session for its whole life, never one per turn: `seq` has to
   * keep counting across turns or a subscriber's discard threshold goes stale (see
   * `activitySnapshot`). Runs unconditionally, so a snapshot is truthful and `onRecord`
   * works whether or not a transcript is configured.
   */
  private readonly aggregator: ActivityAggregator;
  private readonly log: Logger;
  private transcriptWrite: Promise<void> = Promise.resolve();
  private queue: QueueItem[] = [];
  private pumping = false;
  private phase: AgentSessionPhase = "idle";
  private notificationSeq = 0;
  private readonly listeners = new Set<AgentSessionListener>();
  private lastStateKey = "";
  private _internalSessionId: string | null;
  private readonly metering: MeteringEngine;
  private _contextWindow: ContextWindowStatus | null = null;
  private _providerCost: ProviderCostSnapshot | null = null;
  /**
   * A usage update that arrived before the provider thread id was known.
   *
   * A harness may notify immediately after session/new, before that response resolves.
   * Dropping the update would lose the observation; applying it without a thread id would
   * attribute it to nothing. Hold the latest one and attribute it on assignment.
   */
  private pendingUsageUpdate: { update: unknown; sessionId: string | null } | null = null;
  private _mode: AgentMode;
  private _cwd?: string;
  private _title?: string;
  private readonly openBootstrap: AgentSessionOpenBootstrap | null;
  private continuationAcquired = true;
  private _recovery: SessionRecoveryStatus = { kind: "clean" };
  private _configurationRestore: ConfigurationRestoreStatus = { kind: "matched" };
  private readonly managedCreation: ManagedAgentSessionCreationBootstrap | null;
  private managedPersistenceHealthy = true;

  private constructor(
    config: AgentSessionConfig,
    openBootstrap: AgentSessionOpenBootstrap | null = null,
    managedCreation: ManagedAgentSessionCreationBootstrap | null = null,
  ) {
    if (config.transcriptPath && config.transcriptDir) {
      throw new Error("AgentSessionConfig cannot specify both transcriptPath and transcriptDir");
    }
    if (config.persistence !== undefined && (config.transcriptPath || config.transcriptDir)) {
      throw new Error("AgentSessionConfig cannot combine persistence with deprecated transcript options");
    }
    if (config.providerSession && config.internalSessionId !== undefined) {
      throw new Error("AgentSessionConfig cannot specify both providerSession and internalSessionId");
    }
    if (config.agentSessionId !== undefined && !config.agentSessionId.trim()) {
      throw new Error("AgentSessionConfig.agentSessionId cannot be blank");
    }
    const providerSession: ProviderSession = config.providerSession ??
      (config.internalSessionId !== undefined
        ? { kind: "load", internalSessionId: config.internalSessionId, onFailure: "new" }
        : { kind: "new" });
    if (providerSession.kind === "load" && !providerSession.internalSessionId.trim()) {
      throw new Error("providerSession.internalSessionId cannot be blank");
    }
    if ((config.mode ?? "normal") === "degraded" && providerSession.kind === "load") {
      throw new Error("providerSession.kind=load requires ACP (normal) mode");
    }
    const requestedInternalSessionId = providerSession.kind === "load"
      ? providerSession.internalSessionId
      : undefined;

    // IDs are opaque provider/consumer values. Validate blankness above, but never
    // normalize a nonblank identifier and accidentally select a different session.
    this.agentSessionId = config.agentSessionId ?? crypto.randomUUID();
    this.adapterId = config.adapterId;
    this.sessions = config.sessions;
    this.persistence = resolveDirectPersistence(config.persistence);
    if (this.persistence !== false && config.sessions) {
      throw new Error("direct persistence cannot be combined with a SessionManager; use managed creation");
    }
    if (this.persistence !== false && (!config.agentSessionId || !config.creationId)) {
      throw new Error("direct persistence requires explicit agentSessionId and creationId");
    }
    if (config.creationId !== undefined && !config.creationId.trim()) {
      throw new Error("AgentSessionConfig.creationId cannot be blank");
    }
    this.creationId = config.creationId ?? crypto.randomUUID();
    this.openBootstrap = openBootstrap;
    this.managedCreation = managedCreation;
    this._transcriptPath =
      config.transcriptPath ??
      (config.transcriptDir
        ? join(config.transcriptDir, `${encodeURIComponent(this.agentSessionId)}.jsonl`)
        : undefined);
    const activity: TranscriptActivityConfig | null =
      config.transcriptActivity === true ? {} : config.transcriptActivity || null;
    this.transcriptActivity = activity !== null;
    this.activityKinds = new Set(activity?.kinds ?? DEFAULT_ACTIVITY_KINDS);
    this.activityRawOutput = activity?.rawOutput === true;
    this.activityMaxBytes =
      activity?.maxBytes != null && activity.maxBytes > 0 ? activity.maxBytes : null;
    this.aggregator = new ActivityAggregator({ checkpointOnInput: activity?.checkpointOnInput });
    this.log = config.logger ?? noopLogger;
    this._mode = config.mode ?? "normal";
    this._cwd = config.cwd;
    this._title = config.title;
    this._internalSessionId = requestedInternalSessionId ?? null;
    this.metering = new MeteringEngine({
      agentSessionId: this.agentSessionId,
      adapterId: config.adapterId,
      enforcement: config.metering?.enforcement ?? "best_effort",
      // Absence selects the pinned catalog; `false` is how a consumer says "no rating".
      pricing: config.metering?.pricing ?? createModelsDevResolver(),
      initialState: config.metering?.initialState,
      ...(config.metering?.counterInterpretation
        ? { counterInterpretation: config.metering.counterInterpretation }
        : {}),
      ...(config.metering?.inferenceSource
        ? { inferenceSource: config.metering.inferenceSource }
        : {}),
      // A thread we are about to create has counters starting at zero; one we load does
      // not, and needs restored state to be attributable.
      createdActiveThread: providerSession.kind === "new",
    });
    this.controller = new AgentController({
      adapter: config.adapter,
      adapterId: config.adapterId,
      mode: this._mode,
      launcher: config.launcher,
      execPrefix: config.execPrefix,
      env: config.env,
      cwd: config.cwd,
      sessionId: requestedInternalSessionId,
      sessionLoadFailure: providerSession.kind === "load"
        ? providerSession.onFailure ?? "error"
        : undefined,
      mcpServers: config.mcpServers,
      defaultPermission: config.defaultPermission,
      clientInfo: config.clientInfo,
      clientCapabilities: config.clientCapabilities,
      clientHandlers: config.clientHandlers,
      logger: config.logger,
      wire: config.wire,
    });
    this.controller.subscribeAvailableCommands((commands) => {
      this.emit({ kind: "internal_session_commands_changed", commands });
    });
    this.controller.subscribeUsageUpdate((update, sessionId) => {
      this.applyUsageUpdate(update, sessionId);
    });
  }

  /**
   * Open a logical conversation. `agentSessionId` selects stable identity;
   * `providerSession` independently selects a new or existing provider thread; transcript
   * options independently select history storage. No catalog or transcript is read
   * implicitly. Consumers compose a catalog record back into this method when reopening.
   */
  static async create(config: AgentSessionConfig): Promise<AgentSession> {
    const session = new AgentSession(config);
    try {
      await session.start();
      return session;
    } catch (error) {
      await session.stop().catch(() => {});
      throw error;
    }
  }

  /** @internal Create while transferring a manager-owned transcript lock and staging hook. */
  static async createManaged(
    config: AgentSessionConfig,
    bootstrap: ManagedAgentSessionCreationBootstrap,
  ): Promise<AgentSession> {
    let session: AgentSession;
    try {
      session = new AgentSession(config, null, bootstrap);
    } catch (error) {
      await bootstrap.transcriptLock?.release().catch(() => undefined);
      throw error;
    }
    try {
      await session.start();
      return session;
    } catch (error) {
      await session.stop().catch(() => undefined);
      await bootstrap.transcriptLock?.release().catch(() => undefined);
      throw error;
    }
  }

  /** Restore one logical session by loading the exact provider thread in transcript authority. */
  static async open(config: AgentSessionOpenConfig): Promise<AgentSessionOpenResult> {
    return await AgentSession.openWithLock(config);
  }

  /** @internal Managed open after maintenance acquired the artifact lock. */
  static async openManaged(
    config: AgentSessionOpenConfig,
    transcriptLock: SessionLogWriterLock,
  ): Promise<AgentSessionOpenResult> {
    return await AgentSession.openWithLock(config, transcriptLock);
  }

  /** @internal Restore a registry-authoritative session without a transcript reader. */
  static async openManagedRegistry(
    config: AgentSessionOpenConfig,
    history: readonly InternalSessionHistoryEntry[],
  ): Promise<AgentSessionOpenResult> {
    const checkpoint = config.checkpoint;
    if (!checkpoint || checkpoint.transcript !== null) {
      throw new Error("registry-managed open requires a registry-only checkpoint");
    }
    const strategies = normalizeContinuationStrategies(config.continuation);
    if (checkpoint.adapterId !== config.adapterId && !strategies.some(isReconstructionStrategy)) {
      throw new AdapterMismatchError(checkpoint.adapterId, config.adapterId);
    }
    if (!checkpoint.internalSessionId) {
      throw new Error("registry-managed open has no recorded internal session id");
    }
    const { checkpoint: _checkpoint, continuation: _continuation, ...runtime } = config;
    const session = new AgentSession({
      ...runtime,
      agentSessionId: checkpoint.agentSessionId,
      creationId: checkpoint.incarnationId,
      mode: "normal",
      providerSession: {
        kind: "load",
        internalSessionId: checkpoint.internalSessionId,
        onFailure: "error",
      },
      metering: { ...config.metering, initialState: checkpoint.metering },
    });
    session.v2Transcript = new RegistryPersistenceRuntime(checkpoint, history);
    try {
      const result = await session.controller.start();
      if (!result.resumed || !result.sessionId) {
        throw new Error("adapter did not confirm loading the recorded internal session");
      }
      session.setInternalSessionId(result.sessionId, false);
      const attempt: ContinuationAttempt = Object.freeze({
        strategy: "load_internal_session",
        status: "succeeded",
      });
      const continuation = continuationReport(
        checkpoint, config.adapterId, session.v2Transcript, "available", [attempt],
        { kind: "loaded", activeInternalSessionId: result.sessionId },
      );
      const configuration = await session.restoreOpeningConfiguration();
      session._configurationRestore = configuration;
      session.emitStateIfChanged();
      return Object.freeze({
        session,
        continuation,
        recovery: structuredClone(session._recovery),
        configuration: structuredClone(configuration),
        promptability: session.promptability,
        repairs: [],
      });
    } catch (error) {
      await session.stop().catch(() => undefined);
      throw error;
    }
  }

  private static async openWithLock(
    config: AgentSessionOpenConfig,
    transcriptLock?: SessionLogWriterLock,
  ): Promise<AgentSessionOpenResult> {
    const strategies = normalizeContinuationStrategies(config.continuation);
    const persistence = resolveDirectPersistence(config.persistence);
    if (persistence === false || persistence.transcript === false) {
      throw new Error("AgentSession.open() currently requires transcript persistence");
    }
    const paths = await resolveSessionLogPaths(persistence, config.agentSessionId);
    if (!paths.transcriptPath) throw new Error("AgentSession.open() requires a transcript path");
    if (paths.auditLogPath) {
      throw new Error("direct v2 audit-log integration is not implemented yet");
    }

    const transcript = await TranscriptPersistenceRuntime.resume({
      path: paths.transcriptPath,
      expected: { agentSessionId: config.agentSessionId },
      writerLock: transcriptLock,
    });
    const checkpoint = transcript.checkpoint;
    try {
      validateAgentSessionCheckpoint(config.checkpoint ?? checkpoint, {
        agentSessionId: config.agentSessionId,
        incarnationId: checkpoint.incarnationId,
        transcriptId: checkpoint.transcript?.transcriptId,
        transcriptGeneration: checkpoint.transcript?.generation,
        transcriptPath: paths.transcriptPath,
      });
      if (config.checkpoint && config.checkpoint.digest !== checkpoint.digest) {
        throw new Error("consumer checkpoint does not match authoritative transcript checkpoint");
      }
      if (checkpoint.adapterId !== config.adapterId && !strategies.some(isReconstructionStrategy)) {
        throw new AdapterMismatchError(checkpoint.adapterId, config.adapterId);
      }
      const { checkpoint: _suppliedCheckpoint, continuation: _continuation, ...runtimeConfig } = config;
      const session = new AgentSession({
        ...runtimeConfig,
        agentSessionId: checkpoint.agentSessionId,
        creationId: checkpoint.incarnationId,
        mode: "normal",
        providerSession: checkpoint.internalSessionId
          ? {
              kind: "load",
              internalSessionId: checkpoint.internalSessionId,
              onFailure: "error",
            }
          : { kind: "new" },
        metering: {
          ...config.metering,
          initialState: checkpoint.metering,
        },
      }, { transcript, transcriptPath: paths.transcriptPath });

      try {
        const continuation = await session.acquireOpeningContinuation(checkpoint, strategies);
        if (continuation.outcome.kind === "unavailable") {
          throw new ContinuationUnavailableError(continuation);
        }
        const configuration = continuation.outcome.kind === "loaded"
          ? await session.restoreOpeningConfiguration()
          : session._configurationRestore;
        session._configurationRestore = configuration;
        session.emitStateIfChanged();
        return Object.freeze({
          session,
          continuation,
          recovery: structuredClone(session._recovery),
          configuration: structuredClone(configuration),
          promptability: session.promptability,
          repairs: transcript.openingRepairs,
        });
      } catch (error) {
        await session.stop().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      await transcript.close().catch(() => undefined);
      throw error;
    }
  }

  private async start(): Promise<void> {
    if (this.persistence !== false) {
      await this.startPersistent();
      return;
    }
    const result = await this.controller.start();
    // A resumed thread's counters did not start at zero, so it needs restored state to
    // be attributable.
    this.setInternalSessionId(result.sessionId || this._internalSessionId, !result.resumed);
    await this.persist();
    await this.appendTranscript({
      v: 1,
      t: "meta",
      event: "open",
      ts: Date.now(),
      internalSessionId: this._internalSessionId,
      adapter: this.adapterId,
    });
  }

  private async startPersistent(): Promise<void> {
    const persistence = this.persistence;
    if (persistence === false) throw new Error("persistent startup requires persistence configuration");
    if (this.openBootstrap) {
      this.v2Transcript = this.openBootstrap.transcript;
      this.v2TranscriptPath = this.openBootstrap.transcriptPath;
      this._recovery = this.v2Transcript.recovery;
      const result = await this.controller.start();
      if (!result.resumed || !result.sessionId) {
        throw new Error("adapter did not confirm loading the recorded internal session");
      }
      this.setInternalSessionId(result.sessionId, false);
      return;
    }
    const paths = await resolveSessionLogPaths(persistence, this.agentSessionId);
    if (paths.auditLogPath) {
      throw new Error("direct v2 audit-log integration is not implemented yet");
    }
    if (!paths.transcriptPath || persistence.transcript === false) {
      const result = await this.controller.start();
      this.setInternalSessionId(result.sessionId || this._internalSessionId, !result.resumed);
      if (this.managedCreation) {
        const now = new Date().toISOString();
        const observed: StagedContinuationState = {
          adapterId: this.adapterId,
          mode: this._mode,
          internalSessionId: this._internalSessionId,
          internalSessionActivatedAt: this._internalSessionId ? now : null,
          model: this.model,
          sessionConfiguration: snapshotSessionConfiguration({
            adapterId: this.adapterId,
            configOptions: this.controller.configOptions,
            policy: persistence.sessionConfiguration,
            observedAt: now,
          }),
          protocol: this.controller.isDegraded ? { name: "pty" } : { name: "acp", version: 1 },
        };
        const staged = await this.managedCreation.stageContinuation(observed);
        this.v2Transcript = new RegistryPersistenceRuntime(createAgentSessionCheckpoint({
          agentSessionId: this.agentSessionId,
          incarnationId: this.creationId,
          stateRevision: 1,
          adapterId: this.adapterId,
          mode: staged.mode,
          internalSessionId: staged.internalSessionId,
          internalSessionActivatedAt: staged.internalSessionActivatedAt,
          internalSessionHistoryRevision: 0,
          internalSessionHistoryDigest: EMPTY_HISTORY_DIGEST,
          model: staged.model,
          sessionConfiguration: staged.sessionConfiguration,
          protocol: staged.protocol,
          transcript: null,
          metering: this.metering.currentState,
          boundary: { status: "settled", lastSettledOperationId: null },
          updatedAt: now,
        }));
      }
      return;
    }

    const transcriptPath = paths.transcriptPath;
    const createdAt = new Date().toISOString();
    const transcriptId = crypto.randomUUID();
    const requestDigest = this.managedCreation?.requestDigest ?? sha256CanonicalJson({
      agentSessionId: this.agentSessionId,
      creationId: this.creationId,
      adapterId: this.adapterId,
      mode: this._mode,
      transcriptPath,
      preset: persistence.transcript.preset,
      capture: persistence.transcript.capture,
      limits: persistence.limits,
      includeTruncationDigests: persistence.transcript.includeTruncationDigests,
    });
    const header: TranscriptHeaderRecord = {
      v: 2,
      t: "header",
      transcriptId,
      generation: 1,
      agentSessionId: this.agentSessionId,
      seq: 1,
      ts: Date.parse(createdAt),
      event: "created",
      createdAt,
      preset: persistence.transcript.preset,
      effectivePolicy: persistence.transcript.capture,
      effectiveLimits: persistence.limits,
      includeTruncationDigests: persistence.transcript.includeTruncationDigests,
      installation: { kind: "creation", operationId: this.creationId, requestDigest },
    };

    this.v2TranscriptPath = transcriptPath;
    this.v2Transcript = await TranscriptPersistenceRuntime.create({
      path: transcriptPath,
      header,
      writerLock: this.managedCreation?.transcriptLock,
      initializeCheckpoint: async () => {
        const result = await this.controller.start();
        this.setInternalSessionId(result.sessionId || this._internalSessionId, !result.resumed);
        const now = new Date().toISOString();
        const sessionConfiguration = snapshotSessionConfiguration({
          adapterId: this.adapterId,
          configOptions: this.controller.configOptions,
          policy: persistence.sessionConfiguration,
          observedAt: now,
        });
        const observedContinuation: StagedContinuationState = {
          adapterId: this.adapterId,
          mode: this._mode,
          internalSessionId: this._internalSessionId,
          internalSessionActivatedAt: this._internalSessionId ? now : null,
          model: this.model,
          sessionConfiguration,
          protocol: this.controller.isDegraded ? { name: "pty" } : { name: "acp", version: 1 },
        };
        const stagedContinuation = this.managedCreation
          ? await this.managedCreation.stageContinuation(observedContinuation)
          : observedContinuation;
        return createAgentSessionCheckpoint({
          agentSessionId: this.agentSessionId,
          incarnationId: this.creationId,
          stateRevision: 1,
          adapterId: this.adapterId,
          mode: stagedContinuation.mode,
          internalSessionId: stagedContinuation.internalSessionId,
          internalSessionActivatedAt: stagedContinuation.internalSessionActivatedAt,
          internalSessionHistoryRevision: 0,
          internalSessionHistoryDigest: EMPTY_HISTORY_DIGEST,
          model: stagedContinuation.model,
          sessionConfiguration: stagedContinuation.sessionConfiguration,
          protocol: stagedContinuation.protocol,
          transcript: { transcriptId, generation: 1, path: transcriptPath, coveredSequence: 1 },
          metering: this.metering.currentState,
          boundary: { status: "settled", lastSettledOperationId: null },
          updatedAt: now,
        });
      },
    });
  }

  /**
   * Acquire one live provider thread from an explicit, ordered continuation policy.
   *
   * Loading is the only implicit/default behavior. Creating and seeding a replacement
   * thread can spend tokens and changes routing identity, so it occurs only when the
   * caller supplied a reconstruction strategy.
   */
  private async acquireOpeningContinuation(
    checkpoint: AgentSessionCheckpoint,
    strategies: readonly ContinuationStrategy[],
  ): Promise<ContinuationReport> {
    if (!this.openBootstrap || this.persistence === false) {
      throw new Error("opening continuation requires transcript persistence");
    }
    this.v2Transcript = this.openBootstrap.transcript;
    this.v2TranscriptPath = this.openBootstrap.transcriptPath;
    this._recovery = this.v2Transcript.recovery;
    this.continuationAcquired = false;

    const attempts: ContinuationAttempt[] = [];
    let recordedThreadAvailability: ContinuationReport["recordedThreadAvailability"] = "not_checked";

    for (const strategy of strategies) {
      if (strategy.kind === "load_internal_session") {
        if (!checkpoint.internalSessionId) {
          attempts.push(Object.freeze({
            strategy: strategy.kind,
            status: "skipped",
            errorCode: "internal_session_absent",
            reason: "the continuation checkpoint has no provider thread id",
          }));
          continue;
        }
        if (checkpoint.adapterId !== this.adapterId) {
          attempts.push(Object.freeze({
            strategy: strategy.kind,
            status: "skipped",
            errorCode: "adapter_mismatch",
            reason: `recorded adapter ${checkpoint.adapterId} differs from requested adapter ${this.adapterId}`,
          }));
          continue;
        }
        if (checkpoint.mode !== "normal") {
          attempts.push(Object.freeze({
            strategy: strategy.kind,
            status: "skipped",
            errorCode: "internal_session_not_loadable",
            reason: "degraded provider threads cannot be loaded through ACP",
          }));
          continue;
        }
        try {
          const loaded = await this.controller.start();
          if (!loaded.resumed || !loaded.sessionId) {
            throw new Error("adapter did not confirm loading the recorded internal session");
          }
          if (loaded.sessionId !== checkpoint.internalSessionId) {
            throw new Error("adapter loaded a different internal session than requested");
          }
          this._mode = this.controller.currentMode;
          this.setInternalSessionId(loaded.sessionId, false);
          this.continuationAcquired = true;
          recordedThreadAvailability = "available";
          attempts.push(Object.freeze({ strategy: strategy.kind, status: "succeeded" }));
          return continuationReport(checkpoint, this.adapterId, this.v2Transcript, recordedThreadAvailability, attempts, {
            kind: "loaded",
            activeInternalSessionId: loaded.sessionId,
          });
        } catch (error) {
          recordedThreadAvailability = "unavailable";
          attempts.push(Object.freeze({
            strategy: strategy.kind,
            status: "failed",
            errorCode: "internal_session_unavailable",
            reason: String(error),
          }));
          continue;
        }
      }

      if (this._recovery.kind !== "clean") {
        attempts.push(Object.freeze({
          strategy: strategy.kind,
          status: "skipped",
          errorCode: "recovery_required",
          reason: "transcript uncertainty must be resolved before activating a replacement thread",
        }));
        continue;
      }

      let continuation: string;
      const source = strategy.kind === "new_from_transcript" ? "transcript" as const : "consumer" as const;
      try {
        continuation = strategy.kind === "new_from_transcript"
          ? (await strategy.buildContinuation(Object.freeze({
              agentSessionId: this.agentSessionId,
              checkpoint: structuredClone(checkpoint),
              transcript: new TranscriptReader(this.openBootstrap.transcriptPath),
              targetAdapterId: this.adapterId,
            }))).continuation
          : strategy.continuation;
        if (!continuation.trim()) throw new Error("continuation content cannot be blank");
      } catch (error) {
        attempts.push(Object.freeze({
          strategy: strategy.kind,
          status: "failed",
          errorCode: "continuation_build_failed",
          reason: String(error),
        }));
        continue;
      }

      const transitionId = this.mintOperationId();
      const transitionKind = checkpoint.adapterId === this.adapterId ? "replacement" as const : "switch" as const;
      const from = descriptorFromCheckpoint(checkpoint);
      let to: InternalSessionDescriptor | undefined;
      let failedAfter: "start" | "target_created" | "target_activated" = "start";
      await this.v2Transcript.appendTransitionEvent({
        kind: "transition",
        transitionId,
        transitionKind,
        event: "started",
        from,
        reasonCode: "continuation_reconstruction",
      });
      try {
        const created = await this.controller.startFresh();
        if (!created.sessionId) throw new Error("harness returned no session id for reconstructed continuation");
        if (created.sessionId === checkpoint.internalSessionId && checkpoint.adapterId === this.adapterId) {
          throw new Error("harness did not create a replacement internal session");
        }

        const restored = checkpoint.adapterId === this.adapterId
          ? await this.restoreConfigurationOnReconstructedTarget(checkpoint.sessionConfiguration)
          : this.snapshotReconstructedConfiguration([]);
        this._configurationRestore = restored.status;
        const transitionAt = new Date().toISOString();
        to = {
          internalSessionId: created.sessionId,
          adapterId: this.adapterId,
          mode: "normal",
          model: this.model,
          sessionConfiguration: restored.snapshot,
          activatedAt: transitionAt,
          protocol: { name: "acp", version: 1 },
        };
        await this.v2Transcript.appendTransitionEvent({
          kind: "transition",
          transitionId,
          transitionKind,
          event: "target_created",
          from,
          to,
          reasonCode: "continuation_reconstruction",
        });
        failedAfter = "target_created";
        const current = this.v2Transcript.checkpoint;
        await this.v2Transcript.activateTransition({
          kind: "transition",
          transitionId,
          transitionKind,
          event: "target_activated",
          from,
          to,
          ...(from.internalSessionId
            ? {
                historyEntry: {
                  internalSessionId: from.internalSessionId,
                  adapterId: from.adapterId,
                  model: from.model,
                  sessionConfiguration: from.sessionConfiguration,
                  protocol: from.protocol,
                  activatedAt: from.activatedAt ?? checkpoint.updatedAt,
                  deactivatedAt: transitionAt,
                  transition: {
                    kind: transitionKind,
                    transitionId,
                    reasonCode: "continuation_reconstruction",
                  },
                },
              }
            : {}),
          activationState: {
            resultingStateRevision: current.stateRevision + 1,
            updatedAt: transitionAt,
            transitionAt,
            boundary: current.boundary,
          },
          reasonCode: "continuation_reconstruction",
        });
        failedAfter = "target_activated";
        this._mode = "normal";
        this.setInternalSessionId(created.sessionId, true);
        await this.v2Transcript.publishCheckpoint({
          model: this.model,
          sessionConfiguration: restored.snapshot,
          metering: this.metering.currentState,
        });

        const records: OperationMeteringRecord[] = [];
        const seeded = await this.meteredInternalPrompt(
          `${transitionId}:seed`,
          "switch_seed",
          continuationPrompt(continuation.trim()),
          records,
        );
        if (seeded.status !== "completed") {
          throw new Error(`continuation seeding ${seeded.status}`);
        }
        await this.v2Transcript.appendTransitionEvent({
          kind: "transition",
          transitionId,
          transitionKind,
          event: "completed",
          from,
          to,
          summary: continuation.trim(),
          reasonCode: "continuation_reconstruction",
        });
        this.continuationAcquired = true;
        attempts.push(Object.freeze({ strategy: strategy.kind, status: "succeeded" }));
        return continuationReport(checkpoint, this.adapterId, this.v2Transcript, recordedThreadAvailability, attempts, {
          kind: "reconstructed",
          source,
          activeInternalSessionId: created.sessionId,
          transitionId,
        });
      } catch (error) {
        await this.v2Transcript.appendTransitionEvent({
          kind: "transition",
          transitionId,
          transitionKind,
          event: "failed",
          from,
          ...(to ? { to } : {}),
          failedAfter,
          reasonCode: "continuation_reconstruction",
          errorCode: "unknown",
        }).catch((persistenceError) => {
          this.log.warn("continuation_failure_transcript_failed", { error: String(persistenceError) });
        });
        attempts.push(Object.freeze({
          strategy: strategy.kind,
          status: "failed",
          errorCode: "continuation_reconstruction_failed",
          reason: String(error),
        }));
        // Once activation is durable, another fallback would create a second transition
        // from a checkpoint the caller never selected. Reopen the newly active target.
        if (failedAfter === "target_activated") break;
      }
    }

    return continuationReport(
      checkpoint,
      this.adapterId,
      this.v2Transcript,
      recordedThreadAvailability,
      attempts,
      { kind: "unavailable" },
    );
  }

  private async restoreConfigurationOnReconstructedTarget(
    saved: SessionConfigurationCheckpoint,
  ): Promise<{ snapshot: SessionConfigurationCheckpoint; status: ConfigurationRestoreStatus }> {
    const mismatchedIds: string[] = [];
    const reasons: string[] = [];
    for (const target of [...saved.restorationTargets].sort((left, right) => left.ordinal - right.ordinal)) {
      const issue = configurationTargetIssue(this.controller.configOptions.get(target.configId), target);
      if (issue) {
        mismatchedIds.push(target.configId);
        reasons.push(issue);
        continue;
      }
      const option = this.controller.configOptions.get(target.configId)!;
      if (!sameJsonValue(option.currentValue, target.value)) {
        try {
          await this.controller.setConfig(target.configId, structuredClone(target.value));
        } catch {
          mismatchedIds.push(target.configId);
          reasons.push("reapplication_failed");
          continue;
        }
      }
      const current = this.controller.configOptions.get(target.configId);
      if (!current || !sameJsonValue(current.currentValue, target.value)) {
        mismatchedIds.push(target.configId);
        reasons.push("residual_value_mismatch");
      }
    }
    if (mismatchedIds.length > 0) {
      throw new Error(`configuration_mismatch: ${mismatchedIds.map((id, index) => `${id}:${reasons[index]}`).join(",")}`);
    }
    return this.snapshotReconstructedConfiguration(saved.restorationTargets, saved);
  }

  private snapshotReconstructedConfiguration(
    restorationTargets: readonly PersistedSessionConfigSelection[],
    prior?: SessionConfigurationCheckpoint,
  ): { snapshot: SessionConfigurationCheckpoint; status: ConfigurationRestoreStatus } {
    if (this.persistence === false) throw new Error("configuration snapshot requires persistence");
    const snapshot = snapshotSessionConfiguration({
      adapterId: this.adapterId,
      configOptions: this.controller.configOptions,
      policy: this.persistence.sessionConfiguration,
      restorationTargets,
    });
    const omittedConfigIds = [...new Set([
      ...(prior?.restorationFidelity === "partial" ? prior.omittedConfigIds : []),
      ...snapshot.omittedConfigIds,
    ])].sort();
    const status: ConfigurationRestoreStatus = prior?.restorationFidelity === "partial"
      || snapshot.restorationFidelity === "partial"
      ? Object.freeze({ kind: "partial", omittedConfigIds: Object.freeze(omittedConfigIds) })
      : Object.freeze({ kind: "matched" });
    return { snapshot, status };
  }

  // --- identity ----------------------------------------------------------------
  get internalSessionId(): string | null {
    return this._internalSessionId;
  }

  /**
   * Latest context-window observation for the ACTIVE provider thread, or null.
   *
   * Context does not aggregate across threads: after a handoff or any other thread
   * replacement this is null until the new thread reports, because the old thread's
   * occupancy says nothing about the new one's.
   */
  /**
   * models.dev provider key for the active route, or null when it cannot be established.
   *
   * Comes from a tested adapter mapping, or — for a harness whose model string is
   * `<provider>/<model>` — from that string. Never guessed: see metering/provider.ts.
   */
  get providerId(): string | null {
    return resolveModelReference(this.adapterId, this.advertisedModel)?.providerId ?? null;
  }

  /**
   * Model key for catalog lookup, or null.
   *
   * For a harness that advertises `<provider>/<model>`, this is the model half — the
   * provider prefix is routing, not part of the model's name. The raw advertised string
   * remains available through `configOptions`.
   */
  get model(): string | null {
    return resolveModelReference(this.adapterId, this.advertisedModel)?.modelId ?? this.advertisedModel;
  }

  /** Exactly what the harness advertises, before any provider/model split. */
  get advertisedModel(): string | null {
    return activeModel(this.controller.configOptions);
  }

  /** Bounded metering state, enforcement policy, and the last operation record. */
  get meteringSnapshot(): AgentSessionMeteringSnapshot {
    const restoration = this.metering.restoration;
    return Object.freeze({
      ...this.metering.currentState,
      enforcement: this.metering.enforcement,
      // Carry the version the restore actually reported. The `state` field is dropped
      // because the snapshot already IS the state; the version is not re-stated literally.
      restoration:
        restoration.status === "restored"
          ? { status: "restored" as const, version: restoration.version }
          : restoration,
      blocked: this.metering.blocked,
      blockedReason: this.metering.blockedReason,
      outstandingReports: this.metering.outstandingReports(this._internalSessionId),
      lastOperation: this.metering.lastOperation,
    });
  }

  get contextWindow(): ContextWindowStatus | null {
    return this._contextWindow;
  }

  /**
   * Latest cumulative provider-reported cost for the active thread, or null.
   *
   * Provider telemetry, kept distinct from locally rated cost and never asserted to be an
   * invoice — a subscription harness may report an API-equivalent figure.
   */
  get providerCost(): ProviderCostSnapshot | null {
    return this._providerCost;
  }
  get mode(): AgentMode {
    return this._mode;
  }
  get cwd(): string | undefined {
    return this._cwd;
  }
  get title(): string | undefined {
    return this._title;
  }
  /** Resolved history destination, configured directly or derived from transcriptDir. */
  get transcriptPath(): string | undefined {
    return this.v2TranscriptPath ?? this._transcriptPath;
  }
  get recoveryStatus(): SessionRecoveryStatus {
    return structuredClone(this._recovery);
  }
  get configurationRestoreStatus(): ConfigurationRestoreStatus {
    return structuredClone(this._configurationRestore);
  }

  /** @internal Current authority used by SessionManager to stage the initial registry row. */
  getManagedPersistenceSnapshot(): ManagedAgentSessionPersistenceSnapshot {
    if (!this.v2Transcript) throw new Error("managed persistence snapshot requires a v2 transcript");
    return Object.freeze({
      checkpoint: this.v2Transcript.checkpoint,
      internalSessionHistory: Object.freeze([...this.v2Transcript.internalSessionHistory]),
    });
  }

  /** @internal Materialize a durable post-restoration boundary before clearing a tombstone. */
  async publishManagedRestorationCheckpoint(): Promise<ManagedAgentSessionPersistenceSnapshot> {
    if (!this.v2Transcript) throw new Error("managed restoration requires a v2 transcript");
    await this.v2Transcript.publishCheckpoint({});
    return this.getManagedPersistenceSnapshot();
  }

  /** @internal Publish every later transcript checkpoint into the managed registry. */
  attachManagedCheckpointPublisher(
    publisher: (
      checkpoint: AgentSessionCheckpoint,
      history: readonly InternalSessionHistoryEntry[],
    ) => Promise<void>,
  ): void {
    if (!this.v2Transcript) throw new Error("managed checkpoint publication requires a v2 transcript");
    this.v2Transcript.setCheckpointPublisher(async (checkpoint, history) => {
      try {
        await publisher(checkpoint, history);
      } catch (error) {
        this.managedPersistenceHealthy = false;
        this.emitStateIfChanged();
        throw error;
      }
    });
  }
  get promptability(): AgentSessionPromptability {
    const blockers: PromptBlocker[] = [];
    if (!this.continuationAcquired) blockers.push("continuation_unavailable");
    if (this._recovery.kind !== "clean") blockers.push("recovery_required");
    if (this._configurationRestore.kind === "mismatch") blockers.push("configuration_mismatch");
    if ((this.v2Transcript && !this.v2Transcript.healthy) || !this.managedPersistenceHealthy) {
      blockers.push("persistence_unhealthy");
    }
    if (this.phase === "stopped") blockers.push("session_stopped");
    return blockers.length === 0
      ? Object.freeze({ promptable: true as const, blockers: Object.freeze([] as const) })
      : Object.freeze({ promptable: false as const, blockers: Object.freeze(blockers) });
  }
  /** Immutable current state. Late subscribers read this before listening for deltas. */
  get state(): AgentSessionState {
    return Object.freeze({
      phase: this.phase,
      isBusy: this.isBusy,
      queuedOperationCount: this.queuedOperationCount,
      agentSessionId: this.agentSessionId,
      internalSessionId: this._internalSessionId,
      adapterId: this.adapterId,
      mode: this._mode,
      promptability: this.promptability,
    });
  }
  /** True while one operation is executing. Queued work is exposed independently. */
  get isBusy(): boolean {
    return this.phase !== "idle" && this.phase !== "stopped";
  }
  get queuedOperationCount(): number {
    return this.queue.length;
  }
  /** Subscribe to future lifecycle changes. The current snapshot is available via state. */
  subscribe(listener: AgentSessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Escape hatch to the live control plane (config, caps, getCommands, login, …). */
  get connection(): AgentController {
    return this.controller;
  }

  // --- AgentClient -------------------------------------------------------------
  async prompt(
    text: string,
    handlers?: PromptHandlers,
    attachments?: Attachment[],
  ): Promise<AgentSessionPromptResult> {
    return this.enqueuePrompt(text, "prompt", handlers, attachments);
  }

  private enqueuePrompt(
    text: string,
    operationKind: MeteredOperationKind,
    handlers?: PromptHandlers,
    attachments?: Attachment[],
  ): Promise<AgentSessionPromptResult> {
    return new Promise<AgentSessionPromptResult>((resolve, reject) => {
      if (this.phase === "stopped") {
        reject(new Error("AgentSession is stopped"));
        return;
      }
      try {
        this.assertPromptable();
      } catch (error) {
        reject(error);
        return;
      }
      this.queue.push({
        kind: "prompt",
        turnId: this.mintTurnId(),
        operationKind,
        text,
        handlers,
        attachments,
        resolve,
        reject,
      });
      this.emitStateIfChanged();
      void this.pump();
    });
  }

  /**
   * Execute one command advertised by the active ACP harness. ACP represents slash
   * commands as ordinary prompt text; this method makes that intentional and keeps the
   * operation in the same queue, lifecycle events, and transcript as every other turn.
   * Advertisement is discoverability, not an allow-list: a harness may accept commands
   * that it did not advertise yet.
   */
  executeInternalSessionCommand(
    name: string,
    input?: string,
    handlers?: PromptHandlers,
  ): Promise<AgentSessionPromptResult> {
    const command = name.trim();
    if (!command || command.startsWith("/") || /\s/.test(command)) {
      return Promise.reject(
        new Error("internal session command name must be non-empty, contain no whitespace, and omit the leading slash"),
      );
    }
    const suffix = input == null || input.length === 0 ? "" : ` ${input}`;
    return this.enqueuePrompt(`/${command}${suffix}`, "internal_command", handlers);
  }

  /**
   * Replace the underlying ACP thread while preserving this logical AgentSession object
   * and id. The operation is serialized with prompts, so consumers never have to
   * coordinate a handoff against in-flight work themselves.
   */
  handoff(options: HandoffOptions = {}): Promise<HandoffResult> {
    return new Promise<HandoffResult>((resolve, reject) => {
      if (this.phase === "stopped") {
        reject(new Error("AgentSession is stopped"));
        return;
      }
      try {
        this.assertPromptable();
      } catch (error) {
        reject(error);
        return;
      }
      this.queue.push({
        kind: "handoff",
        handoffId: this.mintOperationId(),
        // A queued operation owns its arguments. Do not let a caller mutate the object
        // while it waits behind an active prompt and silently change the handoff.
        options: Object.freeze({ ...options }),
        resolve,
        reject,
      });
      this.emitStateIfChanged();
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        this.phase = item.kind === "prompt"
          ? "prompting"
          : item.kind === "handoff"
            ? "handoff"
            : item.kind === "set_config" || item.kind === "resolve_config"
              ? "configuring"
              : item.kind === "resolve_recovery"
                ? "recovering"
              : "switching_mode";
        this.emitStateIfChanged();
        if (item.kind === "prompt") {
          this.emit({ kind: "turn_started", turnId: item.turnId });
          try {
            const result = await this.runPrompt(item);
            this.emit({
              kind: "turn_completed",
              turnId: item.turnId,
              result: copyPromptResult(result),
            });
            item.resolve(result);
          } catch (err) {
            this.emit({ kind: "turn_failed", turnId: item.turnId, error: String(err) });
            item.reject(err);
          }
        } else if (item.kind === "handoff") {
          try {
            item.resolve(await this.runHandoff(item));
          } catch (err) {
            item.reject(err);
          }
        } else if (item.kind === "set_config") {
          this.emit({ kind: "configuration_started", operationId: item.operationId, configId: item.configId });
          try {
            await this.runSetConfig(item);
            this.emit({ kind: "configuration_completed", operationId: item.operationId, configId: item.configId });
            item.resolve();
          } catch (err) {
            this.emit({ kind: "configuration_failed", operationId: item.operationId, configId: item.configId, error: String(err) });
            item.reject(err);
          }
        } else if (item.kind === "resolve_config") {
          try {
            const result = await this.runResolveConfigurationMismatch(item.resolution);
            this.emit({
              kind: "configuration_mismatch_resolved",
              configuration: structuredClone(result.configuration),
              appliedConfigIds: result.appliedConfigIds,
            });
            item.resolve(result);
          } catch (err) {
            item.reject(err);
          }
        } else if (item.kind === "resolve_recovery") {
          try {
            item.resolve(await this.runResolveRecovery(item.resolution));
          } catch (err) {
            item.reject(err);
          }
        } else {
          const from = this._mode;
          this.emit({ kind: "mode_change_started", transitionId: item.transitionId, from, to: item.mode });
          try {
            const result = await this.runSetMode(item);
            this.emit({ kind: "mode_change_completed", transitionId: item.transitionId, from, to: item.mode });
            item.resolve(result);
          } catch (err) {
            this.emit({ kind: "mode_change_failed", transitionId: item.transitionId, from, to: item.mode, error: String(err) });
            item.reject(err);
          }
        }
      }
    } finally {
      this.pumping = false;
      if (this.phase !== "stopped") this.phase = "idle";
      this.emitStateIfChanged();
    }
  }

  private async runHandoff(item: HandoffQueueItem): Promise<HandoffResult> {
    const fromInternalSessionId = this._internalSessionId;
    const fromDescriptor = this.v2Transcript ? this.v2Descriptor() : null;
    let toInternalSessionId: string | undefined;
    let toDescriptor: InternalSessionDescriptor | undefined;
    let summary: string | undefined;
    let failedAfter: "start" | "target_created" | "target_activated" = "start";
    // Records accumulate as they complete, so a handoff that fails partway still reports
    // the operations it already paid for.
    const records: OperationMeteringRecord[] = [];
    this.emit({
      kind: "handoff_started",
      handoffId: item.handoffId,
      fromInternalSessionId,
    });
    if (this.v2Transcript) {
      await this.v2Transcript.appendTransitionEvent({
        kind: "transition",
        transitionId: item.handoffId,
        transitionKind: "handoff",
        event: "started",
        from: fromDescriptor,
        ...(item.options.summary !== undefined ? { summary: item.options.summary } : {}),
      });
    } else {
      await this.appendTranscript({
        v: 1,
        t: "handoff",
        event: "start",
        ts: Date.now(),
        handoffId: item.handoffId,
        fromInternalSessionId,
        ...(item.options.summary !== undefined ? { summary: item.options.summary } : {}),
      });
    }

    try {
      if (this.controller.isDegraded) {
        throw new Error("handoff requires ACP (normal) mode");
      }

      if (item.options.summary !== undefined) {
        if (!item.options.summary.trim()) throw new Error("handoff summary cannot be blank");
        // A supplied summary removes the generation operation entirely, so no
        // `:summary` record is ever minted for it.
        summary = item.options.summary;
      } else {
        const generated = await this.meteredInternalPrompt(
          `${item.handoffId}:summary`,
          "handoff_summary",
          HANDOFF_SUMMARY_PROMPT,
          records,
        );
        if (generated.status !== "completed" || !generated.text.trim()) {
          throw new Error(`handoff summary generation ${generated.status}`);
        }
        summary = generated.text.trim();
      }

      const created = await this.controller.newSession();
      if (!created.sessionId) throw new Error("harness returned no session id for handoff");
      toInternalSessionId = created.sessionId;
      if (toInternalSessionId === fromInternalSessionId) {
        throw new Error("harness did not replace the internal session during handoff");
      }

      if (this.v2Transcript) {
        const transitionAt = new Date().toISOString();
        toDescriptor = this.v2Descriptor(toInternalSessionId, transitionAt);
        await this.v2Transcript.appendTransitionEvent({
          kind: "transition",
          transitionId: item.handoffId,
          transitionKind: "handoff",
          event: "target_created",
          from: fromDescriptor,
          to: toDescriptor,
        });
        failedAfter = "target_created";
        const checkpoint = this.v2Transcript.checkpoint;
        await this.v2Transcript.activateTransition({
          kind: "transition",
          transitionId: item.handoffId,
          transitionKind: "handoff",
          event: "target_activated",
          from: fromDescriptor,
          to: toDescriptor,
          ...(fromDescriptor?.internalSessionId
            ? {
                historyEntry: {
                  internalSessionId: fromDescriptor.internalSessionId,
                  adapterId: fromDescriptor.adapterId,
                  model: fromDescriptor.model,
                  sessionConfiguration: fromDescriptor.sessionConfiguration,
                  protocol: fromDescriptor.protocol,
                  activatedAt: fromDescriptor.activatedAt!,
                  deactivatedAt: transitionAt,
                  transition: { kind: "handoff", transitionId: item.handoffId },
                },
              }
            : {}),
          activationState: {
            resultingStateRevision: checkpoint.stateRevision + 1,
            updatedAt: transitionAt,
            transitionAt,
            boundary: checkpoint.boundary,
          },
        });
        failedAfter = "target_activated";
      }
      this.setInternalSessionId(toInternalSessionId);
      this.emitStateIfChanged();
      await this.persist();

      const seeded = await this.meteredInternalPrompt(
        `${item.handoffId}:seed`,
        "handoff_seed",
        continuationPrompt(summary),
        records,
      );
      if (seeded.status !== "completed") {
        throw new Error(`handoff continuation seeding ${seeded.status}`);
      }

      const result: HandoffResult = Object.freeze({
        handoffId: item.handoffId,
        agentSessionId: this.agentSessionId,
        fromInternalSessionId,
        toInternalSessionId,
        summary,
        meteringRecords: Object.freeze([...records]),
      });
      if (this.v2Transcript) {
        await this.v2Transcript.appendTransitionEvent({
          kind: "transition",
          transitionId: item.handoffId,
          transitionKind: "handoff",
          event: "completed",
          from: fromDescriptor,
          to: toDescriptor,
          summary,
        });
      } else {
        await this.appendTranscript({
          v: 1,
          t: "handoff",
          event: "complete",
          ts: Date.now(),
          handoffId: item.handoffId,
          fromInternalSessionId,
          toInternalSessionId,
          summary,
        });
      }
      this.emit({ kind: "handoff_completed", result });
      return result;
    } catch (err) {
      // Once session/new succeeds the controller really is on the new thread. Keep the
      // public id and catalog truthful even when continuation seeding subsequently fails.
      const actualSessionId = this.controller.currentSessionId;
      if (!this.v2Transcript && actualSessionId && actualSessionId !== this._internalSessionId) {
        this.setInternalSessionId(actualSessionId);
        toInternalSessionId = actualSessionId;
        this.emitStateIfChanged();
        try {
          await this.persist();
        } catch (persistError) {
          this.log.warn("handoff_failure_persist_failed", { error: String(persistError) });
        }
      }
      const error = String(err);
      if (this.v2Transcript) {
        await this.v2Transcript.appendTransitionEvent({
          kind: "transition",
          transitionId: item.handoffId,
          transitionKind: "handoff",
          event: "failed",
          from: fromDescriptor,
          ...(toDescriptor ? { to: toDescriptor } : {}),
          failedAfter,
          ...(summary !== undefined ? { summary } : {}),
          errorCode: "unknown",
        }).catch((persistenceError) => {
          this.log.warn("handoff_failure_transcript_failed", { error: String(persistenceError) });
        });
      } else {
        await this.appendTranscript({
          v: 1,
          t: "handoff",
          event: "failed",
          ts: Date.now(),
          handoffId: item.handoffId,
          fromInternalSessionId,
          ...(toInternalSessionId ? { toInternalSessionId } : {}),
          ...(summary !== undefined ? { summary } : {}),
          error,
        });
      }
      this.emit({
        kind: "handoff_failed",
        handoffId: item.handoffId,
        fromInternalSessionId,
        ...(toInternalSessionId ? { toInternalSessionId } : {}),
        error,
        meteringRecords: Object.freeze([...records]),
      });
      // A rejected handoff cannot return a HandoffResult, but the summary/seed prompts it
      // already ran consumed real tokens; their records travel on the error.
      throw new AgentSessionHandoffError(item.handoffId, records, err);
    }
  }

  private async runSetConfig(item: ConfigQueueItem): Promise<void> {
    if (!this.v2Transcript || this.persistence === false) {
      await this.controller.setConfig(item.configId, item.value);
      return;
    }

    const before = this.v2Transcript.checkpoint;
    const announced = this.controller.configOptions.get(item.configId);
    await this.v2Transcript.beginOperation(item.operationId, "set_config");
    try {
      await this.v2Transcript.syncBeforeDispatch();
    } catch (error) {
      await this.v2Transcript.abortOperation("pre_dispatch_persistence_failure").catch(
        (abortError) => this.log.warn("transcript_predispatch_abort_failed", { error: String(abortError) }),
      );
      throw error;
    }

    let applied = false;
    try {
      await this.controller.setConfig(item.configId, item.value);
      applied = true;
      const observedAt = new Date().toISOString();
      const sessionConfiguration = snapshotSessionConfigurationAfterSelection({
        adapterId: this.adapterId,
        configOptions: this.controller.configOptions,
        policy: this.persistence.sessionConfiguration,
        restorationTargets: before.sessionConfiguration.restorationTargets,
        selection: {
          configId: item.configId,
          type: announced?.type ?? "unknown",
          value: item.value,
          recordedAt: observedAt,
        },
        observedAt,
      });
      const persistedTarget = sessionConfiguration.restorationTargets.find(
        (target) => target.configId === item.configId,
      );
      await this.v2Transcript.appendEvent({
        kind: "configuration",
        event: "selected",
        configId: item.configId,
        ...(persistedTarget ? { value: persistedTarget.value } : {}),
        schemaDigest: sessionConfiguration.schemaDigest ?? undefined,
      });
      await this.v2Transcript.finishOperation("settled", {
        model: this.model,
        sessionConfiguration,
        metering: this.metering.currentState,
      });
    } catch (error) {
      if (applied) {
        // The harness changed even if a later local record failed. Attempt one truthful
        // checkpoint of the observed state; a poisoned runtime rejects and stays blocked.
        const observedAt = new Date().toISOString();
        const sessionConfiguration = snapshotSessionConfigurationAfterSelection({
          adapterId: this.adapterId,
          configOptions: this.controller.configOptions,
          policy: this.persistence.sessionConfiguration,
          restorationTargets: before.sessionConfiguration.restorationTargets,
          selection: {
            configId: item.configId,
            type: announced?.type ?? "unknown",
            value: item.value,
            recordedAt: observedAt,
          },
          observedAt,
        });
        await this.v2Transcript.finishOperation("failed", {
          model: this.model,
          sessionConfiguration,
          metering: this.metering.currentState,
        }, "unknown").catch((persistenceError) => {
          this.log.warn("configuration_failure_checkpoint_failed", { error: String(persistenceError) });
        });
      } else {
        await this.v2Transcript.finishOperation("failed", {}, "unknown").catch(
          (persistenceError) => this.log.warn("configuration_failure_checkpoint_failed", { error: String(persistenceError) }),
        );
      }
      throw error;
    }
  }

  private async restoreOpeningConfiguration(): Promise<ConfigurationRestoreStatus> {
    if (!this.v2Transcript || this.persistence === false) return { kind: "matched" };
    const saved = this.v2Transcript.checkpoint.sessionConfiguration;
    const mismatchedIds: string[] = [];
    const reasons: string[] = [];

    for (const target of [...saved.restorationTargets].sort((a, b) => a.ordinal - b.ordinal)) {
      const issue = configurationTargetIssue(this.controller.configOptions.get(target.configId), target);
      if (issue) {
        mismatchedIds.push(target.configId);
        reasons.push(issue);
        continue;
      }
      const option = this.controller.configOptions.get(target.configId)!;
      if (sameJsonValue(option.currentValue, target.value)) continue;
      if (this._recovery.kind !== "clean") {
        mismatchedIds.push(target.configId);
        reasons.push("recovery_required_before_reapplication");
        continue;
      }
      const operationId = this.mintOperationId();
      await this.v2Transcript.beginOperation(operationId, "set_config");
      try {
        await this.v2Transcript.syncBeforeDispatch();
      } catch (error) {
        await this.v2Transcript.abortOperation("pre_dispatch_persistence_failure").catch(() => undefined);
        throw error;
      }
      try {
        await this.controller.setConfig(target.configId, structuredClone(target.value));
        const observedAt = new Date().toISOString();
        const snapshot = snapshotSessionConfiguration({
          adapterId: this.adapterId,
          configOptions: this.controller.configOptions,
          policy: this.persistence.sessionConfiguration,
          restorationTargets: saved.restorationTargets,
          observedAt,
        });
        await this.v2Transcript.appendEvent({
          kind: "configuration",
          event: "restored",
          configId: target.configId,
          value: target.value,
          schemaDigest: snapshot.schemaDigest ?? undefined,
        });
        await this.v2Transcript.finishOperation("settled", {
          model: this.model,
          sessionConfiguration: snapshot,
          metering: this.metering.currentState,
        });
      } catch (error) {
        await this.v2Transcript.finishOperation("failed", {}, "unknown").catch(() => undefined);
        mismatchedIds.push(target.configId);
        reasons.push("reapplication_failed");
        continue;
      }
      const restored = this.controller.configOptions.get(target.configId);
      if (!restored || !sameJsonValue(restored.currentValue, target.value)) {
        mismatchedIds.push(target.configId);
        reasons.push("residual_value_mismatch");
      }
    }

    if (mismatchedIds.length > 0) {
      return Object.freeze({
        kind: "mismatch" as const,
        configIds: Object.freeze(mismatchedIds),
        reasons: Object.freeze(reasons),
      });
    }
    const current = snapshotSessionConfiguration({
      adapterId: this.adapterId,
      configOptions: this.controller.configOptions,
      policy: this.persistence.sessionConfiguration,
      restorationTargets: saved.restorationTargets,
    });
    const omittedConfigIds = [...new Set([
      ...(saved.restorationFidelity === "partial" ? saved.omittedConfigIds : []),
      ...current.omittedConfigIds,
    ])].sort();
    return saved.restorationFidelity === "partial" || current.restorationFidelity === "partial"
      ? Object.freeze({ kind: "partial" as const, omittedConfigIds: Object.freeze(omittedConfigIds) })
      : Object.freeze({ kind: "matched" as const });
  }

  private async runResolveConfigurationMismatch(
    resolution: ConfigurationMismatchResolution,
  ): Promise<ConfigurationMismatchResolutionResult> {
    if (this._configurationRestore.kind !== "mismatch") {
      throw new Error("configuration mismatch resolution requires a mismatched session");
    }
    if (!this.v2Transcript || this.persistence === false) {
      throw new Error("configuration mismatch resolution requires v2 transcript persistence");
    }
    if (this._recovery.kind !== "clean") {
      throw new AgentSessionPromptBlockedError(["recovery_required"]);
    }
    if (!this.v2Transcript.healthy) {
      throw new AgentSessionPromptBlockedError(["persistence_unhealthy"]);
    }

    let snapshot: SessionConfigurationCheckpoint;
    const appliedConfigIds: string[] = [];
    if (resolution.strategy === "accept_effective") {
      const recordedAt = new Date().toISOString();
      snapshot = snapshotAcceptedEffectiveConfiguration({
        adapterId: this.adapterId,
        configOptions: this.controller.configOptions,
        policy: this.persistence.sessionConfiguration,
        recordedAt,
      });
    } else {
      validateReplacementSelections(resolution.selections, this.controller.configOptions);
      let restorationTargets: readonly PersistedSessionConfigSelection[] = [];
      for (const selection of resolution.selections) {
        const option = this.controller.configOptions.get(selection.configId);
        const issue = configurationTargetIssue(option, {
          configId: selection.configId,
          type: option?.type ?? "unknown",
          value: selection.value,
          ordinal: 0,
          source: "explicit_selection",
          recordedAt: new Date(0).toISOString(),
        });
        if (issue) throw new Error(`${issue}: ${selection.configId}`);
        const recordedAt = new Date().toISOString();
        if (!sameJsonValue(option!.currentValue, selection.value)) {
          await this.applyConfigurationResolutionSelection(
            selection.configId,
            selection.value,
            this.v2Transcript.checkpoint.sessionConfiguration.restorationTargets,
          );
          appliedConfigIds.push(selection.configId);
        }
        const selected = snapshotSessionConfigurationAfterSelection({
          adapterId: this.adapterId,
          configOptions: this.controller.configOptions,
          policy: this.persistence.sessionConfiguration,
          restorationTargets,
          selection: {
            configId: selection.configId,
            type: this.controller.configOptions.get(selection.configId)?.type ?? "unknown",
            value: selection.value,
            recordedAt,
          },
          observedAt: recordedAt,
        });
        restorationTargets = selected.restorationTargets;
      }
      for (const selection of resolution.selections) {
        const current = this.controller.configOptions.get(selection.configId);
        if (!current || !sameJsonValue(current.currentValue, selection.value)) {
          throw new Error(`configuration resolution left a residual mismatch for ${selection.configId}`);
        }
      }
      snapshot = snapshotSessionConfiguration({
        adapterId: this.adapterId,
        configOptions: this.controller.configOptions,
        policy: this.persistence.sessionConfiguration,
        restorationTargets,
      });
    }

    await this.v2Transcript.appendEvent({
      kind: "configuration",
      event: "resolved",
      schemaDigest: snapshot.schemaDigest ?? undefined,
    });
    await this.v2Transcript.publishCheckpoint({
      model: this.model,
      sessionConfiguration: snapshot,
      metering: this.metering.currentState,
    });
    const configuration: ConfigurationRestoreStatus = snapshot.restorationFidelity === "partial"
      ? Object.freeze({
          kind: "partial",
          omittedConfigIds: Object.freeze([...snapshot.omittedConfigIds]),
        })
      : Object.freeze({ kind: "matched" });
    this._configurationRestore = configuration;
    this.emitStateIfChanged();
    return Object.freeze({
      configuration: structuredClone(configuration),
      appliedConfigIds: Object.freeze(appliedConfigIds),
    });
  }

  private async runResolveRecovery(
    resolution: AgentSessionRecoveryResolution,
  ): Promise<AgentSessionRecoveryResolutionResult> {
    if (!this.v2Transcript) throw new Error("recovery resolution requires v2 transcript persistence");
    if (this._recovery.kind !== "uncertain") {
      throw new Error("recovery resolution requires an uncertain session");
    }
    if (!this.v2Transcript.healthy) {
      throw new AgentSessionPromptBlockedError(["persistence_unhealthy"]);
    }
    const previous = structuredClone(this._recovery);
    await this.v2Transcript.acceptHarnessRecovery();
    this._recovery = { kind: "clean" };
    this.emit({
      kind: "recovery_resolved",
      strategy: resolution.strategy,
      previous,
      recovery: { kind: "clean" },
    });
    this.emitStateIfChanged();

    let handoff: HandoffResult | undefined;
    if (resolution.strategy === "start_new_internal_session") {
      handoff = await this.runHandoff({
        kind: "handoff",
        handoffId: this.mintOperationId(),
        options: resolution.continuation === undefined
          ? Object.freeze({})
          : Object.freeze({ summary: resolution.continuation }),
        resolve: () => undefined,
        reject: () => undefined,
      });
    }
    return Object.freeze({
      previous,
      recovery: Object.freeze({ kind: "clean" as const }),
      ...(handoff ? { handoff } : {}),
    });
  }

  private async applyConfigurationResolutionSelection(
    configId: string,
    value: JsonValue,
    restorationTargets: readonly PersistedSessionConfigSelection[],
  ): Promise<void> {
    if (!this.v2Transcript || this.persistence === false) throw new Error("v2 transcript required");
    const operationId = this.mintOperationId();
    await this.v2Transcript.beginOperation(operationId, "set_config");
    try {
      await this.v2Transcript.syncBeforeDispatch();
    } catch (error) {
      await this.v2Transcript.abortOperation("pre_dispatch_persistence_failure").catch(() => undefined);
      throw error;
    }
    try {
      await this.controller.setConfig(configId, structuredClone(value));
      const observedAt = new Date().toISOString();
      const intermediate = snapshotSessionConfiguration({
        adapterId: this.adapterId,
        configOptions: this.controller.configOptions,
        policy: this.persistence.sessionConfiguration,
        restorationTargets,
        observedAt,
      });
      await this.v2Transcript.appendEvent({
        kind: "configuration",
        event: "selected",
        configId,
        ...(configId in intermediate.effective ? { value } : {}),
        schemaDigest: intermediate.schemaDigest ?? undefined,
      });
      await this.v2Transcript.finishOperation("settled", {
        model: this.model,
        sessionConfiguration: intermediate,
        metering: this.metering.currentState,
      });
    } catch (error) {
      await this.v2Transcript.finishOperation("failed", {}, "unknown").catch(() => undefined);
      throw error;
    }
  }

  private async runSetMode(item: ModeQueueItem): Promise<ConnectResult> {
    if (item.mode === this._mode) return await this.controller.setMode(item.mode);
    if (!this.v2Transcript) {
      const result = await this.controller.setMode(item.mode);
      this._mode = this.controller.currentMode;
      this.setInternalSessionId(result.sessionId || null);
      await this.persist();
      return result;
    }

    const from = this.v2Descriptor();
    let to: InternalSessionDescriptor | undefined;
    let failedAfter: "start" | "target_created" | "target_activated" = "start";
    await this.v2Transcript.appendTransitionEvent({
      kind: "transition",
      transitionId: item.transitionId,
      transitionKind: "mode_change",
      event: "started",
      from,
      reasonCode: "mode_change",
    });
    try {
      const result = await this.controller.setMode(item.mode);
      const targetMode = this.controller.currentMode;
      const targetInternalSessionId = result.sessionId || null;
      const transitionAt = new Date().toISOString();
      to = this.v2Descriptor(targetInternalSessionId, transitionAt, targetMode);
      await this.v2Transcript.appendTransitionEvent({
        kind: "transition",
        transitionId: item.transitionId,
        transitionKind: "mode_change",
        event: "target_created",
        from,
        to,
        reasonCode: "mode_change",
      });
      failedAfter = "target_created";
      const checkpoint = this.v2Transcript.checkpoint;
      await this.v2Transcript.activateTransition({
        kind: "transition",
        transitionId: item.transitionId,
        transitionKind: "mode_change",
        event: "target_activated",
        from,
        to,
        ...(from.internalSessionId
          ? {
              historyEntry: {
                internalSessionId: from.internalSessionId,
                adapterId: from.adapterId,
                model: from.model,
                sessionConfiguration: from.sessionConfiguration,
                protocol: from.protocol,
                activatedAt: from.activatedAt!,
                deactivatedAt: transitionAt,
                transition: {
                  kind: "mode_change",
                  transitionId: item.transitionId,
                  reasonCode: "mode_change",
                },
              },
            }
          : {}),
        activationState: {
          resultingStateRevision: checkpoint.stateRevision + 1,
          updatedAt: transitionAt,
          transitionAt,
          boundary: checkpoint.boundary,
        },
        reasonCode: "mode_change",
      });
      failedAfter = "target_activated";
      this._mode = targetMode;
      this.setInternalSessionId(targetInternalSessionId);
      this.emitStateIfChanged();
      await this.v2Transcript.publishCheckpoint({ metering: this.metering.currentState });
      await this.v2Transcript.appendTransitionEvent({
        kind: "transition",
        transitionId: item.transitionId,
        transitionKind: "mode_change",
        event: "completed",
        from,
        to,
        reasonCode: "mode_change",
      });
      return result;
    } catch (error) {
      await this.v2Transcript.appendTransitionEvent({
        kind: "transition",
        transitionId: item.transitionId,
        transitionKind: "mode_change",
        event: "failed",
        from,
        ...(to ? { to } : {}),
        failedAfter,
        reasonCode: "mode_change",
        errorCode: "unknown",
      }).catch((persistenceError) => {
        this.log.warn("mode_change_failure_transcript_failed", { error: String(persistenceError) });
      });
      throw error;
    }
  }

  private async runPrompt(item: PromptQueueItem): Promise<AgentSessionPromptResult> {
    this.beginTurn(item.turnId);
    let operation: OpenOperation;
    if (this.v2Transcript) {
      let transcriptStarted = false;
      try {
        // Metering preflight has no provider side effect. Run it before minting durable
        // operation evidence so a strict pricing/policy rejection needs no abort record.
        operation = await this.openMeteredOperation(item);
        await this.v2Transcript.beginOperation(item.turnId, persistenceOperationKind(item.operationKind));
        transcriptStarted = true;
        await this.v2Transcript.appendEvent({
          kind: "message",
          operationId: item.turnId,
          role: "user",
          text: item.text,
        });
        await this.v2Transcript.syncBeforeDispatch();
      } catch (error) {
        this.endTurn(item.handlers);
        if (transcriptStarted) {
          await this.v2Transcript.abortOperation("pre_dispatch_persistence_failure").catch(
            (abortError) => this.log.warn("transcript_predispatch_abort_failed", { error: String(abortError) }),
          );
        }
        throw error;
      }
    } else {
      await this.appendTranscript({
        v: 1,
        t: "msg",
        role: "user",
        text: item.text,
        ts: Date.now(),
      });
      operation = await this.openMeteredOperation(item);
    }

    const chunks: string[] = [];
    const response = new ResponseAccumulator();
    const wrappedHandlers: PromptHandlers = {
      ...item.handlers,
      // Fired from here, from the one aggregator this session owns — nothing below needs
      // to know the handler exists, and two places firing it would be two folds.
      onRecord: undefined,
      onChunk: (chunk) => {
        chunks.push(chunk);
        item.handlers?.onChunk?.(chunk);
      },
      onResponseChunk: (chunk) => {
        response.append(chunk);
        item.handlers?.onResponseChunk?.(chunk);
      },
      onActivity: (event) => {
        const result = this.aggregator.apply(event);
        if (this.transcriptActivity || this.v2Transcript) {
          for (const record of result.emitted) this.writeActivity(record);
        }
        item.handlers?.onRecord?.(result);
        item.handlers?.onActivity?.(event);
      },
    };

    let closed: OperationMeteringRecord | null = null;
    let transcriptClosed = false;
    try {
      const res = await this.controller.prompt(item.text, wrappedHandlers, item.attachments);
      // Before the assistant msg: `msg` delimits a turn, so anything still open has to
      // land inside those fences.
      this.endTurn(item.handlers);
      if (!this._title && item.text.trim()) {
        this._title = item.text.trim().replace(/\s+/g, " ").slice(0, 60);
      }
      // A session may have been created lazily on first prompt (degraded has none).
      this.setInternalSessionId(this.controller.currentSessionId ?? this._internalSessionId);
      // Metering closes BEFORE local persistence. The provider has already been paid and
      // has already told us what it charged; letting a transcript or catalog write failure
      // send us down the catch path would discard usage we are holding and, in a strict
      // mode, block the session over a local disk problem.
      //
      // `closed` then guards the catch path. Closing twice would accrue the operation
      // twice and emit a second record for it — double-counting tokens and cost, which is
      // a worse failure than the one closing early prevents.
      const record = await this.closeOperation(operation, res.status, res.usage);
      closed = record;
      await this.persist();
      if (this.v2Transcript) {
        await this.drainV2Activity();
        await this.v2Transcript.appendEvent({
          kind: "message",
          operationId: item.turnId,
          role: "assistant",
          text: res.text,
          structured: { version: 1, messages: res.messages },
          stopReason: res.stopReason,
          status: res.status,
        });
        await this.finishV2Prompt(res.status, record);
        transcriptClosed = true;
      } else {
        await this.appendTranscript({
          v: 1,
          t: "msg",
          role: "assistant",
          text: res.text,
          messages: res.messages,
          ts: Date.now(),
          usage: res.usage,
          stopReason: res.stopReason,
          status: res.status,
        });
      }
      return Object.freeze({ ...res, operationId: item.turnId, metering: record });
    } catch (err) {
      // Easy to miss, and the whole point of R4: a turn that died mid-tool still records
      // what it was doing, at its real status.
      this.endTurn(item.handlers);
      const text = chunks.join("");
      const structured = response.snapshot();
      const messages = structured.length > 0
        ? structured
        : text
          ? Object.freeze([{ text }])
          : Object.freeze([]);
      if (this.v2Transcript) {
        await this.drainV2Activity().catch(() => undefined);
        if (!transcriptClosed) {
          await this.v2Transcript.appendEvent({
            kind: "message",
            operationId: item.turnId,
            role: "assistant",
            text,
            structured: { version: 1, messages },
            stopReason: "error",
            status: "error",
          }).catch(() => undefined);
        }
      } else {
        await this.appendTranscript({
          v: 1,
          t: "msg",
          role: "assistant",
          text,
          messages,
          ts: Date.now(),
          stopReason: "error",
          status: "error",
        });
      }
      // A failed operation may still have consumed tokens, so its record has to survive
      // the rejection rather than only reaching event subscribers.
      // Already metered: the failure happened after the operation closed (a transcript or
      // catalog write), so the record stands and must not be minted a second time.
      const record = closed ?? (await this.closeOperation(operation, "error", null, String(err)));
      if (this.v2Transcript && !transcriptClosed) {
        await this.finishV2Prompt("error", record, "unknown").catch(
          (persistenceError) => this.log.warn("transcript_terminal_write_failed", { error: String(persistenceError) }),
        );
      }
      throw new AgentSessionOperationError(item.turnId, record, err);
    }
  }

  private openMeteredOperation(item: PromptQueueItem): Promise<OpenOperation> {
    return this.metering.open({
      operationId: item.turnId,
      operationKind: item.operationKind,
      internalSessionId: this._internalSessionId,
      providerId: this.providerId,
      model: this.model,
      degraded: this.controller.isDegraded,
    });
  }

  private async finishV2Prompt(
    status: PromptResult["status"],
    record: OperationMeteringRecord,
    errorCode?: "unknown",
  ): Promise<void> {
    if (!this.v2Transcript || this.persistence === false) return;
    const observedAt = new Date().toISOString();
    await this.v2Transcript.appendEvent({
      kind: "metering_reference",
      operationId: record.operationId,
      meteringRecordId: record.operationId,
      status: record.usage.status === "metered" ? "available" : "unavailable",
    });
    await this.v2Transcript.finishOperation(
      status === "completed" ? "settled" : status === "cancelled" ? "cancelled" : "failed",
      {
        model: this.model,
        sessionConfiguration: snapshotSessionConfiguration({
          adapterId: this.adapterId,
          configOptions: this.controller.configOptions,
          policy: this.persistence.sessionConfiguration,
          restorationTargets: this.v2Transcript.checkpoint.sessionConfiguration.restorationTargets,
          observedAt,
        }),
        metering: this.metering.currentState,
      },
      errorCode,
    );
  }

  /**
   * Replace metering state after an out-of-band reconciliation, and clear any block.
   *
   * The recovery path for a strict mode that stopped on a metering failure, without the
   * unrecorded "assume zero" reset §12 rejects. Deliberately mints no operation record:
   * the adjustment is an accounting correction, not provider usage, and pretending
   * otherwise would put a fabricated operation in the consumer's ledger.
   */
  async reconcileMetering(reconciliation: MeteringReconciliation): Promise<{
    before: AgentSessionMeteringState;
    after: AgentSessionMeteringState;
  }> {
    if (this.isBusy || this.queue.length > 0) {
      throw new Error("reconcileMetering requires an idle session with no queued operations");
    }
    if (!reconciliation.reason?.trim()) {
      throw new Error("reconcileMetering requires a non-blank reason");
    }
    const restoration = restoreMeteringState(reconciliation.state, this.agentSessionId);
    if (restoration.status !== "restored") {
      throw new Error(
        `reconcileMetering state rejected: ${
          restoration.status === "ignored" ? restoration.reason : "no state supplied"
        }`,
      );
    }
    const wasBlocked = this.metering.blocked;
    if (this.v2Transcript) {
      // The replacement state is already fully validated above. Persist it first so a
      // successful return can never leave only the in-memory engine reconciled.
      await this.v2Transcript.publishCheckpoint({ metering: restoration.state });
    }
    // Validated first: state is replaced atomically or not at all.
    const { before } = this.metering.reconcile(restoration.state);
    const after = this.metering.currentState;
    this.emit({
      kind: "metering_reconciled",
      before,
      after,
      reason: reconciliation.reason,
      ...(reconciliation.reference ? { reference: reconciliation.reference } : {}),
      reconciledAt: Date.now(),
    });
    if (wasBlocked) this.emit({ kind: "metering_unblocked" });
    return { before, after };
  }

  /**
   * Run a library-internal prompt through the same metering primitive as a user prompt.
   *
   * Handoff summary generation and continuation seeding consume real tokens. Calling
   * `controller.prompt()` directly for them would spend a consumer's money invisibly, so
   * that path is not permitted any more (§16).
   *
   * Operation ids are deterministic children of the handoff id rather than freshly
   * minted, so a consumer can tie both halves back to the handoff that caused them.
   */
  private async meteredInternalPrompt(
    operationId: string,
    operationKind: MeteredOperationKind,
    text: string,
    records: OperationMeteringRecord[],
  ): Promise<PromptResult> {
    const operation = await this.metering.open({
      operationId,
      operationKind,
      internalSessionId: this._internalSessionId,
      providerId: this.providerId,
      model: this.model,
      degraded: this.controller.isDegraded,
    });
    let transcriptStarted = false;
    if (this.v2Transcript) {
      try {
        await this.v2Transcript.beginOperation(operationId, persistenceOperationKind(operationKind));
        transcriptStarted = true;
        await this.v2Transcript.appendEvent({
          kind: "message",
          operationId,
          role: "user",
          text,
        });
        await this.v2Transcript.syncBeforeDispatch();
      } catch (error) {
        if (transcriptStarted) {
          await this.v2Transcript.abortOperation("pre_dispatch_persistence_failure").catch(
            (abortError) => this.log.warn("transcript_predispatch_abort_failed", { error: String(abortError) }),
          );
        }
        throw error;
      }
    }
    let closed = false;
    let transcriptClosed = false;
    try {
      const result = await this.controller.prompt(text);
      const record = await this.closeOperation(operation, result.status, result.usage);
      records.push(record);
      closed = true;
      if (this.v2Transcript) {
        await this.v2Transcript.appendEvent({
          kind: "message",
          operationId,
          role: "assistant",
          text: result.text,
          structured: { version: 1, messages: result.messages },
          stopReason: result.stopReason,
          status: result.status,
        });
        await this.finishV2Prompt(result.status, record);
        transcriptClosed = true;
      }
      return result;
    } catch (err) {
      if (!closed) {
        const record = await this.closeOperation(operation, "error", null, String(err));
        records.push(record);
        closed = true;
      }
      if (this.v2Transcript && !transcriptClosed) {
        const record = records[records.length - 1]!;
        await this.v2Transcript.appendEvent({
          kind: "message",
          operationId,
          role: "assistant",
          text: "",
          structured: { version: 1, messages: [] },
          stopReason: "error",
          status: "error",
        }).catch(() => undefined);
        await this.finishV2Prompt("error", record, "unknown").catch(
          (persistenceError) => this.log.warn("transcript_terminal_write_failed", { error: String(persistenceError) }),
        );
      }
      throw err;
    }
  }

  private v2Descriptor(
    internalSessionId: string | null = this._internalSessionId,
    activatedAt?: string,
    mode: AgentMode = this._mode,
  ): InternalSessionDescriptor {
    if (!this.v2Transcript || this.persistence === false) {
      throw new Error("v2 descriptor requires transcript persistence");
    }
    const checkpoint = this.v2Transcript.checkpoint;
    const observedAt = activatedAt ?? new Date().toISOString();
    return {
      internalSessionId,
      adapterId: this.adapterId,
      mode,
      model: this.model,
      sessionConfiguration: internalSessionId === checkpoint.internalSessionId
        ? checkpoint.sessionConfiguration
        : snapshotSessionConfiguration({
            adapterId: this.adapterId,
            configOptions: this.controller.configOptions,
            policy: this.persistence.sessionConfiguration,
            observedAt,
          }),
      activatedAt: internalSessionId === checkpoint.internalSessionId
        ? checkpoint.internalSessionActivatedAt
        : internalSessionId
          ? observedAt
          : null,
      protocol: this.controller.isDegraded ? { name: "pty" } : { name: "acp", version: 1 },
    };
  }

  /**
   * Close a rating unit, emit its record, and surface a strict-mode block.
   *
   * `contextAfter`/`providerCostAfter` are the latest observations seen by completion.
   * ACP gives no ordering guarantee, so neither is asserted to describe THIS operation.
   */
  private async closeOperation(
    operation: OpenOperation,
    outcome: "completed" | "cancelled" | "error",
    reportedCumulative: TokenUsage | null,
    usageFailureReason?: string,
  ): Promise<OperationMeteringRecord> {
    const wasBlocked = this.metering.blocked;
    const record = await this.metering.close(operation, {
      outcome,
      reportedCumulative,
      ...(usageFailureReason ? { usageFailureReason } : {}),
      contextAfter: this._contextWindow,
      providerCostAfter: this._providerCost,
    });
    this.emit({ kind: "metering_recorded", record });
    if (!wasBlocked && this.metering.blocked) {
      this.emit({ kind: "metering_blocked", reason: this.metering.blockedReason ?? "unknown" });
    }
    return record;
  }

  // --- activity ----------------------------------------------------------------
  /**
   * Full state of the turn IN FLIGHT, for a subscriber that joins mid-turn: send these
   * records, then stream frames, discarding any whose `seq` is not greater than
   * `snapshot.seq`. Without that, a thinking delta already folded into the snapshot gets
   * applied twice. The threshold stays valid indefinitely — `seq` never restarts.
   *
   * Between turns this is `{ active: false, records: [] }`. A settled turn belongs to the
   * transcript, not to a replay: handing it to a client connecting mid-idle would put
   * activity in its log before the messages around it had loaded.
   */
  activitySnapshot(): ActivitySnapshot {
    return this.aggregator.snapshot();
  }

  private beginTurn(turnId: string): void {
    // A correct caller always gets an empty array back — both exit paths flush. If one
    // ever doesn't, keeping the records (loudly) beats dropping them.
    const leftover = this.aggregator.startTurn(turnId);
    if (leftover.length > 0) {
      this.log.warn("activity_turn_not_flushed", { records: leftover.length });
      if (this.transcriptActivity || this.v2Transcript) for (const record of leftover) this.writeActivity(record);
    }
  }

  private endTurn(handlers?: PromptHandlers): void {
    const emitted = this.aggregator.flush();
    if (emitted.length === 0) return;
    if (this.transcriptActivity || this.v2Transcript) for (const record of emitted) this.writeActivity(record);
    // Live subscribers need these too: without them, a tool call on a turn that was
    // cancelled or crashed spins forever in the UI. `wireFrames()` handles this shape.
    handlers?.onRecord?.({ current: null, delta: null, emitted });
  }

  /**
   * Namespace for the record ids the aggregator MINTS (`think-1`, `plan`, `usage`), which
   * are only unique within one turn — the transcript spans many, so unprefixed ids would
   * collapse under last-wins folding.
   *
   * Deliberately not a counter: a resumed session restarts an in-memory counter at 0 and
   * collides with ids already on disk. Timestamp keeps it ordered and restart-stable; the
   * random suffix covers two turns in the same millisecond.
   */
  private mintTurnId(): string {
    return this.mintOperationId();
  }

  private mintOperationId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  /**
   * Persist one settled record. Filtering lives here, not in the aggregator: the
   * aggregator owns semantics, the writer owns policy.
   *
   * Fire and forget — `appendTranscript` serializes writes in call order, so ordering
   * holds without blocking the agent's update stream on disk.
   */
  private writeActivity(record: AggregatedRecord): void {
    if (this.v2Transcript) {
      const operationId = this.v2Transcript.checkpoint.boundary.status === "in_flight"
        ? this.v2Transcript.checkpoint.boundary.interruptedOperationId
        : record.recordId.split(":", 1)[0] ?? record.recordId;
      this.v2ActivityWrite = this.v2ActivityWrite.then(async () => {
        await this.v2Transcript!.appendEvent(persistenceEventFromActivity(record, operationId));
      });
      return;
    }
    if (!this._transcriptPath) return;
    if (!this.activityKinds.has(record.event.kind)) return;
    void this.appendTranscript(this.toActivityLine(record));
  }

  private async drainV2Activity(): Promise<void> {
    await this.v2ActivityWrite;
  }

  private toActivityLine(record: AggregatedRecord): TranscriptActivityLine {
    let fields: Record<string, unknown> = { ...record.event };
    if (!this.activityRawOutput) delete fields.rawOutput;

    let truncated = false;
    if (this.activityMaxBytes != null) {
      const capped = capActivityStrings(fields, this.activityMaxBytes);
      fields = capped.fields;
      truncated = capped.truncated;
    }

    const line: TranscriptActivityLine = {
      ...fields,
      v: 1,
      t: "activity",
      ts: Date.now(),
      recordId: record.recordId,
      reason: record.reason,
      kind: record.event.kind,
    };
    if (truncated) line.truncated = true;
    return line;
  }

  interrupt(options?: InterruptOptions): void {
    if (options?.clearQueue) {
      const dropped = this.queue.splice(0);
      for (const item of dropped) {
        if (item.kind === "prompt") {
          // Cancelled before dispatch: nothing was sent, so nothing was consumed and no
          // metering record is minted (§16).
          item.resolve({
            text: "",
            messages: Object.freeze([]),
            stopReason: "cancelled",
            status: "cancelled",
            usage: null,
            operationId: item.turnId,
            metering: null,
          });
        } else {
          const label = item.kind === "handoff"
            ? "handoff"
            : item.kind === "set_config" || item.kind === "resolve_config"
              ? "configuration change"
              : item.kind === "resolve_recovery"
                ? "recovery resolution"
              : "mode change";
          item.reject(new Error(`${label} cancelled before it started`));
        }
      }
      this.emitStateIfChanged();
    }
    this.controller.interrupt(options);
  }

  async stop(): Promise<void> {
    if (this.phase === "stopped") return;
    // Stop is terminal for this stable object. Drop work that never started, interrupt the
    // active turn, and publish stopped before awaiting process teardown so a concurrent
    // prompt cannot slip into a controller that is going away.
    this.interrupt({ clearQueue: true });
    this.phase = "stopped";
    this.emitStateIfChanged();
    await this.controller.stop();
    await this.drainV2Activity().catch(() => undefined);
    await this.v2Transcript?.close();
  }

  // --- mode swap (catalog-affecting) -------------------------------------------
  async setMode(mode: AgentMode): Promise<ConnectResult> {
    if (this.phase === "stopped") throw new Error("AgentSession is stopped");
    this.assertPromptable();
    return await new Promise<ConnectResult>((resolve, reject) => {
      this.queue.push({
        kind: "set_mode",
        transitionId: this.mintOperationId(),
        mode,
        resolve,
        reject,
      });
      this.emitStateIfChanged();
      void this.pump();
    });
  }

  // --- thin proxies to the live connection -------------------------------------
  get capabilities(): Capabilities {
    return this.controller.capabilities;
  }
  get configOptions(): ConfigOptions {
    return this.controller.configOptions;
  }
  /**
   * Set one of the agent's own session options — the `configOptions` it advertised on
   * connect. This is where per-agent knobs live that are NOT launch flags and NOT
   * environment: Codex exposes `reasoning_effort` (low…ultra), `model`, and `mode` this
   * way, so it is the only route to them once the process is running.
   */
  setConfig(configId: string, value: unknown): Promise<void> {
    if (this.phase === "stopped") return Promise.reject(new Error("AgentSession is stopped"));
    try {
      this.assertPromptable();
    } catch (error) {
      return Promise.reject(error);
    }
    let ownedValue: unknown;
    try {
      ownedValue = structuredClone(value);
    } catch (error) {
      return Promise.reject(new Error(`configuration value cannot be cloned: ${String(error)}`));
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        kind: "set_config",
        operationId: this.mintOperationId(),
        configId,
        value: ownedValue,
        resolve,
        reject,
      });
      this.emitStateIfChanged();
      void this.pump();
    });
  }
  resolveConfigurationMismatch(
    resolution: ConfigurationMismatchResolution,
  ): Promise<ConfigurationMismatchResolutionResult> {
    if (this.phase === "stopped") return Promise.reject(new Error("AgentSession is stopped"));
    let owned: ConfigurationMismatchResolution;
    try {
      owned = resolution.strategy === "accept_effective"
        ? Object.freeze({ strategy: "accept_effective" })
        : Object.freeze({
            strategy: "replace_restoration_targets",
            selections: Object.freeze(resolution.selections.map((selection) => Object.freeze({
              configId: selection.configId,
              value: structuredClone(selection.value),
            }))),
          });
    } catch (error) {
      return Promise.reject(new Error(`configuration resolution cannot be cloned: ${String(error)}`));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ kind: "resolve_config", resolution: owned, resolve, reject });
      this.emitStateIfChanged();
      void this.pump();
    });
  }
  resolveRecovery(
    resolution: AgentSessionRecoveryResolution,
  ): Promise<AgentSessionRecoveryResolutionResult> {
    if (this.phase === "stopped") return Promise.reject(new Error("AgentSession is stopped"));
    if (this._recovery.kind !== "uncertain") {
      return Promise.reject(new Error("recovery resolution requires an uncertain session"));
    }
    if (resolution.strategy === "start_new_internal_session"
      && resolution.continuation !== undefined
      && !resolution.continuation.trim()) {
      return Promise.reject(new Error("recovery continuation cannot be blank"));
    }
    const owned: AgentSessionRecoveryResolution = resolution.strategy === "accept_harness_state"
      ? Object.freeze({ strategy: resolution.strategy })
      : Object.freeze({
          strategy: resolution.strategy,
          ...(resolution.continuation === undefined ? {} : { continuation: resolution.continuation }),
        });
    return new Promise((resolve, reject) => {
      this.queue.push({ kind: "resolve_recovery", resolution: owned, resolve, reject });
      this.emitStateIfChanged();
      void this.pump();
    });
  }
  /** Immutable snapshot of commands advertised by the active ACP harness. */
  get internalSessionCommands(): readonly InternalSessionCommand[] {
    return this.controller.availableCommands;
  }
  get isDegraded(): boolean {
    return this.controller.isDegraded;
  }
  bridge(options?: BridgeOptions): Promise<void> {
    return this.controller.bridge(options);
  }
  authenticate(
    methodId: string,
    handlers?: { onOutput?: (line: string) => void },
  ): Promise<unknown> {
    return this.controller.authenticate(methodId, handlers);
  }

  // --- sessions (merged catalog + live) ----------------------------------------
  /** The merged session list: our catalog ∪ the agent's live list (ACP mode). */
  async listSessions(): Promise<MergedSession[]> {
    let agentEntries: SessionListEntry[] = [];
    if (
      !this.controller.isDegraded &&
      this.controller.capabilities.agent.sessionCapabilities.list
    ) {
      try {
        agentEntries = (await this.controller.listSessions()).sessions;
      } catch {
        /* agent list broken/empty — fall back to catalog only */
      }
    }
    if (this.sessions) return this.sessions.listMerged(agentEntries, this.adapterId);
    return agentEntries.map((e) => ({
      agentSessionId: e.sessionId,
      internalSessionId: e.sessionId,
      adapter: this.adapterId,
      cwd: e.cwd,
      title: e.title,
      updatedAt: e.updatedAt,
      source: "agent" as const,
    }));
  }

  private async persist(): Promise<void> {
    if (!this.sessions) return;
    await this.sessions.record({
      agentSessionId: this.agentSessionId,
      internalSessionId: this._internalSessionId,
      adapter: this.adapterId,
      mode: this._mode,
      cwd: this._cwd,
      title: this._title,
      transcriptPath: this._transcriptPath,
    });
  }

  private async appendTranscript(line: TranscriptLine): Promise<void> {
    if (!this._transcriptPath) return;
    this.transcriptWrite = this.transcriptWrite
      .catch(() => {})
      .then(async () => {
        try {
          await appendTranscriptLine(this._transcriptPath!, line);
        } catch (err) {
          this.log.warn("transcript_write_failed", {
            path: this._transcriptPath,
            error: String(err),
          });
        }
      });
    await this.transcriptWrite;
  }

  /**
   * Replace the active provider thread id, resetting observations that belong to it.
   *
   * Every reassignment goes through here so the reset cannot be forgotten at one of the
   * several sites that swap threads (handoff, mode swap, load/resume, lazy creation).
   * Carrying a stale context window across a thread change would misreport the new
   * thread's occupancy as the old thread's.
   */
  private setInternalSessionId(next: string | null, created = true): void {
    if (next === this._internalSessionId) return;
    this._internalSessionId = next;
    // The new thread's counters restart, so the old baseline no longer describes them.
    this.metering.onThreadReplaced(next, created);
    if (this._contextWindow !== null) {
      this._contextWindow = null;
      this.emit({ kind: "context_window_changed", contextWindow: null });
    }
    if (this._providerCost !== null) {
      this._providerCost = null;
      this.emit({ kind: "provider_cost_changed", providerCost: null });
    }
    const pending = this.pendingUsageUpdate;
    this.pendingUsageUpdate = null;
    // An update buffered before the thread was named belongs to it only if it named the
    // same thread, or named none at all.
    if (pending && next && (!pending.sessionId || pending.sessionId === next)) {
      this.applyUsageUpdate(pending.update, pending.sessionId);
    }
  }

  /**
   * Apply a raw ACP `usage_update`.
   *
   * Updates naming a different provider thread are ignored: ACP gives no ordering
   * guarantee, so a late notification from a replaced thread can arrive after the swap and
   * must not overwrite current state.
   */
  private applyUsageUpdate(update: unknown, sessionId: string | null): void {
    const active = this._internalSessionId;
    if (!active) {
      this.pendingUsageUpdate = { update, sessionId };
      return;
    }
    if (sessionId && sessionId !== active) return;

    const observedAt = Date.now();
    const context = parseContextWindow(update, active, observedAt);
    if (context && contextWindowChanged(this._contextWindow, context)) {
      this._contextWindow = context;
      this.emit({ kind: "context_window_changed", contextWindow: context });
    }

    const cost = parseProviderCost(update);
    if (cost.kind === "invalid") {
      // Provider cost is optional telemetry: malformed data is dropped with a diagnostic
      // and never implicitly clears a previously valid value.
      this.log.warn("provider_cost_invalid", { reason: cost.reason });
      return;
    }
    if (cost.kind === "unchanged") return;
    const next: ProviderCostSnapshot | null =
      cost.kind === "cleared"
        ? null
        : Object.freeze({ internalSessionId: active, cumulative: cost.cumulative, observedAt });
    if (providerCostChanged(this._providerCost, next)) {
      this._providerCost = next;
      this.emit({ kind: "provider_cost_changed", providerCost: next });
    }
  }

  /** Emit only when a field in the public snapshot changed. */
  private emitStateIfChanged(): void {
    const state = this.state;
    const key = [
      state.phase,
      state.queuedOperationCount,
      state.internalSessionId ?? "",
      state.adapterId,
      state.mode,
      state.promptability.promptable ? "promptable" : state.promptability.blockers.join(","),
    ].join("\u0000");
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    this.emit({ kind: "state_changed", state });
  }

  private assertPromptable(): void {
    const promptability = this.promptability;
    if (!promptability.promptable) {
      throw new AgentSessionPromptBlockedError(promptability.blockers);
    }
  }

  /** Listener failures are observation failures, never session-operation failures. */
  private emit(event: AgentSessionEvent): void {
    const notification: AgentSessionNotification = Object.freeze({
      seq: ++this.notificationSeq,
      ts: Date.now(),
      agentSessionId: this.agentSessionId,
      event: Object.freeze(event),
    });
    for (const listener of [...this.listeners]) {
      try {
        listener(notification);
      } catch (err) {
        this.log.warn("agent_session_listener_failed", {
          kind: event.kind,
          error: String(err),
        });
      }
    }
  }
}

function persistenceOperationKind(kind: MeteredOperationKind): OperationKind {
  return kind === "internal_command" ? "internal_session_command" : kind;
}

function continuationReport(
  checkpoint: AgentSessionCheckpoint,
  requestedAdapterId: string,
  transcript: PersistenceStateRuntime,
  recordedThreadAvailability: ContinuationReport["recordedThreadAvailability"],
  attempts: readonly ContinuationAttempt[],
  outcome: ContinuationReport["outcome"],
): ContinuationReport {
  return Object.freeze({
    recordedAdapterId: checkpoint.adapterId,
    recordedInternalSessionId: checkpoint.internalSessionId,
    requestedAdapterId,
    recordedConversationAvailability: transcript.conversationAvailability,
    recordedThreadAvailability,
    attempts: Object.freeze(attempts.map((attempt) => Object.freeze({ ...attempt }))),
    outcome: Object.freeze({ ...outcome }),
  });
}

function descriptorFromCheckpoint(checkpoint: AgentSessionCheckpoint): InternalSessionDescriptor {
  return {
    internalSessionId: checkpoint.internalSessionId,
    adapterId: checkpoint.adapterId,
    mode: checkpoint.mode,
    model: checkpoint.model,
    sessionConfiguration: checkpoint.sessionConfiguration,
    activatedAt: checkpoint.internalSessionActivatedAt,
    protocol: checkpoint.protocol,
  };
}

function isReconstructionStrategy(strategy: ContinuationStrategy): boolean {
  return strategy.kind === "new_from_transcript" || strategy.kind === "new_from_consumer_continuation";
}

function normalizeContinuationStrategies(
  options: OpenContinuationOptions | undefined,
): readonly ContinuationStrategy[] {
  const strategies = options?.strategies ?? [{ kind: "load_internal_session" as const }];
  if (strategies.length === 0) throw new Error("continuation.strategies cannot be empty");
  return Object.freeze(strategies.map((strategy): ContinuationStrategy => {
    if (strategy.kind === "load_internal_session") {
      return Object.freeze({ kind: strategy.kind });
    }
    if (strategy.kind === "new_from_transcript") {
      if (!strategy.strategyId.trim()) throw new Error("transcript continuation strategyId cannot be blank");
      if (typeof strategy.buildContinuation !== "function") {
        throw new Error("transcript continuation strategy requires buildContinuation");
      }
      return Object.freeze({
        kind: strategy.kind,
        strategyId: strategy.strategyId,
        buildContinuation: strategy.buildContinuation,
      });
    }
    if (!strategy.continuationId.trim()) throw new Error("consumer continuationId cannot be blank");
    if (!strategy.continuation.trim()) throw new Error("consumer continuation cannot be blank");
    return Object.freeze({
      kind: strategy.kind,
      continuationId: strategy.continuationId,
      continuation: strategy.continuation,
    });
  }));
}

function configurationTargetIssue(
  option: ConfigOption | undefined,
  target: PersistedSessionConfigSelection,
): string | null {
  if (!option) return "configuration_option_missing";
  if (target.type !== "unknown" && option.type !== target.type) return "configuration_type_changed";
  if (option.type === "boolean" && typeof target.value !== "boolean") return "configuration_value_invalid";
  if (option.type === "select" && !(option.allowedValues ?? []).some(
    (choice) => sameJsonValue(choice.value, target.value),
  )) return "configuration_value_no_longer_allowed";
  return null;
}

function validateReplacementSelections(
  selections: readonly { readonly configId: string; readonly value: JsonValue }[],
  options: ConfigOptions,
): void {
  if (selections.length === 0) throw new Error("replacement restoration targets cannot be empty");
  const ids = new Set<string>();
  for (const selection of selections) {
    if (!selection.configId.trim()) throw new Error("replacement configId cannot be blank");
    if (ids.has(selection.configId)) {
      throw new Error(`duplicate replacement configId: ${selection.configId}`);
    }
    ids.add(selection.configId);
    canonicalizeJson(selection.value);
    const option = options.get(selection.configId);
    if (!option) throw new Error(`configuration option is not announced: ${selection.configId}`);
    const issue = configurationTargetIssue(option, {
      configId: selection.configId,
      type: option.type,
      value: selection.value,
      ordinal: 0,
      source: "explicit_selection",
      recordedAt: new Date(0).toISOString(),
    });
    if (issue) throw new Error(`${issue}: ${selection.configId}`);
  }
}

function sameJsonValue(left: unknown, right: JsonValue): boolean {
  try {
    return canonicalizeJson(left) === canonicalizeJson(right);
  } catch {
    return false;
  }
}

/** Do not let one notification observer mutate the PromptResult another observer sees. */
function copyPromptResult(result: PromptResult): PromptResult {
  const messages = result.messages ?? (result.text ? [{ text: result.text }] : []);
  return Object.freeze({
    ...result,
    messages: Object.freeze(
      messages.map((message) => Object.freeze({ ...message })),
    ),
    usage: result.usage ? Object.freeze({ ...result.usage }) : null,
  });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Cap the fields that can realistically reach megabytes — terminal output, text content,
 * diffs, and a stringified `rawInput` — one field at a time so the JSON structure survives.
 * An oversized `rawInput` object becomes its truncated serialization, which is lossy by
 * design; `truncated: true` on the line says so.
 */
function capActivityStrings(
  fields: Record<string, unknown>,
  maxBytes: number,
): { fields: Record<string, unknown>; truncated: boolean } {
  let truncated = false;
  const cap = (text: string): string => {
    const bytes = encoder.encode(text);
    if (bytes.length <= maxBytes) return text;
    // Back up off a continuation byte (0b10xxxxxx) so a multi-byte character is never
    // split — decoding a partial sequence would yield U+FFFD.
    let end = maxBytes;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    truncated = true;
    return `${decoder.decode(bytes.subarray(0, end))}… [truncated ${bytes.length - end} bytes]`;
  };
  const capUnknown = (value: unknown): unknown => {
    if (typeof value === "string") return cap(value);
    const text = JSON.stringify(value) ?? "";
    const capped = cap(text);
    return capped === text ? value : capped;
  };

  const out = { ...fields };
  if (out.rawInput !== undefined) out.rawInput = capUnknown(out.rawInput);
  if (out.rawOutput !== undefined) out.rawOutput = capUnknown(out.rawOutput);
  if (typeof out.text === "string") out.text = cap(out.text);
  if (Array.isArray(out.content)) {
    out.content = (out.content as unknown[]).map((entry) => {
      if (entry === null || typeof entry !== "object") return entry;
      const item = { ...(entry as Record<string, unknown>) };
      if (typeof item.text === "string") item.text = cap(item.text);
      if (typeof item.output === "string") item.output = cap(item.output);
      if (typeof item.oldText === "string") item.oldText = cap(item.oldText);
      if (typeof item.newText === "string") item.newText = cap(item.newText);
      // `text` on a content entry is our convenience copy; the block itself still holds it.
      if (item.content !== null && typeof item.content === "object") {
        const block = { ...(item.content as Record<string, unknown>) };
        if (typeof block.text === "string") block.text = cap(block.text);
        item.content = block;
      }
      return item;
    });
  }
  return { fields: out, truncated };
}
