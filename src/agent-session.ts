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
import type { ConfigOptions } from "./config-options.ts";
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

type QueueItem = PromptQueueItem | HandoffQueueItem;

/** What the stable logical session is doing right now. */
export type AgentSessionPhase = "idle" | "prompting" | "handoff" | "stopped";

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

export class AgentSession implements AgentClient, Bridgeable {
  /** Our stable AgentSession id — decoupled from the ACP/harness session id. */
  readonly agentSessionId: string;
  readonly adapterId: string;

  private readonly controller: AgentController;
  private readonly sessions?: SessionManager;
  private readonly _transcriptPath?: string;
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

  private constructor(config: AgentSessionConfig) {
    if (config.transcriptPath && config.transcriptDir) {
      throw new Error("AgentSessionConfig cannot specify both transcriptPath and transcriptDir");
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

  private async start(): Promise<void> {
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
      restoration:
        restoration.status === "restored"
          ? { status: "restored" as const, version: 2 as const }
          : restoration,
      blocked: this.metering.blocked,
      blockedReason: this.metering.blockedReason,
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
    return this._transcriptPath;
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
    });
  }
  /** True while one operation is executing. Queued work is exposed independently. */
  get isBusy(): boolean {
    return this.phase === "prompting" || this.phase === "handoff";
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
        this.phase = item.kind === "prompt" ? "prompting" : "handoff";
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
        } else {
          try {
            item.resolve(await this.runHandoff(item));
          } catch (err) {
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
    let toInternalSessionId: string | undefined;
    let summary: string | undefined;
    // Records accumulate as they complete, so a handoff that fails partway still reports
    // the operations it already paid for.
    const records: OperationMeteringRecord[] = [];
    this.emit({
      kind: "handoff_started",
      handoffId: item.handoffId,
      fromInternalSessionId,
    });
    await this.appendTranscript({
      v: 1,
      t: "handoff",
      event: "start",
      ts: Date.now(),
      handoffId: item.handoffId,
      fromInternalSessionId,
      ...(item.options.summary !== undefined ? { summary: item.options.summary } : {}),
    });

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
      this.setInternalSessionId(toInternalSessionId);
      this.emitStateIfChanged();
      await this.persist();

      if (toInternalSessionId === fromInternalSessionId) {
        throw new Error("harness did not replace the internal session during handoff");
      }

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
      this.emit({ kind: "handoff_completed", result });
      return result;
    } catch (err) {
      // Once session/new succeeds the controller really is on the new thread. Keep the
      // public id and catalog truthful even when continuation seeding subsequently fails.
      const actualSessionId = this.controller.currentSessionId;
      if (actualSessionId && actualSessionId !== this._internalSessionId) {
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

  private async runPrompt(item: PromptQueueItem): Promise<AgentSessionPromptResult> {
    this.beginTurn(item.turnId);
    await this.appendTranscript({
      v: 1,
      t: "msg",
      role: "user",
      text: item.text,
      ts: Date.now(),
    });

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
        if (this.transcriptActivity) {
          for (const record of result.emitted) this.writeActivity(record);
        }
        item.handlers?.onRecord?.(result);
        item.handlers?.onActivity?.(event);
      },
    };

    // Opened BEFORE dispatch so a strict mode fails preflight rather than after the
    // provider has already been paid, and so the price in force at start is what applies.
    const operation = await this.metering.open({
      operationId: item.turnId,
      operationKind: item.operationKind,
      internalSessionId: this._internalSessionId,
      providerId: this.providerId,
      model: this.model,
      degraded: this.controller.isDegraded,
    });

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
      const record = await this.closeOperation(operation, res.status, res.usage);
      await this.persist();
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
      // A failed operation may still have consumed tokens, so its record has to survive
      // the rejection rather than only reaching event subscribers.
      const record = await this.closeOperation(operation, "error", null, String(err));
      throw new AgentSessionOperationError(item.turnId, record, err);
    }
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
    try {
      const result = await this.controller.prompt(text);
      records.push(await this.closeOperation(operation, result.status, result.usage));
      return result;
    } catch (err) {
      records.push(await this.closeOperation(operation, "error", null, String(err)));
      throw err;
    }
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
      if (this.transcriptActivity) for (const record of leftover) this.writeActivity(record);
    }
  }

  private endTurn(handlers?: PromptHandlers): void {
    const emitted = this.aggregator.flush();
    if (emitted.length === 0) return;
    if (this.transcriptActivity) for (const record of emitted) this.writeActivity(record);
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
    if (!this._transcriptPath) return;
    if (!this.activityKinds.has(record.event.kind)) return;
    void this.appendTranscript(this.toActivityLine(record));
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
          item.reject(new Error("handoff cancelled before it started"));
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
  }

  // --- mode swap (catalog-affecting) -------------------------------------------
  async setMode(mode: AgentMode): Promise<ConnectResult> {
    const result = await this.controller.setMode(mode);
    this._mode = this.controller.currentMode;
    // The ACP/harness session changes on swap, so context/cost reset with it.
    this.setInternalSessionId(result.sessionId || null);
    await this.persist();
    return result;
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
    return this.controller.setConfig(configId, value);
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
    ].join("\u0000");
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    this.emit({ kind: "state_changed", state });
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
