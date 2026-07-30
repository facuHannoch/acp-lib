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
import type { SessionManager, MergedSession } from "./session-manager.ts";
import {
  appendTranscriptLine,
  type TranscriptActivityLine,
  type TranscriptLine,
} from "./transcript.ts";
import type {
  ActivityEvent,
  AgentCommand,
  Attachment,
  PromptHandlers,
  PromptResult,
  SessionListEntry,
} from "./types.ts";

interface QueueItem {
  text: string;
  handlers?: PromptHandlers;
  attachments?: Attachment[];
  resolve: (r: PromptResult) => void;
  reject: (e: unknown) => void;
}

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

export interface AgentSessionConfig {
  /** The resolved adapter this conversation talks to. */
  adapter: Adapter;
  /** Stable adapter id for the catalog/display (e.g. "codex"). */
  adapterId: string;
  /** Talk over ACP ("normal") or scrape a pty ("degraded"). Default "normal". */
  mode?: AgentMode;
  execPrefix?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Default MCP servers bound at session creation/switch, unless a call overrides them. */
  mcpServers?: schema.McpServer[];
  defaultPermission?: "approve" | "cancel";
  clientInfo?: { name: string; title?: string; version?: string };
  /** What we let the agent do through us (terminals, filesystem). All on by default. */
  clientCapabilities?: AgentControllerConfig["clientCapabilities"];
  logger?: Logger;
  /** Optional catalog. When present, the session records itself here. */
  sessions?: SessionManager;
  /** Absolute path to an append-only transcript file. Omitted means no transcript. */
  transcriptPath?: string;
  /** Directory for a library-named transcript file: `<agentSessionId>.jsonl`. */
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
  /** Our stable AgentSession id. Minted if omitted; pass a record's agentSessionId to resume. */
  agentSessionId?: string;
  /** ACP/harness session to load on start (resume an existing provider conversation). */
  internalSessionId?: string;
  title?: string;
}

export class AgentSession implements AgentClient, Bridgeable {
  /** Our stable AgentSession id — decoupled from the ACP/harness session id. */
  readonly agentSessionId: string;
  readonly adapterId: string;

  private readonly controller: AgentController;
  private readonly sessions?: SessionManager;
  private readonly transcriptPath?: string;
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
  private _internalSessionId: string | null;
  private _mode: AgentMode;
  private _cwd?: string;
  private _title?: string;

  private constructor(config: AgentSessionConfig) {
    if (config.transcriptPath && config.transcriptDir) {
      throw new Error("AgentSessionConfig cannot specify both transcriptPath and transcriptDir");
    }
    this.agentSessionId = config.agentSessionId ?? crypto.randomUUID();
    this.adapterId = config.adapterId;
    this.sessions = config.sessions;
    this.transcriptPath =
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
    this._internalSessionId = config.internalSessionId ?? null;
    this.controller = new AgentController({
      adapter: config.adapter,
      adapterId: config.adapterId,
      mode: this._mode,
      execPrefix: config.execPrefix,
      env: config.env,
      cwd: config.cwd,
      sessionId: config.internalSessionId,
      mcpServers: config.mcpServers,
      defaultPermission: config.defaultPermission,
      clientInfo: config.clientInfo,
      clientCapabilities: config.clientCapabilities,
      logger: config.logger,
    });
  }

  /**
   * Start a conversation. A FRESH one if no `agentSessionId`/`internalSessionId`; a RESUMED one if
   * `internalSessionId` is given (the controller loads it). To resume from the catalog, the
   * caller resolves the record's adapter and passes the record's fields here.
   */
  static async create(config: AgentSessionConfig): Promise<AgentSession> {
    const session = new AgentSession(config);
    await session.start();
    return session;
  }

  private async start(): Promise<void> {
    const result = await this.controller.start();
    this._internalSessionId = result.sessionId || this._internalSessionId;
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
  get mode(): AgentMode {
    return this._mode;
  }
  get cwd(): string | undefined {
    return this._cwd;
  }
  get title(): string | undefined {
    return this._title;
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
  ): Promise<PromptResult> {
    return new Promise<PromptResult>((resolve, reject) => {
      this.queue.push({ text, handlers, attachments, resolve, reject });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          item.resolve(await this.runPrompt(item));
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runPrompt(item: QueueItem): Promise<PromptResult> {
    this.beginTurn();
    await this.appendTranscript({
      v: 1,
      t: "msg",
      role: "user",
      text: item.text,
      ts: Date.now(),
    });

    const chunks: string[] = [];
    const wrappedHandlers: PromptHandlers = {
      ...item.handlers,
      // Fired from here, from the one aggregator this session owns — nothing below needs
      // to know the handler exists, and two places firing it would be two folds.
      onRecord: undefined,
      onChunk: (chunk) => {
        chunks.push(chunk);
        item.handlers?.onChunk?.(chunk);
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

    try {
      const res = await this.controller.prompt(item.text, wrappedHandlers, item.attachments);
      // Before the assistant msg: `msg` delimits a turn, so anything still open has to
      // land inside those fences.
      this.endTurn(item.handlers);
      if (!this._title && item.text.trim()) {
        this._title = item.text.trim().replace(/\s+/g, " ").slice(0, 60);
      }
      // A session may have been created lazily on first prompt (degraded has none).
      this._internalSessionId = this.controller.currentSessionId ?? this._internalSessionId;
      await this.persist();
      await this.appendTranscript({
        v: 1,
        t: "msg",
        role: "assistant",
        text: res.text,
        ts: Date.now(),
        usage: res.usage,
        stopReason: res.stopReason,
        status: res.status,
      });
      return res;
    } catch (err) {
      // Easy to miss, and the whole point of R4: a turn that died mid-tool still records
      // what it was doing, at its real status.
      this.endTurn(item.handlers);
      await this.appendTranscript({
        v: 1,
        t: "msg",
        role: "assistant",
        text: chunks.join(""),
        ts: Date.now(),
        stopReason: "error",
        status: "error",
      });
      throw err;
    }
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

  private beginTurn(): void {
    // A correct caller always gets an empty array back — both exit paths flush. If one
    // ever doesn't, keeping the records (loudly) beats dropping them.
    const leftover = this.aggregator.startTurn(this.mintTurnId());
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
    if (!this.transcriptPath) return;
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
        item.resolve({ text: "", stopReason: "cancelled", status: "cancelled", usage: null });
      }
    }
    this.controller.interrupt(options);
  }

  async stop(): Promise<void> {
    await this.controller.stop();
  }

  // --- mode swap (catalog-affecting) -------------------------------------------
  async setMode(mode: AgentMode): Promise<ConnectResult> {
    const result = await this.controller.setMode(mode);
    this._mode = this.controller.currentMode;
    this._internalSessionId = result.sessionId || null; // the ACP/harness session changes on swap
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
  get agentCommands(): AgentCommand[] {
    return this.controller.agentCommands;
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
    });
  }

  private async appendTranscript(line: TranscriptLine): Promise<void> {
    if (!this.transcriptPath) return;
    this.transcriptWrite = this.transcriptWrite
      .catch(() => {})
      .then(async () => {
        try {
          await appendTranscriptLine(this.transcriptPath!, line);
        } catch (err) {
          this.log.warn("transcript_write_failed", {
            path: this.transcriptPath,
            error: String(err),
          });
        }
      });
    await this.transcriptWrite;
  }
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
