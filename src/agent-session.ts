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

import { AgentController, type AgentMode } from "./controller.ts";
import type * as schema from "@agentclientprotocol/sdk";
import { join } from "node:path";
import type { Adapter } from "./adapters.ts";
import type { AgentClient, Bridgeable, BridgeOptions, InterruptOptions } from "./agent-client.ts";
import type { Capabilities } from "./capabilities.ts";
import type { ConfigOptions } from "./config-options.ts";
import type { ConnectResult } from "./client.ts";
import { noopLogger, type Logger } from "./logger.ts";
import type { SessionManager, MergedSession } from "./session-manager.ts";
import { appendTranscriptLine, type TranscriptLine } from "./transcript.ts";
import type {
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
  logger?: Logger;
  /** Optional catalog. When present, the session records itself here. */
  sessions?: SessionManager;
  /** Absolute path to an append-only transcript file. Omitted means no transcript. */
  transcriptPath?: string;
  /** Directory for a library-named transcript file: `<agentSessionId>.jsonl`. */
  transcriptDir?: string;
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
      onChunk: (chunk) => {
        chunks.push(chunk);
        item.handlers?.onChunk?.(chunk);
      },
    };

    try {
      const res = await this.controller.prompt(item.text, wrappedHandlers, item.attachments);
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
