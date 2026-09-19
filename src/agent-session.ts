// AgentConversation — one durable conversation and the library's compatibility front
// face. Existing consumers still import this constructor as `AgentSession`; both names
// refer to the same class while the new agent-level owner is introduced.
//
// It owns identity (our `agentSessionId`, adapter, mode, internalSessionId, title) and persistence, and
// HOLDS an AgentController for the live connection (the control plane). It implements
// AgentClient, so the REPL and any caller can prompt it directly.
//
// Adapter ownership remains here during the compatibility tranche. The later Agent owner
// supplies the adapter registry used by cross-adapter conversation transitions.

import {
  AgentController,
  type AgentControllerConfig,
  type AgentControllerStartEvent,
  type AgentMode,
} from "./controller.ts";
import type * as schema from "@agentclientprotocol/sdk";
import { join } from "node:path";
import type { ActivitySnapshot, AggregatedRecord } from "./activity.ts";
import type { Adapter } from "./adapters.ts";
import {
  createAgentConversationId,
  isAgentConversationId,
  isAgentSessionId,
  type AgentConversationId,
  type AgentSessionId,
} from "./agent-ids.ts";
import type {
  NewConversationRecord,
  ParticipantRef,
  PersistenceJsonValue,
} from "./persistence/backend.ts";
import type { AgentConversationOwnerLifecycle } from "./agent-conversation-owner.ts";
import type { AgentClient, Bridgeable, BridgeOptions, InterruptOptions } from "./agent-client.ts";
import type { Capabilities } from "./capabilities.ts";
import type { ConfigOption, ConfigOptions } from "./config-options.ts";
import type { ConnectResult } from "./client.ts";
import { noopLogger, type Logger } from "./logger.ts";
import { formatResponseMessages, ResponseAccumulator } from "./response.ts";
import { MeteringEngine, type OpenDetachedOperation, type OpenOperation } from "./metering/engine.ts";
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
  type TranscriptLine,
} from "./transcript.ts";
import type {
  ActivityEvent,
  InternalSessionCommand,
  Attachment,
  PromptHandlers,
  PromptResult,
  PermissionOutcome,
  PermissionRequest,
  ResponseMessage,
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
import {
  RegistryPersistenceRuntime,
  type PersistenceStateRuntime,
} from "./persistence/state-runtime.ts";
import { AuditPersistenceRuntime, AuditedPersistenceRuntime, type AuditLogIdentity } from "./persistence/audit-runtime.ts";
import { TranscriptReader } from "./persistence/transcript-reader.ts";
import {
  snapshotSessionConfiguration,
  snapshotSessionConfigurationAfterSelection,
  snapshotAcceptedEffectiveConfiguration,
} from "./persistence/configuration-state.ts";
import {
  canonicalizeJson,
  sha256CanonicalJson,
  type PersistedMachineCode,
} from "./persistence/integrity.ts";
import type { PersistenceRepair, SessionRecoveryStatus } from "./persistence/reducer.ts";
import type { StagedContinuationState } from "./persistence/registry.ts";
import type { SessionLogWriterLock } from "./persistence/session-log-writer.ts";
import type { ManagedOpenProgressReporter } from "./persistence/managed-open-progress.ts";
import {
  AdapterMismatchError,
  AgentSessionPromptBlockedError,
  ContinuationUnavailableError,
  DirectAuditPersistenceUnsupportedError,
} from "./agent-conversation-errors.ts";
import type {
  AgentSessionEvent,
  AgentSessionListener,
  AgentSessionNotification,
  AgentSessionPhase,
  AgentSessionPromptResult,
  AgentSessionPromptability,
  AgentSessionRecoveryResolution,
  AgentSessionRecoveryResolutionResult,
  AgentSessionState,
  ConfigurationMismatchResolution,
  ConfigurationMismatchResolutionResult,
  ConfigurationRestoreStatus,
  ContinuationAttempt,
  ContinuationReport,
  ContinuationStrategy,
  HandoffOptions,
  HandoffResult,
  OpenContinuationOptions,
  PromptBlocker,
  ProviderSession,
  TranscriptActivityConfig,
  TranscriptContinuationBuilder,
  TranscriptContinuationBuilderContext,
} from "./agent-conversation-contracts.ts";
import { AgentConversationQueue } from "./agent-conversation-queue.ts";
import { AgentConversationPresentation } from "./agent-conversation-presentation.ts";
import {
  HANDOFF_SUMMARY_PROMPT,
  buildContinuationPrompt,
  createContinuationReport,
  descriptorFromCheckpoint,
  isReconstructionStrategy,
  normalizeContinuationStrategies,
  stageOpeningContinuation,
} from "./agent-conversation-continuation.ts";

export {
  AdapterMismatchError,
  AgentSessionPromptBlockedError,
  ContinuationUnavailableError,
  DirectAuditPersistenceUnsupportedError,
} from "./agent-conversation-errors.ts";
export type {
  AgentConversationEvent,
  AgentConversationListener,
  AgentConversationNotification,
  AgentConversationPhase,
  AgentConversationPromptResult,
  AgentConversationPromptability,
  AgentConversationRecoveryResolution,
  AgentConversationRecoveryResolutionResult,
  AgentConversationState,
  AgentSessionEvent,
  AgentSessionListener,
  AgentSessionNotification,
  AgentSessionPhase,
  AgentSessionPromptResult,
  AgentSessionPromptability,
  AgentSessionRecoveryResolution,
  AgentSessionRecoveryResolutionResult,
  AgentSessionState,
  ConfigurationMismatchResolution,
  ConfigurationMismatchResolutionResult,
  ConfigurationRestoreStatus,
  ContinuationAttempt,
  ContinuationReport,
  ContinuationStrategy,
  HandoffOptions,
  HandoffResult,
  OpenContinuationOptions,
  PromptBlocker,
  ProviderSession,
  TranscriptActivityConfig,
  TranscriptContinuationBuilder,
  TranscriptContinuationBuilderContext,
} from "./agent-conversation-contracts.ts";

interface PromptQueueItem {
  kind: "prompt";
  turnId: string;
  /** How this operation is classified in its metering record. */
  operationKind: MeteredOperationKind;
  text: string;
  participantId?: string;
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

export interface AgentSessionOpenResult {
  readonly session: AgentConversation;
  readonly continuation: ContinuationReport;
  readonly recovery: SessionRecoveryStatus;
  readonly configuration: ConfigurationRestoreStatus;
  readonly promptability: AgentSessionPromptability;
  readonly repairs: readonly PersistenceRepair[];
}

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

interface AgentSessionOpenBootstrap {
  readonly transcript: PersistenceStateRuntime;
  readonly transcriptPath: string;
  readonly stageContinuation?: (state: StagedContinuationState) => Promise<StagedContinuationState>;
  readonly onOpenProgress?: ManagedOpenProgressReporter;
}

/** @internal Transaction hooks supplied only by SessionManager managed creation. */
export interface ManagedAgentSessionCreationBootstrap {
  readonly requestDigest: string;
  readonly transcriptLock?: SessionLogWriterLock;
  readonly auditLogLock?: SessionLogWriterLock;
  readonly stageContinuation: (state: StagedContinuationState) => Promise<StagedContinuationState>;
  readonly onOpenProgress?: ManagedOpenProgressReporter;
}

export interface ManagedAgentSessionPersistenceSnapshot {
  readonly checkpoint: AgentSessionCheckpoint;
  readonly internalSessionHistory: readonly InternalSessionHistoryEntry[];
  readonly auditLog: AuditLogIdentity | null;
}

export class AgentConversation implements AgentClient, Bridgeable {
  /** Compatibility logical id — decoupled from the ACP/harness session id. */
  readonly agentSessionId: string;
  readonly agentConversationId: AgentConversationId;
  readonly ownerAgentSessionId: AgentSessionId | null;
  private _adapterId: string;
  private activeAdapter: Adapter;

  private controller: AgentController;
  private readonly controllerDefaults: Omit<
    AgentControllerConfig,
    "adapter" | "adapterId" | "mode" | "sessionId" | "sessionLoadFailure"
  >;
  private detachControllerCommands: (() => void) | null = null;
  private detachControllerUsage: (() => void) | null = null;
  private readonly sessions?: SessionManager;
  private readonly _transcriptPath?: string;
  private readonly persistence: false | ResolvedAgentSessionPersistence;
  private readonly creationId: string;
  private v2Transcript: PersistenceStateRuntime | null = null;
  private v2TranscriptPath: string | null = null;
  private readonly presentation: AgentConversationPresentation;
  private readonly log: Logger;
  private transcriptWrite: Promise<void> = Promise.resolve();
  private readonly operations = new AgentConversationQueue<QueueItem>();
  private phase: AgentSessionPhase = "idle";
  private notificationSeq = 0;
  private readonly listeners = new Set<AgentSessionListener>();
  private lastStateKey = "";
  private _internalSessionId: string | null;
  private ownerContextNonce: string | null = null;
  private metering: MeteringEngine;
  private readonly meteringConfig: MeteringConfig;
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
  private managedAuditLog: AuditLogIdentity | null = null;
  private readonly managedOpenProgress?: ManagedOpenProgressReporter;
  private managedInitializationReported = false;
  private readonly ownerLifecycle?: AgentConversationOwnerLifecycle;
  private _participants: ParticipantRef[];
  private ownerRecordWrite: Promise<void> = Promise.resolve();
  private readonly defaultPermission: "approve" | "cancel";

  private constructor(
    config: AgentSessionConfig,
    openBootstrap: AgentSessionOpenBootstrap | null = null,
    managedCreation: ManagedAgentSessionCreationBootstrap | null = null,
    managedOpenProgress?: ManagedOpenProgressReporter,
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
    if (config.agentConversationId !== undefined && !isAgentConversationId(config.agentConversationId)) {
      throw new Error(`invalid agent conversation id: ${config.agentConversationId}`);
    }
    if (config.ownerAgentSessionId !== undefined && !isAgentSessionId(config.ownerAgentSessionId)) {
      throw new Error(`invalid owner agent session id: ${config.ownerAgentSessionId}`);
    }
    if (config.ownerAgentSessionId !== undefined && config.agentSessionId !== config.ownerAgentSessionId) {
      throw new Error("owned AgentConversation agentSessionId must equal ownerAgentSessionId");
    }
    this.agentConversationId = config.agentConversationId ?? createAgentConversationId();
    this.ownerAgentSessionId = config.ownerAgentSessionId
      ?? (isAgentSessionId(this.agentSessionId) ? this.agentSessionId : null);
    this.ownerLifecycle = config.ownerLifecycle;
    this.defaultPermission = config.defaultPermission ?? "cancel";
    this._participants = (config.participants ?? []).map((participant) => Object.freeze({ ...participant }));
    this._adapterId = config.adapterId;
    this.activeAdapter = config.adapter;
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
    this.managedOpenProgress = managedOpenProgress
      ?? managedCreation?.onOpenProgress
      ?? openBootstrap?.onOpenProgress;
    this._transcriptPath =
      config.transcriptPath ??
      (config.transcriptDir
        ? join(config.transcriptDir, `${encodeURIComponent(this.agentSessionId)}.jsonl`)
        : undefined);
    this.log = config.logger ?? noopLogger;
    this.presentation = new AgentConversationPresentation({
      activity: config.transcriptActivity,
      logger: this.log,
      persistence: () => this.v2Transcript,
      ...(this._transcriptPath
        ? { appendLegacyActivity: (line) => this.appendTranscript(line) }
        : {}),
      onPresentation: (item) => this.emit({ kind: "presentation_recorded", item }),
    });
    this._mode = config.mode ?? "normal";
    this._cwd = config.cwd;
    this._title = config.title;
    this._internalSessionId = requestedInternalSessionId ?? null;
    this.meteringConfig = Object.freeze({ ...(config.metering ?? {}) });
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
    this.controllerDefaults = {
      launcher: config.launcher,
      execPrefix: config.execPrefix,
      env: config.env,
      cwd: config.cwd,
      mcpServers: config.mcpServers,
      defaultPermission: config.defaultPermission,
      clientInfo: config.clientInfo,
      clientCapabilities: config.clientCapabilities,
      clientHandlers: config.clientHandlers,
      logger: config.logger,
      ...(config.wire || this.ownerLifecycle
        ? {
            wire: (entry: WireEntry) => {
              config.wire?.(entry);
              this.queueProtocolRecord(entry);
            },
          }
        : {}),
    };
    this.controller = this.createController(config.adapter, config.adapterId, this._mode, {
      sessionId: requestedInternalSessionId,
      sessionLoadFailure: providerSession.kind === "load"
        ? providerSession.onFailure ?? "error"
        : undefined,
    });
    this.bindController(this.controller);
  }

  private createController(
    adapter: Adapter,
    adapterId: string,
    mode: AgentMode,
    startup: Pick<AgentControllerConfig, "sessionId" | "sessionLoadFailure"> = {},
  ): AgentController {
    return new AgentController({
      ...this.controllerDefaults,
      adapter,
      adapterId,
      mode,
      ...startup,
    });
  }

  private bindController(controller: AgentController): void {
    this.detachControllerCommands?.();
    this.detachControllerUsage?.();
    this.detachControllerCommands = controller.subscribeAvailableCommands((commands) => {
      if (this.controller === controller) {
        this.emit({ kind: "internal_session_commands_changed", commands });
      }
    });
    this.detachControllerUsage = controller.subscribeUsageUpdate((update, sessionId) => {
      if (this.controller === controller) this.applyUsageUpdate(update, sessionId);
    });
  }

  private queueOwnedRecord(record: NewConversationRecord): void {
    if (!this.ownerLifecycle?.record) return;
    this.ownerRecordWrite = this.ownerRecordWrite
      .then(() => this.ownerLifecycle!.record!(record))
      .catch((error) => {
        this.markManagedPersistenceUnhealthy();
        throw error;
      });
  }

  private async recordOwned(record: NewConversationRecord): Promise<void> {
    if (!this.ownerLifecycle?.record) return;
    const write = this.ownerRecordWrite
      .then(() => this.ownerLifecycle!.record!(record))
      .catch((error) => {
        this.markManagedPersistenceUnhealthy();
        throw error;
      });
    this.ownerRecordWrite = write;
    await write;
  }

  private markManagedPersistenceUnhealthy(): void {
    if (!this.managedPersistenceHealthy) return;
    this.managedPersistenceHealthy = false;
    this.emitStateIfChanged();
  }

  private queueProtocolRecord(entry: WireEntry): void {
    if (!this.ownerAgentSessionId || !this.ownerLifecycle?.record) return;
    let message: PersistenceJsonValue;
    try {
      message = JSON.parse(entry.line) as PersistenceJsonValue;
    } catch {
      message = entry.line;
    }
    this.queueOwnedRecord({
      recordId: `protocol-${crypto.randomUUID()}`,
      agentSessionId: this.ownerAgentSessionId,
      agentConversationId: this.agentConversationId,
      kind: "protocol",
      timestamp: new Date(entry.ts).toISOString(),
      direction: entry.dir === "err" ? "error" : entry.dir,
      ...(protocolMethod(message) ? { method: protocolMethod(message)! } : {}),
      message,
    });
  }

  private queueActivityRecords(turnId: string, records: readonly AggregatedRecord[]): void {
    if (!this.ownerAgentSessionId) return;
    for (const record of records) {
      const runtimeRecord = runtimeRecordFromActivity(
        this.ownerAgentSessionId,
        this.agentConversationId,
        turnId,
        record,
      );
      if (runtimeRecord) this.queueOwnedRecord(runtimeRecord);
    }
  }

  private async recordNativeAction(
    transitionId: string,
    action: string,
    state: "started" | "checkpoint" | "completed" | "failed",
    details: { readonly input?: unknown; readonly output?: unknown; readonly error?: string } = {},
  ): Promise<void> {
    if (!this.ownerAgentSessionId) return;
    await this.recordOwned({
      recordId: `${transitionId}:native:${state}:${crypto.randomUUID()}`,
      agentSessionId: this.ownerAgentSessionId,
      agentConversationId: this.agentConversationId,
      kind: "native_action",
      timestamp: new Date().toISOString(),
      action,
      transitionId,
      state,
      ...(details.input === undefined ? {} : { input: toPersistenceJsonValue(details.input) }),
      ...(details.output === undefined ? {} : { output: toPersistenceJsonValue(details.output) }),
      ...(details.error === undefined ? {} : { error: details.error }),
    });
  }

  private reportManagedControllerProgress(event: AgentControllerStartEvent): void {
    if (!this.managedOpenProgress) return;
    // A continuation policy may restart the same adapter after a failed load. The
    // managed lifecycle reports capability discovery once, while the successful
    // provider-thread acquisition is reported when it actually occurs.
    if (event.stage === "initialized") {
      if (this.managedInitializationReported) return;
      this.managedInitializationReported = true;
    }
    this.managedOpenProgress(event);
  }

  /**
   * Open a logical conversation. `agentSessionId` selects stable identity;
   * `providerSession` independently selects a new or existing provider thread; transcript
   * options independently select history storage. No catalog or transcript is read
   * implicitly. Consumers compose a catalog record back into this method when reopening.
   */
  static async create(config: AgentSessionConfig): Promise<AgentConversation> {
    const directPersistence = resolveDirectPersistence(config.persistence);
    if (directPersistence !== false && directPersistence.auditLog !== false) {
      throw new DirectAuditPersistenceUnsupportedError();
    }
    const session = new AgentConversation(config);
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
  ): Promise<AgentConversation> {
    let session: AgentConversation;
    try {
      session = new AgentConversation(config, null, bootstrap);
    } catch (error) {
      await bootstrap.transcriptLock?.release().catch(() => undefined);
      await bootstrap.auditLogLock?.release().catch(() => undefined);
      throw error;
    }
    try {
      await session.start();
      return session;
    } catch (error) {
      await session.stop().catch(() => undefined);
      await bootstrap.transcriptLock?.release().catch(() => undefined);
      await bootstrap.auditLogLock?.release().catch(() => undefined);
      throw error;
    }
  }

  /** Restore one logical session by loading the exact provider thread in transcript authority. */
  static async open(config: AgentSessionOpenConfig): Promise<AgentSessionOpenResult> {
    return await AgentConversation.openWithLock(config);
  }

  /** @internal Managed open after maintenance acquired the artifact lock. */
  static async openManaged(
    config: AgentSessionOpenConfig,
    transcriptLock?: SessionLogWriterLock,
    audit?: AuditPersistenceRuntime,
    stageContinuation?: (state: StagedContinuationState) => Promise<StagedContinuationState>,
    onOpenProgress?: ManagedOpenProgressReporter,
  ): Promise<AgentSessionOpenResult> {
    return await AgentConversation.openWithLock(
      config,
      transcriptLock,
      audit,
      stageContinuation,
      onOpenProgress,
    );
  }

  /** @internal Restore a registry-authoritative session without a transcript reader. */
  static async openManagedRegistry(
    config: AgentSessionOpenConfig,
    history: readonly InternalSessionHistoryEntry[],
    audit?: AuditPersistenceRuntime,
    stageContinuation?: (state: StagedContinuationState) => Promise<StagedContinuationState>,
    onOpenProgress?: ManagedOpenProgressReporter,
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
    const session = new AgentConversation({
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
    }, null, null, onOpenProgress);
    const primary = new RegistryPersistenceRuntime(checkpoint, history);
    session.v2Transcript = audit ? new AuditedPersistenceRuntime(primary, audit) : primary;
    session.managedAuditLog = audit?.identity ?? null;
    try {
      const result = await session.controller.start((event) => session.reportManagedControllerProgress(event));
      if (!result.resumed || !result.sessionId) {
        throw new Error("adapter did not confirm loading the recorded internal session");
      }
      session.setInternalSessionId(result.sessionId, false);
      await stageOpeningContinuation(stageContinuation, checkpoint, result.sessionId);
      const attempt: ContinuationAttempt = Object.freeze({
        strategy: "load_internal_session",
        status: "succeeded",
      });
      const continuation = createContinuationReport(
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
    audit?: AuditPersistenceRuntime,
    stageContinuation?: (state: StagedContinuationState) => Promise<StagedContinuationState>,
    onOpenProgress?: ManagedOpenProgressReporter,
  ): Promise<AgentSessionOpenResult> {
    const strategies = normalizeContinuationStrategies(config.continuation);
    const persistence = resolveDirectPersistence(config.persistence);
    if (persistence === false || persistence.transcript === false) {
      throw new Error("AgentSession.open() currently requires transcript persistence");
    }
    const paths = await resolveSessionLogPaths(persistence, config.agentSessionId);
    if (!paths.transcriptPath) throw new Error("AgentSession.open() requires a transcript path");
    if (paths.auditLogPath && !audit) {
      throw new DirectAuditPersistenceUnsupportedError();
    }

    let primary: TranscriptPersistenceRuntime;
    try {
      primary = await TranscriptPersistenceRuntime.resume({
        path: paths.transcriptPath,
        expected: { agentSessionId: config.agentSessionId },
        writerLock: transcriptLock,
      });
    } catch (error) {
      await audit?.close().catch(() => undefined);
      throw error;
    }
    const transcript: PersistenceStateRuntime = audit
      ? new AuditedPersistenceRuntime(primary, audit)
      : primary;
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
      const session = new AgentConversation({
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
      }, {
        transcript,
        transcriptPath: paths.transcriptPath,
        stageContinuation,
        onOpenProgress,
      });
      session.managedAuditLog = audit?.identity ?? null;

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
      const result = await this.controller.start((event) => this.reportManagedControllerProgress(event));
      if (!result.resumed || !result.sessionId) {
        throw new Error("adapter did not confirm loading the recorded internal session");
      }
      this.setInternalSessionId(result.sessionId, false);
      return;
    }
    const paths = await resolveSessionLogPaths(persistence, this.agentSessionId);
    const createdAt = new Date().toISOString();
    const requestDigest = this.managedCreation?.requestDigest ?? sha256CanonicalJson({
      agentSessionId: this.agentSessionId,
      creationId: this.creationId,
      adapterId: this.adapterId,
      mode: this._mode,
      transcriptPath: paths.transcriptPath,
      auditLogPath: paths.auditLogPath,
    });
    let audit: AuditPersistenceRuntime | null = null;
    if (paths.auditLogPath && persistence.auditLog !== false) {
      const auditLogId = crypto.randomUUID();
      const header = {
        v: 1 as const, t: "header" as const, auditLogId, generation: 1,
        agentSessionId: this.agentSessionId, seq: 1, ts: Date.parse(createdAt),
        event: "created" as const, createdAt,
        effectivePolicy: persistence.auditLog.capture,
        effectiveLimits: persistence.limits,
        includeTruncationDigests: persistence.auditLog.includeTruncationDigests,
        installation: { kind: "creation" as const, operationId: this.creationId, requestDigest },
      };
      audit = await AuditPersistenceRuntime.create({
        path: paths.auditLogPath,
        header,
        writerLock: this.managedCreation?.auditLogLock,
      });
      this.managedAuditLog = audit.identity;
    }
    if (!paths.transcriptPath || persistence.transcript === false) {
      try {
        const result = await this.controller.start((event) => this.reportManagedControllerProgress(event));
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
          const primary = new RegistryPersistenceRuntime(createAgentSessionCheckpoint({
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
          this.v2Transcript = audit ? new AuditedPersistenceRuntime(primary, audit) : primary;
        }
        return;
      } catch (error) {
        await audit?.close().catch(() => undefined);
        throw error;
      }
    }

    const transcriptPath = paths.transcriptPath;
    const transcriptId = crypto.randomUUID();
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
    const primary = await TranscriptPersistenceRuntime.create({
      path: transcriptPath,
      header,
      writerLock: this.managedCreation?.transcriptLock,
      initializeCheckpoint: async () => {
        const result = await this.controller.start((event) => this.reportManagedControllerProgress(event));
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
    this.v2Transcript = audit ? new AuditedPersistenceRuntime(primary, audit) : primary;
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
          const loaded = await this.controller.start((event) => this.reportManagedControllerProgress(event));
          if (!loaded.resumed || !loaded.sessionId) {
            throw new Error("adapter did not confirm loading the recorded internal session");
          }
          if (loaded.sessionId !== checkpoint.internalSessionId) {
            throw new Error("adapter loaded a different internal session than requested");
          }
          this._mode = this.controller.currentMode;
          this.setInternalSessionId(loaded.sessionId, false);
          await stageOpeningContinuation(
            this.openBootstrap.stageContinuation,
            checkpoint,
            loaded.sessionId,
          );
          this.continuationAcquired = true;
          recordedThreadAvailability = "available";
          attempts.push(Object.freeze({ strategy: strategy.kind, status: "succeeded" }));
          return createContinuationReport(checkpoint, this.adapterId, this.v2Transcript, recordedThreadAvailability, attempts, {
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
        const created = await this.controller.startFresh((event) => this.reportManagedControllerProgress(event));
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
          buildContinuationPrompt(continuation.trim()),
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
        return createContinuationReport(checkpoint, this.adapterId, this.v2Transcript, recordedThreadAvailability, attempts, {
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

    return createContinuationReport(
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

  /** Active adapter route. It changes only after a durable switch activation. */
  get adapterId(): string {
    return this._adapterId;
  }

  /** Canonical `agc-` identity. */
  get id(): AgentConversationId {
    return this.agentConversationId;
  }

  /** Owning `ags-` identity, or null for a detached compatibility conversation. */
  get ownerId(): AgentSessionId | null {
    return this.ownerAgentSessionId;
  }

  get participants(): readonly ParticipantRef[] {
    return Object.freeze(this._participants.map((participant) => Object.freeze({ ...participant })));
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

  /** @internal Meter disposable provider work without replacing this conversation's baseline. */
  beginDetachedMetering(input: {
    operationId: string;
    operationKind: MeteredOperationKind;
    internalSessionId: string;
    model: string | null;
  }): Promise<OpenDetachedOperation> {
    return this.metering.openDetached({
      ...input,
      providerId: this.providerId,
    });
  }

  /** @internal Completes a detached rating unit; the owner persists its returned record. */
  async closeDetachedMetering(
    operation: OpenDetachedOperation,
    input: {
      outcome: "completed" | "cancelled" | "error";
      usage: TokenUsage | null;
      usageFailureReason?: string;
    },
  ): Promise<OperationMeteringRecord> {
    return await this.metering.closeDetached(operation, {
      outcome: input.outcome,
      reportedCumulative: input.usage,
      ...(input.usageFailureReason ? { usageFailureReason: input.usageFailureReason } : {}),
      contextAfter: this._contextWindow,
      providerCostAfter: this._providerCost,
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
      auditLog: this.managedAuditLog ? structuredClone(this.managedAuditLog) : null,
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
    return this.operations.queuedCount;
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

  /** Prompt while attributing the caller to a stable participant identity. */
  promptFrom(
    participantId: string,
    text: string,
    handlers?: PromptHandlers,
    attachments?: Attachment[],
  ): Promise<AgentSessionPromptResult> {
    if (!participantId.trim()) return Promise.reject(new Error("participant id cannot be blank"));
    return this.enqueuePrompt(text, "prompt", handlers, attachments, participantId.trim());
  }

  private enqueuePrompt(
    text: string,
    operationKind: MeteredOperationKind,
    handlers?: PromptHandlers,
    attachments?: Attachment[],
    participantId?: string,
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
      this.operations.enqueue({
        kind: "prompt",
        turnId: this.mintTurnId(),
        operationKind,
        text,
        ...(participantId ? { participantId } : {}),
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
      this.operations.enqueue({
        kind: "handoff",
        handoffId: this.mintOperationId(),
        // A queued operation owns its arguments. Do not let a caller mutate the object
        // while it waits behind an active prompt and silently change the handoff.
        options: ownHandoffOptions(options),
        resolve,
        reject,
      });
      this.emitStateIfChanged();
      void this.pump();
    });
  }

  /** Cross-adapter handoff. The owning Agent resolves `targetAdapterId` in its registry. */
  switch(
    targetAdapterId: string,
    options: Omit<HandoffOptions, "target" | "summary"> & {
      readonly mode?: AgentMode;
      readonly config?: Readonly<Record<string, unknown>>;
    } = {},
  ): Promise<HandoffResult> {
    if (!targetAdapterId.trim()) return Promise.reject(new Error("target adapter id cannot be blank"));
    return this.handoff({
      continuation: options.continuation,
      targetPrompt: options.targetPrompt,
      target: {
        adapterId: targetAdapterId.trim(),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.config === undefined ? {} : { config: options.config }),
      },
    });
  }

  /** @internal Seed a newly created provider thread from a durable recovery checkpoint. */
  async seedRecoveryContext(text: string): Promise<PromptResult> {
    if (!text.trim()) throw new Error("recovery context cannot be blank");
    const recoveryId = `recovery-${crypto.randomUUID()}`;
    const records: OperationMeteringRecord[] = [];
    await this.recordNativeAction(recoveryId, "conversation_recovery", "started");
    try {
      const result = await this.meteredInternalPrompt(
        recoveryId,
        "conversation_recovery",
        text,
        records,
      );
      if (result.status !== "completed") {
        throw new Error(`conversation recovery seed ${result.status}`);
      }
      await this.recordNativeAction(recoveryId, "conversation_recovery", "completed", {
        output: { internalSessionId: this._internalSessionId },
      });
      return result;
    } catch (error) {
      await this.recordNativeAction(recoveryId, "conversation_recovery", "failed", {
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      throw error;
    }
  }

  /** Start a blank provider thread without generating or installing continuation context. */
  reset(options: {
    readonly targetAdapterId?: string;
    readonly mode?: AgentMode;
    readonly config?: Readonly<Record<string, unknown>>;
    readonly targetPrompt?: string;
  } = {}): Promise<HandoffResult> {
    return this.handoff({
      continuation: { kind: "none" },
      ...(options.targetPrompt === undefined ? {} : { targetPrompt: options.targetPrompt }),
      ...((options.targetAdapterId ?? options.mode ?? options.config) === undefined
        ? {}
        : {
            target: {
              adapterId: options.targetAdapterId ?? this.adapterId,
              ...(options.mode === undefined ? {} : { mode: options.mode }),
              ...(options.config === undefined ? {} : { config: options.config }),
            },
          }),
    });
  }

  private async pump(): Promise<void> {
    if (this.operations.isDraining) return;
    try {
      await this.operations.drain(async (item) => {
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
            if (this.ownerAgentSessionId) {
              await this.recordOwned({
                recordId: `${item.operationId}:configuration:started`,
                agentSessionId: this.ownerAgentSessionId,
                agentConversationId: this.agentConversationId,
                kind: "configuration",
                timestamp: new Date().toISOString(),
                operation: "set",
                configId: item.configId,
                value: toPersistenceJsonValue(item.value),
                status: "started",
              });
            }
            await this.runSetConfig(item);
            if (this.ownerAgentSessionId) {
              await this.recordOwned({
                recordId: `${item.operationId}:configuration:completed`,
                agentSessionId: this.ownerAgentSessionId,
                agentConversationId: this.agentConversationId,
                kind: "configuration",
                timestamp: new Date().toISOString(),
                operation: "set",
                configId: item.configId,
                value: toPersistenceJsonValue(item.value),
                status: "completed",
              });
            }
            this.emit({ kind: "configuration_completed", operationId: item.operationId, configId: item.configId });
            item.resolve();
          } catch (err) {
            if (this.ownerAgentSessionId) {
              await this.recordOwned({
                recordId: `${item.operationId}:configuration:failed`,
                agentSessionId: this.ownerAgentSessionId,
                agentConversationId: this.agentConversationId,
                kind: "configuration",
                timestamp: new Date().toISOString(),
                operation: "set",
                configId: item.configId,
                value: toPersistenceJsonValue(item.value),
                status: "failed",
                error: String(err),
              }).catch((persistenceError) => this.log.warn("configuration_failure_persistence_failed", {
                error: String(persistenceError),
              }));
            }
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
            await this.recordNativeAction(item.transitionId, "mode_change", "started", {
              input: { from, to: item.mode },
            });
            const result = await this.runSetMode(item);
            await this.recordNativeAction(item.transitionId, "mode_change", "completed", {
              output: { mode: item.mode, internalSessionId: result.sessionId || null },
            });
            this.emit({ kind: "mode_change_completed", transitionId: item.transitionId, from, to: item.mode });
            item.resolve(result);
          } catch (err) {
            await this.recordNativeAction(item.transitionId, "mode_change", "failed", {
              error: String(err),
            }).catch(() => undefined);
            this.emit({ kind: "mode_change_failed", transitionId: item.transitionId, from, to: item.mode, error: String(err) });
            item.reject(err);
          }
        }
        // Promise consumers must observe the settled public state. The old in-class
        // loop reached its `finally` synchronously after resolving the last item;
        // crossing the extracted queue's async callback adds a microtask boundary.
        // Settle here only when no next item exists, preserving both that ordering and
        // the no-idle-gap guarantee between queued operations.
        this.settleIdleIfDrained();
      });
    } finally {
      if (this.phase !== "stopped") this.phase = "idle";
      this.emitStateIfChanged();
    }
  }

  private settleIdleIfDrained(): void {
    if (this.operations.queuedCount !== 0 || this.phase === "stopped") return;
    this.phase = "idle";
    this.emitStateIfChanged();
  }

  private async runHandoff(item: HandoffQueueItem): Promise<HandoffResult> {
    const fromInternalSessionId = this._internalSessionId;
    const fromAdapterId = this.adapterId;
    const targetAdapterId = item.options.target?.adapterId ?? fromAdapterId;
    const targetMode = item.options.target?.mode ?? this._mode;
    const continuation = normalizeHandoffContinuation(item.options);
    const transitionKind = targetAdapterId === fromAdapterId ? "handoff" as const : "switch" as const;
    const action = continuation.kind === "none" && transitionKind === "handoff"
      ? "reset"
      : transitionKind;
    const fromDescriptor = this.v2Transcript ? this.v2Descriptor() : null;
    let toInternalSessionId: string | undefined;
    let toDescriptor: InternalSessionDescriptor | undefined;
    let summary: string | undefined;
    let targetResult: PromptResult | undefined;
    let targetController: AgentController | null = null;
    let resolvedTargetAdapter: Adapter | null = null;
    let targetActivated = false;
    let failedAfter: "start" | "target_created" | "target_activated" = "start";
    // Records accumulate as they complete, so a handoff that fails partway still reports
    // the operations it already paid for.
    const records: OperationMeteringRecord[] = [];
    this.emit({
      kind: "handoff_started",
      handoffId: item.handoffId,
      fromInternalSessionId,
    });
    await this.recordNativeAction(item.handoffId, action, "started", {
      input: {
        fromAdapterId,
        targetAdapterId,
        targetMode,
        continuation: continuation.kind,
      },
    });
    if (this.v2Transcript) {
      await this.v2Transcript.appendTransitionEvent({
        kind: "transition",
        transitionId: item.handoffId,
        transitionKind,
        event: "started",
        from: fromDescriptor,
        ...(continuation.kind === "provided" ? { summary: continuation.content } : {}),
      });
    } else {
      await this.appendTranscript({
        v: 1,
        t: "handoff",
        event: "start",
        ts: Date.now(),
        handoffId: item.handoffId,
        fromInternalSessionId,
        ...(continuation.kind === "provided" ? { summary: continuation.content } : {}),
      });
    }

    try {
      if (continuation.kind !== "none" && this.controller.isDegraded) {
        throw new Error("handoff continuation requires ACP (normal) mode");
      }

      if (continuation.kind === "provided") {
        // A supplied summary removes the generation operation entirely, so no
        // `:summary` record is ever minted for it.
        summary = continuation.content;
      } else if (continuation.kind === "generated") {
        const generated = await this.meteredInternalPrompt(
          `${item.handoffId}:summary`,
          "handoff_summary",
          continuation.summaryPrompt,
          records,
        );
        if (generated.status !== "completed" || !generated.text.trim()) {
          throw new Error(`handoff summary generation ${generated.status}`);
        }
        // Handoff requires one seed string, so this internal boundary policy is explicit;
        // it is not treated as the canonical shape of the provider response.
        summary = formatResponseMessages(generated.messages, "\n\n").trim();
      } else {
        summary = "";
      }

      const replacingController = targetAdapterId !== fromAdapterId || targetMode !== this._mode;
      let created: ConnectResult;
      if (replacingController) {
        const adapter = item.options.target?.adapter ?? (targetAdapterId === fromAdapterId
          ? this.activeAdapter
          : this.ownerLifecycle?.resolveAdapter?.(targetAdapterId));
        if (!adapter) {
          throw new Error(
            `cannot resolve adapter ${targetAdapterId}; cross-adapter switch requires an Agent-owned conversation`,
          );
        }
        resolvedTargetAdapter = adapter;
        targetController = this.createController(adapter, targetAdapterId, targetMode);
        created = await targetController.startFresh();
      } else {
        if (this.controller.isDegraded) {
          throw new Error("starting a fresh provider thread requires ACP (normal) mode");
        }
        targetController = this.controller;
        created = await targetController.newSession();
      }
      if (!created.sessionId) throw new Error("harness returned no session id for handoff");
      toInternalSessionId = created.sessionId;
      if (!replacingController && toInternalSessionId === fromInternalSessionId) {
        throw new Error("harness did not replace the internal session during handoff");
      }

      for (const [configId, value] of Object.entries(item.options.target?.config ?? {})) {
        await targetController.setConfig(configId, value);
      }
      await this.recordNativeAction(item.handoffId, action, "checkpoint", {
        output: { stage: "target_created", internalSessionId: toInternalSessionId, adapterId: targetAdapterId },
      });

      if (this.v2Transcript) {
        const transitionAt = new Date().toISOString();
        toDescriptor = this.v2Descriptor(toInternalSessionId, transitionAt);
        await this.v2Transcript.appendTransitionEvent({
          kind: "transition",
          transitionId: item.handoffId,
          transitionKind,
          event: "target_created",
          from: fromDescriptor,
          to: toDescriptor,
        });
        failedAfter = "target_created";
        const checkpoint = this.v2Transcript.checkpoint;
        await this.v2Transcript.activateTransition({
          kind: "transition",
          transitionId: item.handoffId,
          transitionKind,
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
                  transition: { kind: transitionKind, transitionId: item.handoffId },
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
      const activatedAt = new Date().toISOString();
      try {
        await this.ownerLifecycle?.transitionActivated?.({
          transitionId: item.handoffId,
          agentConversationId: this.agentConversationId,
          internalSessionId: toInternalSessionId,
          adapterId: targetAdapterId,
          mode: targetMode,
          ...(activeModel(targetController.configOptions)
            ? { model: activeModel(targetController.configOptions)! }
            : {}),
          activatedAt,
        });
      } catch (error) {
        this.markManagedPersistenceUnhealthy();
        throw error;
      }

      const previousController = this.controller;
      if (targetController !== previousController) {
        this.controller = targetController;
        this.activeAdapter = resolvedTargetAdapter!;
        this._adapterId = targetAdapterId;
        this._mode = targetMode;
        this.metering = new MeteringEngine({
          ...this.meteringConfig,
          agentSessionId: this.agentSessionId,
          adapterId: targetAdapterId,
          initialState: this.metering.currentState,
          createdActiveThread: true,
          pricing: this.meteringConfig.pricing ?? createModelsDevResolver(),
          enforcement: this.meteringConfig.enforcement ?? "best_effort",
        });
        this.bindController(targetController);
      }
      targetActivated = true;
      this.setInternalSessionId(toInternalSessionId);
      await this.ownerLifecycle?.meteringStateChanged?.(this.metering.currentState);
      this.emitStateIfChanged();
      await this.persist();
      await this.recordNativeAction(item.handoffId, action, "checkpoint", {
        output: { stage: "target_activated", internalSessionId: toInternalSessionId, adapterId: targetAdapterId },
      });
      if (targetController !== previousController) {
        await previousController.stop().catch((error) => {
          this.log.warn("handoff_previous_controller_stop_failed", { error: String(error) });
        });
      }

      if (continuation.kind !== "none") {
        const seeded = await this.meteredInternalPrompt(
          `${item.handoffId}:seed`,
          transitionKind === "switch" ? "switch_seed" : "handoff_seed",
          buildContinuationPrompt(summary),
          records,
        );
        if (seeded.status !== "completed") {
          throw new Error(`handoff continuation seeding ${seeded.status}`);
        }
      }
      if (item.options.targetPrompt !== undefined) {
        const prompted = await this.meteredInternalPrompt(
          `${item.handoffId}:target`,
          "internal_command",
          item.options.targetPrompt,
          records,
        );
        if (prompted.status !== "completed") {
          throw new Error(`handoff target prompt ${prompted.status}`);
        }
        targetResult = copyPromptResult(prompted);
      }

      const result: HandoffResult = Object.freeze({
        handoffId: item.handoffId,
        agentSessionId: this.agentSessionId,
        fromInternalSessionId,
        toInternalSessionId,
        ...(transitionKind === "switch" ? { fromAdapterId, toAdapterId: targetAdapterId } : {}),
        summary,
        ...(targetResult ? { targetResult } : {}),
        meteringRecords: Object.freeze([...records]),
      });
      if (this.v2Transcript) {
        await this.v2Transcript.appendTransitionEvent({
          kind: "transition",
          transitionId: item.handoffId,
          transitionKind,
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
      await this.recordNativeAction(item.handoffId, action, "completed", {
        output: { internalSessionId: toInternalSessionId, adapterId: targetAdapterId },
      });
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
          await this.ownerLifecycle?.meteringStateChanged?.(this.metering.currentState);
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
          transitionKind,
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
      if (!targetActivated && targetController && targetController !== this.controller) {
        await targetController.stop().catch(() => undefined);
      }
      await this.recordNativeAction(item.handoffId, action, "failed", { error }).catch(
        (persistenceError) => this.log.warn("native_action_failure_persistence_failed", {
          error: String(persistenceError),
        }),
      );
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
      await this.ownerLifecycle?.meteringStateChanged?.(this.metering.currentState);
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
    const targetProviderContextId = this.ownerLifecycle
      ? this._internalSessionId ?? `runtime:${this.ownerContextNonce ??= crypto.randomUUID()}`
      : undefined;
    const owned = this.ownerLifecycle
      ? await this.ownerLifecycle.beforePrompt({
          operationId: item.turnId,
          agentSessionId: this.ownerAgentSessionId!,
          agentConversationId: this.agentConversationId,
          targetProviderContextId,
          ...(item.participantId ? { participantId: item.participantId } : {}),
          text: item.text,
        })
      : undefined;
    if (owned?.participant && !this._participants.some((participant) => participant.id === owned.participant!.id)) {
      this._participants = [...this._participants, Object.freeze({ ...owned.participant })];
    }
    const providerText = owned?.providerText ?? item.text;
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
        const userRecord = await this.v2Transcript.appendPresentationEvent({
          kind: "message",
          operationId: item.turnId,
          role: "user",
          text: item.text,
          status: "completed",
          presentation: { id: `message:${item.turnId}:user`, revision: 1 },
        });
        await this.v2Transcript.syncBeforeDispatch();
        this.presentation.emitPersistedRecord(userRecord);
      } catch (error) {
        this.endTurn(item.turnId, item.handlers);
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
    let assistantOrdinal = 0;
    let assistantMessage: {
      readonly id: string;
      providerMessageId?: string;
      text: string;
      revision: number;
      dirty: boolean;
    } | null = null;
    const beginAssistantMessage = (providerMessageId?: string) => {
      assistantOrdinal++;
      assistantMessage = {
        id: `message:${item.turnId}:assistant:${assistantOrdinal}`,
        ...(providerMessageId === undefined ? {} : { providerMessageId }),
        text: "",
        revision: 0,
        dirty: false,
      };
      return assistantMessage;
    };
    const flushAssistantMessage = (
      status: "in_progress" | "completed" | "cancelled" | "error",
      stopReason?: string,
      force = false,
    ) => {
      if (!this.v2Transcript || !assistantMessage || (!assistantMessage.dirty && !force)) return;
      assistantMessage.revision++;
      assistantMessage.dirty = false;
      const message = assistantMessage;
      this.presentation.queuePresentation({
        kind: "message",
        operationId: item.turnId,
        role: "assistant",
        text: message.text,
        ...(message.providerMessageId === undefined ? {} : { providerMessageId: message.providerMessageId }),
        structured: {
          version: 1,
          messages: [message.providerMessageId === undefined
            ? { text: message.text }
            : { messageId: message.providerMessageId, text: message.text }],
        },
        status,
        ...(stopReason === undefined ? {} : { stopReason }),
        presentation: { id: message.id, revision: message.revision },
      });
    };
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
        const settledReasoning = this.presentation.closeReasoningBoundary();
        if (settledReasoning) {
          this.queueActivityRecords(item.turnId, [settledReasoning]);
          item.handlers?.onRecord?.({ current: null, delta: null, emitted: [settledReasoning] });
        }
        response.append(chunk);
        if (this.v2Transcript) {
          if (chunk.startsMessage) {
            flushAssistantMessage("completed", undefined, assistantMessage !== null);
            beginAssistantMessage(chunk.messageId);
          }
          const current = assistantMessage ?? beginAssistantMessage(chunk.messageId);
          if (current.providerMessageId === undefined && chunk.messageId !== undefined) {
            current.providerMessageId = chunk.messageId;
          }
          current.text += chunk.text;
          current.dirty = true;
          // Persist the first usable snapshot. Later token chunks remain in memory until
          // an interleaving item, a new message, or the operation boundary.
          if (current.revision === 0) flushAssistantMessage("in_progress");
        }
        item.handlers?.onResponseChunk?.(chunk);
      },
      onActivity: (event) => {
        // The message snapshot must enter the shared queue before an activity first seen
        // after it. Later activity revisions keep their original presentation position.
        flushAssistantMessage("in_progress");
        const result = this.presentation.applyActivity(event);
        this.queueActivityRecords(item.turnId, result.emitted);
        item.handlers?.onRecord?.(result);
        item.handlers?.onActivity?.(event);
      },
      onPermissionRequest: async (request) => {
        const permissionBase = `${item.turnId}:permission:${request.toolCallId}`;
        if (this.ownerAgentSessionId) {
          await this.recordOwned({
            recordId: `${permissionBase}:requested`,
            agentSessionId: this.ownerAgentSessionId,
            agentConversationId: this.agentConversationId,
            kind: "permission",
            timestamp: new Date().toISOString(),
            permissionId: request.toolCallId,
            state: "requested",
            request: toPersistenceJsonValue({
              toolCallId: request.toolCallId,
              ...(request.title ? { title: request.title } : {}),
              options: request.options,
              raw: request.raw,
            }),
          });
        }
        const outcome = item.handlers?.onPermissionRequest
          ? await item.handlers.onPermissionRequest(request)
          : defaultPermissionOutcome(request, this.defaultPermission);
        if (this.ownerAgentSessionId) {
          await this.recordOwned({
            recordId: `${permissionBase}:resolved`,
            agentSessionId: this.ownerAgentSessionId,
            agentConversationId: this.agentConversationId,
            kind: "permission",
            timestamp: new Date().toISOString(),
            permissionId: request.toolCallId,
            state: "resolved",
            outcome: permissionRecordOutcome(request, outcome),
          });
        }
        return outcome;
      },
    };

    let closed: OperationMeteringRecord | null = null;
    let transcriptClosed = false;
    let providerSettled = false;
    try {
      const res = await this.controller.prompt(providerText, wrappedHandlers, item.attachments);
      providerSettled = true;
      if (this.v2Transcript) {
        if (assistantOrdinal === 0) {
          for (const message of res.messages) {
            const current = beginAssistantMessage(message.messageId);
            current.text = message.text;
            current.dirty = true;
            flushAssistantMessage(res.status, res.stopReason, true);
          }
        } else {
          flushAssistantMessage(res.status, res.stopReason, true);
        }
      }
      // Before the assistant msg: `msg` delimits a turn, so anything still open has to
      // land inside those fences.
      this.endTurn(item.turnId, item.handlers);
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
      await this.ownerLifecycle?.meteringRecorded?.(record);
      await this.persist();
      if (this.v2Transcript) {
        await this.presentation.drain();
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
      const result = Object.freeze({ ...res, operationId: item.turnId, metering: record });
      await this.ownerLifecycle?.afterPrompt({
        operationId: item.turnId,
        agentSessionId: this.ownerAgentSessionId!,
        agentConversationId: this.agentConversationId,
        targetProviderContextId,
        ...(owned?.identityDeliveryReceipt
          ? { identityDeliveryReceipt: owned.identityDeliveryReceipt }
          : {}),
        ...(item.participantId ? { participantId: item.participantId } : {}),
        text: item.text,
        result,
      });
      await this.ownerRecordWrite;
      return result;
    } catch (err) {
      // Easy to miss, and the whole point of R4: a turn that died mid-tool still records
      // what it was doing, at its real status.
      this.endTurn(item.turnId, item.handlers);
      const structured = response.snapshot();
      const text = structured.length > 0 ? response.text : chunks.join("");
      const messages: readonly ResponseMessage[] = structured.length > 0
        ? structured
        : text
          ? Object.freeze([{ text }])
          : Object.freeze([]);
      if (!providerSettled) {
        await this.ownerLifecycle?.promptFailed({
          operationId: item.turnId,
          agentSessionId: this.ownerAgentSessionId!,
          agentConversationId: this.agentConversationId,
          ...(item.participantId ? { participantId: item.participantId } : {}),
          text: item.text,
          messages,
          error: err,
        }).catch((persistenceError) => {
          this.log.warn("owned_prompt_failure_persistence_failed", { error: String(persistenceError) });
        });
      }
      await this.ownerRecordWrite.catch((persistenceError) => {
        this.log.warn("owned_runtime_persistence_failed", { error: String(persistenceError) });
      });
      if (this.v2Transcript) {
        if (!transcriptClosed && assistantOrdinal === 0 && messages.length > 0) {
          for (const message of messages) {
            const current = beginAssistantMessage(message.messageId);
            current.text = message.text;
            current.dirty = true;
            flushAssistantMessage("error", "error", true);
          }
        } else if (!transcriptClosed) {
          flushAssistantMessage("error", "error", true);
        }
        await this.presentation.drain().catch(() => undefined);
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
      await this.ownerLifecycle?.meteringRecorded?.(record);
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
    if (this.isBusy || this.operations.queuedCount > 0) {
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
    await this.ownerLifecycle?.meteringStateChanged?.(after);
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
      await this.ownerLifecycle?.meteringRecorded?.(record);
      if (this.v2Transcript) {
        await this.v2Transcript.appendEvent({
          kind: "message",
          operationId,
          role: "assistant",
          text: formatResponseMessages(result.messages, "\n\n"),
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
        await this.ownerLifecycle?.meteringRecorded?.(record);
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
    return this.presentation.snapshot();
  }

  private beginTurn(turnId: string): void {
    this.presentation.beginTurn(turnId);
  }

  private endTurn(turnId: string, handlers?: PromptHandlers): void {
    this.queueActivityRecords(turnId, this.presentation.endTurn(handlers));
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

  interrupt(options?: InterruptOptions): void {
    if (options?.clearQueue) {
      const dropped = this.operations.clear();
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
    await this.ownerRecordWrite.catch((error) => {
      this.log.warn("owned_runtime_persistence_failed", { error: String(error) });
    });
    await this.presentation.drain().catch(() => undefined);
    await this.v2Transcript?.close();
  }

  // --- mode swap (catalog-affecting) -------------------------------------------
  async setMode(mode: AgentMode): Promise<ConnectResult> {
    if (this.phase === "stopped") throw new Error("AgentSession is stopped");
    this.assertPromptable();
    return await new Promise<ConnectResult>((resolve, reject) => {
      this.operations.enqueue({
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
      this.operations.enqueue({
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
      this.operations.enqueue({ kind: "resolve_config", resolution: owned, resolve, reject });
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
      this.operations.enqueue({ kind: "resolve_recovery", resolution: owned, resolve, reject });
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
    if (this.ownerLifecycle) this.ownerContextNonce = null;
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

/**
 * @deprecated `AgentSession` is the compatibility name for one conversation. New code
 * should use `AgentConversation`; the forthcoming `Agent` object owns conversations.
 */
export { AgentConversation as AgentSession };

export type AgentConversationConfig = AgentSessionConfig;
export type AgentConversationOpenConfig = AgentSessionOpenConfig;
export type AgentConversationOpenResult = AgentSessionOpenResult;
export type ManagedAgentConversationCreationBootstrap = ManagedAgentSessionCreationBootstrap;
export type ManagedAgentConversationPersistenceSnapshot = ManagedAgentSessionPersistenceSnapshot;

function persistenceOperationKind(kind: MeteredOperationKind): OperationKind {
  if (kind === "internal_command") return "internal_session_command";
  if (
    kind === "conversation_checkpoint"
    || kind === "conversation_recovery"
    || kind === "identity_update"
  ) return "other";
  return kind;
}

function ownHandoffOptions(options: HandoffOptions): HandoffOptions {
  return Object.freeze({
    ...(options.summary === undefined ? {} : { summary: options.summary }),
    ...(options.target === undefined
      ? {}
      : {
          target: Object.freeze({
            adapterId: options.target.adapterId,
            ...(options.target.mode === undefined ? {} : { mode: options.target.mode }),
            ...(options.target.adapter === undefined
              ? {}
              : {
                  adapter: Object.freeze({
                    ...options.target.adapter,
                    command: Object.freeze([...options.target.adapter.command]) as unknown as string[],
                    ...(options.target.adapter.ptyCommand
                      ? {
                          ptyCommand: Object.freeze([
                            ...options.target.adapter.ptyCommand,
                          ]) as unknown as string[],
                        }
                      : {}),
                  }),
                }),
            ...(options.target.config === undefined
              ? {}
              : { config: Object.freeze({ ...options.target.config }) }),
          }),
        }),
    ...(options.continuation === undefined
      ? {}
      : { continuation: Object.freeze({ ...options.continuation }) }),
    ...(options.targetPrompt === undefined ? {} : { targetPrompt: options.targetPrompt }),
  });
}

function normalizeHandoffContinuation(options: HandoffOptions):
  | { readonly kind: "generated"; readonly summaryPrompt: string }
  | { readonly kind: "provided"; readonly content: string }
  | { readonly kind: "none" } {
  if (options.summary !== undefined && options.continuation !== undefined) {
    throw new Error("handoff cannot combine deprecated summary with continuation");
  }
  if (options.target && !options.target.adapterId.trim()) {
    throw new Error("handoff target adapter id cannot be blank");
  }
  if (options.targetPrompt !== undefined && !options.targetPrompt.trim()) {
    throw new Error("handoff target prompt cannot be blank");
  }
  if (options.summary !== undefined) {
    if (!options.summary.trim()) throw new Error("handoff summary cannot be blank");
    return Object.freeze({ kind: "provided", content: options.summary });
  }
  const continuation = options.continuation ?? { kind: "generated" as const };
  if (continuation.kind === "provided") {
    if (!continuation.content.trim()) throw new Error("handoff continuation cannot be blank");
    return Object.freeze({ kind: "provided", content: continuation.content });
  }
  if (continuation.kind === "none") return Object.freeze({ kind: "none" });
  if (continuation.summaryPrompt !== undefined && continuation.summaryInstructions !== undefined) {
    throw new Error("handoff generated continuation cannot combine summaryPrompt and summaryInstructions");
  }
  if (continuation.summaryPrompt !== undefined && !continuation.summaryPrompt.trim()) {
    throw new Error("handoff summary prompt cannot be blank");
  }
  if (continuation.summaryInstructions !== undefined && !continuation.summaryInstructions.trim()) {
    throw new Error("handoff summary instructions cannot be blank");
  }
  const base = continuation.summaryPrompt ?? HANDOFF_SUMMARY_PROMPT;
  const summaryPrompt = continuation.summaryInstructions === undefined
    ? base
    : `${base}\n\nAdditional summary instructions:\n${continuation.summaryInstructions}`;
  return Object.freeze({ kind: "generated", summaryPrompt });
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

function runtimeRecordFromActivity(
  agentSessionId: AgentSessionId,
  agentConversationId: AgentConversationId,
  turnId: string,
  record: AggregatedRecord,
): NewConversationRecord | null {
  const timestamp = new Date().toISOString();
  const recordId = `${turnId}:runtime:${record.recordId}:${record.seq}`;
  const event = record.event;
  if (event.kind === "thinking") {
    return {
      recordId,
      agentSessionId,
      agentConversationId,
      kind: "thinking",
      timestamp,
      thinkingId: record.recordId,
      state: record.reason === "settled" || record.reason === "flushed" ? "completed" : "in_progress",
      content: event.text,
      ...(event.messageId ? { metadata: JSON.stringify({ providerMessageId: event.messageId }) } : {}),
    };
  }
  if (event.kind === "tool") {
    const terminal = event.status === "completed" || event.status === "failed";
    const state = event.status === "failed"
      ? "failed" as const
      : terminal
        ? "completed" as const
        : record.reason === "input"
          ? "input" as const
          : record.reason === "flushed"
            ? "failed" as const
            : "announced" as const;
    const output = event.rawOutput !== undefined || event.content !== undefined
      ? [{
          type: "json" as const,
          value: toPersistenceJsonValue({
            ...(event.rawOutput === undefined ? {} : { rawOutput: event.rawOutput }),
            ...(event.content === undefined ? {} : { content: event.content }),
            ...(event.locations === undefined ? {} : { locations: event.locations }),
          }),
        }]
      : undefined;
    return {
      recordId,
      agentSessionId,
      agentConversationId,
      kind: "tool_call",
      timestamp,
      toolCallId: event.toolCallId,
      state,
      ...(event.title || event.toolKind ? { name: event.title ?? event.toolKind } : {}),
      ...(event.rawInput === undefined ? {} : { input: toPersistenceJsonValue(event.rawInput) }),
      ...(output === undefined ? {} : { output }),
      ...(state === "failed" ? { error: `tool call ended with status ${event.status}` } : {}),
      metadata: JSON.stringify({ providerStatus: event.status, toolKind: event.toolKind }),
    };
  }
  switch (event.kind) {
    case "plan":
    case "plan_update":
    case "plan_removed":
      return {
        recordId,
        agentSessionId,
        agentConversationId,
        kind: "activity",
        timestamp,
        activityId: record.recordId,
        activityType: event.kind,
        state: "completed",
        data: toPersistenceJsonValue(event),
      };
    case "user_message":
    case "commands":
    case "mode":
    case "usage":
    case "session_info":
    case "config":
    case "unknown":
      // These are conversation echo, session state, or diagnostic protocol updates.
      // Their semantic state is persisted by messages/configuration/metering/checkpoints;
      // exact frames are independently available through raw protocol capture.
      return null;
    case "tool_update":
      // Folded updates return above as tool records. An unfurled tool_update is not a
      // self-contained model activity, so it must not be persisted independently.
      return null;
  }
}

function protocolMethod(message: PersistenceJsonValue): string | undefined {
  if (message === null || Array.isArray(message) || typeof message !== "object") return undefined;
  const method = (message as { readonly method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

function toPersistenceJsonValue(value: unknown): PersistenceJsonValue {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : JSON.parse(serialized) as PersistenceJsonValue;
}

function defaultPermissionOutcome(
  request: PermissionRequest,
  policy: "approve" | "cancel",
): PermissionOutcome {
  if (policy === "cancel") return { outcome: "cancelled" };
  const allow = request.options.find((option) => option.kind === "allow_once")
    ?? request.options.find((option) => option.kind === "allow_always");
  return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
}

function permissionRecordOutcome(
  request: PermissionRequest,
  outcome: PermissionOutcome,
): "approved" | "denied" | "cancelled" {
  if (outcome.outcome === "cancelled") return "cancelled";
  const selected = request.options.find((option) => option.optionId === outcome.optionId);
  return selected?.kind === "allow_once" || selected?.kind === "allow_always"
    ? "approved"
    : "denied";
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
