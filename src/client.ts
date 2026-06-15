// AcpClient — the core deliverable. Implements the AgentClient output contract and
// adds the rich ACP input surface (capabilities, configOptions, sessions, auth).
//
// Lifecycle (SPEC.md): construct (sync, no spawn) → connect() (spawn + initialize +
// session/new|load) → prompt(). Capabilities and configOptions are populated by
// connect() so callers can inspect them BEFORE prompting.

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import type { Adapter } from "./adapters.ts";
import { buildSpawnCommand } from "./adapters.ts";
import { AcpTransport } from "./transport/acp-transport.ts";
import {
  parseCapabilities,
  CLIENT_CAPABILITIES,
  type Capabilities,
} from "./capabilities.ts";
import { parseConfigOptions, type ConfigOptions } from "./config-options.ts";
import { extractChunkText, toActivityEvent } from "./updates.ts";
import { NotConnectedError } from "./errors.ts";
import { noopLogger, type Logger } from "./logger.ts";
import type { AgentClient, InterruptOptions } from "./agent-client.ts";
import type {
  PromptResult,
  PromptHandlers,
  PermissionRequest,
  PermissionOutcome,
  Attachment,
  SessionListPage,
} from "./types.ts";

export interface AcpClientConfig {
  /** How to launch the agent binary. */
  adapter: Adapter;
  /** Prefix merged before the adapter command, e.g. ["docker","exec","-i","<ctr>"]. */
  execPrefix?: string[];
  /** Extra env vars injected at spawn time (never sent over the protocol). */
  env?: Record<string, string>;
  /** Agent workspace — passed to session/new. Also the spawn cwd unless using docker exec. */
  cwd?: string;
  /** Resume this session id on connect() (falls back to a new session on failure). */
  sessionId?: string;
  /** Fallback when a prompt has no onPermissionRequest handler. Default "cancel". */
  defaultPermission?: "approve" | "cancel";
  /** Identification sent in initialize. */
  clientInfo?: { name: string; title?: string; version?: string };
  /** Diagnostics sink. Omit for a silent library. */
  logger?: Logger;
}

export interface StartSessionOptions {
  /** Resume this session (falls back to a new one on failure). Defaults to config.sessionId. */
  sessionId?: string;
  /** MCP servers bound at session creation. */
  mcpServers?: schema.McpServer[];
}

export interface ListSessionsOptions {
  /** Filter by working directory. Defaults to config.cwd. */
  cwd?: string;
  /** Pagination cursor from a previous page's nextCursor. */
  cursor?: string;
}

export interface ConnectResult {
  sessionId: string;
  /** true = resumed an existing session; false = started fresh (incl. resume fallback). */
  resumed: boolean;
}

export interface SwitchSessionOptions {
  /** MCP servers bound while loading/resuming/forking the target session. */
  mcpServers?: schema.McpServer[];
  /** Additional absolute workspace roots to activate for the target session. */
  additionalDirectories?: string[];
  /** Raw session updates emitted while switching sessions, e.g. session/load replay. */
  onUpdate?: (notification: unknown) => void;
}

interface QueueItem {
  text: string;
  handlers?: PromptHandlers;
  attachments?: Attachment[];
  resolve: (r: PromptResult) => void;
  reject: (e: unknown) => void;
}

export class AcpClient implements AgentClient {
  private transport: AcpTransport | null = null;
  private _capabilities: Capabilities | null = null;
  private _configOptions: ConfigOptions = new Map();
  private _sessionId: string | null = null;

  // Per-turn streaming state (only the in-flight turn).
  private active: {
    chunks: string[];
    handlers?: PromptHandlers;
    cancelled: boolean;
  } | null = null;

  // Session switch replay state (session/load may stream previous conversation history).
  private replay: {
    sessionId: string;
    onUpdate?: (notification: unknown) => void;
  } | null = null;

  // Serialized prompt queue.
  private queue: QueueItem[] = [];
  private pumping = false;

  private readonly log: Logger;

  constructor(private config: AcpClientConfig) {
    this.log = config.logger ?? noopLogger;
  }

  // --- introspection (populated by connect) -------------------------------------

  get capabilities(): Capabilities {
    if (!this._capabilities) throw new NotConnectedError();
    return this._capabilities;
  }
  get configOptions(): ConfigOptions {
    return this._configOptions;
  }
  get currentSessionId(): string | null {
    return this._sessionId;
  }
  /** True once connect() has spawned + initialized (a session may not exist yet). */
  get isConnected(): boolean {
    return this.transport !== null;
  }
  /** True once a session has been created or loaded. */
  get hasSession(): boolean {
    return this._sessionId !== null;
  }

  // --- lifecycle ----------------------------------------------------------------

  /**
   * Spawn the agent and initialize the connection. Populates `capabilities`. Does NOT
   * create a session — call startSession() (or just prompt(), which lazily starts one),
   * or listSessions() to pick an existing one first.
   */
  async connect(): Promise<Capabilities> {
    if (this.transport) return this.capabilities;

    const command = buildSpawnCommand(this.config.adapter, this.config.execPrefix);
    const isDockerExec = command[0] === "docker";

    this.log.info("connect", { command, dockerExec: isDockerExec });

    const transport = new AcpTransport({
      command,
      // docker exec resolves paths inside the container's namespace — don't pass a host cwd.
      cwd: isDockerExec ? undefined : this.config.cwd,
      env: this.config.env,
      onUpdate: (n) => this.handleUpdate(n),
      onPermissionRequest: (p) => this.handlePermission(p),
      onStderr: (line) => this.log.debug("agent_stderr", { line }),
      onCrash: (code) => {
        this.transport = null;
        this._sessionId = null;
        this.log.error("process_exit", { code });
      },
    });
    await transport.start();
    this.transport = transport;

    const init = await transport.raceExit(
      transport.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES as unknown as schema.ClientCapabilities,
        clientInfo: this.config.clientInfo ?? {
          name: "acp-lib",
          title: "ACP Lib",
          version: "0.1.0",
        },
      } as schema.InitializeRequest),
    );
    this._capabilities = parseCapabilities(init);
    this.log.info("initialized", {
      agent: this._capabilities.agentInfo?.name,
      protocolVersion: this._capabilities.protocolVersion,
      loadSession: this._capabilities.agent.loadSession,
    });
    this.log.debug("initialize_response", { response: init });
    return this._capabilities;
  }

  /**
   * Create a new session, or resume one (sessionId from the option or config). On resume
   * failure, falls back to a new session. Populates `configOptions`.
   */
  async startSession(options: StartSessionOptions = {}): Promise<ConnectResult> {
    const transport = this.requireTransport();
    const mcpServers = options.mcpServers ?? [];
    const cwd = this.config.cwd ?? process.cwd();
    const resumeId = options.sessionId ?? this.config.sessionId;

    let resumed = false;
    let sessionId: string;

    if (resumeId && this.capabilities.agent.loadSession) {
      try {
        await transport.loadSession({ sessionId: resumeId, cwd, mcpServers } as schema.LoadSessionRequest);
        sessionId = resumeId;
        resumed = true;
        this.log.info("session_loaded", { sessionId });
      } catch (err) {
        this.log.warn("session_load_failed", { sessionId: resumeId, error: String(err) });
        sessionId = await this.newSessionInternal(transport, cwd, mcpServers);
      }
    } else {
      sessionId = await this.newSessionInternal(transport, cwd, mcpServers);
    }

    this._sessionId = sessionId;
    return { sessionId, resumed };
  }

  /** Load an existing session and replay its history if the agent supports session/load. */
  async loadSession(
    sessionId: string,
    options: SwitchSessionOptions = {},
  ): Promise<ConnectResult> {
    const transport = this.requireTransport();
    if (!this.capabilities.agent.loadSession) {
      throw new Error("agent does not advertise session/load (loadSession)");
    }
    this.replay = { sessionId, onUpdate: options.onUpdate };
    let res: schema.LoadSessionResponse;
    try {
      res = await transport.loadSession({
        sessionId,
        cwd: this.config.cwd ?? process.cwd(),
        mcpServers: options.mcpServers ?? [],
        additionalDirectories: options.additionalDirectories,
      } as schema.LoadSessionRequest);
    } finally {
      this.replay = null;
    }
    this._sessionId = sessionId;
    this._configOptions = parseConfigOptions(res.configOptions);
    this.log.info("session_loaded", {
      sessionId,
      configOptions: [...this._configOptions.keys()],
    });
    this.log.debug("session_load_response", { response: res });
    return { sessionId, resumed: true };
  }

  /** Resume an existing session without replaying history, when advertised by the agent. */
  async resumeSession(
    sessionId: string,
    options: SwitchSessionOptions = {},
  ): Promise<ConnectResult> {
    const transport = this.requireTransport();
    if (!this.capabilities.agent.sessionCapabilities.resume) {
      throw new Error("agent does not advertise session/resume (sessionCapabilities.resume)");
    }
    this.replay = { sessionId, onUpdate: options.onUpdate };
    let res: schema.ResumeSessionResponse;
    try {
      res = await transport.resumeSession({
        sessionId,
        cwd: this.config.cwd ?? process.cwd(),
        mcpServers: options.mcpServers ?? [],
        additionalDirectories: options.additionalDirectories,
      } as schema.ResumeSessionRequest);
    } finally {
      this.replay = null;
    }
    this._sessionId = sessionId;
    this._configOptions = parseConfigOptions(res.configOptions);
    this.log.info("session_resumed", {
      sessionId,
      configOptions: [...this._configOptions.keys()],
    });
    this.log.debug("session_resume_response", { response: res });
    return { sessionId, resumed: true };
  }

  /** Fork an existing session and switch this client to the newly-created fork. */
  async forkSession(
    sessionId: string,
    options: SwitchSessionOptions = {},
  ): Promise<ConnectResult> {
    const transport = this.requireTransport();
    if (!this.capabilities.agent.sessionCapabilities.fork) {
      throw new Error("agent does not advertise session/fork (sessionCapabilities.fork)");
    }
    this.replay = { sessionId, onUpdate: options.onUpdate };
    let res: schema.ForkSessionResponse;
    try {
      res = await transport.forkSession({
        sessionId,
        cwd: this.config.cwd ?? process.cwd(),
        mcpServers: options.mcpServers ?? [],
        additionalDirectories: options.additionalDirectories,
      } as schema.ForkSessionRequest);
    } finally {
      this.replay = null;
    }
    this._sessionId = res.sessionId;
    this._configOptions = parseConfigOptions(res.configOptions);
    this.log.info("session_forked", {
      fromSessionId: sessionId,
      sessionId: res.sessionId,
      configOptions: [...this._configOptions.keys()],
    });
    this.log.debug("session_fork_response", { response: res });
    return { sessionId: res.sessionId, resumed: false };
  }

  /**
   * Ask the AGENT for its sessions (authoritative). Gated by sessionCapabilities.list.
   * Requires connect() but NOT a created session — use it to pick one before starting.
   */
  async listSessions(options: ListSessionsOptions = {}): Promise<SessionListPage> {
    const transport = this.requireTransport();
    if (!this.capabilities.agent.sessionCapabilities.list) {
      throw new Error("agent does not advertise session/list (sessionCapabilities.list)");
    }
    const res = await transport.listSessions({
      cwd: options.cwd ?? this.config.cwd ?? null,
      cursor: options.cursor ?? null,
    } as schema.ListSessionsRequest);
    this.log.debug("list_sessions_response", { response: res });
    return {
      sessions: (res.sessions ?? []).map((s) => {
        const e = s as Record<string, any>;
        return {
          sessionId: e.sessionId,
          cwd: e.cwd,
          title: e.title ?? undefined,
          updatedAt: e.updatedAt ?? undefined,
        };
      }),
      nextCursor: (res as Record<string, any>).nextCursor ?? undefined,
    };
  }

  private async newSessionInternal(
    transport: AcpTransport,
    cwd: string,
    mcpServers: schema.McpServer[],
  ): Promise<string> {
    const res = await transport.newSession({ cwd, mcpServers } as schema.NewSessionRequest);
    this._configOptions = parseConfigOptions(res.configOptions);
    this.log.info("session_new", {
      sessionId: res.sessionId,
      configOptions: [...this._configOptions.keys()],
    });
    this.log.debug("session_new_response", { response: res });
    return res.sessionId;
  }

  private requireTransport(): AcpTransport {
    if (!this.transport) throw new NotConnectedError();
    return this.transport;
  }

  /** Lazily ensure a session exists (used by prompt()). */
  private async ensureSession(): Promise<void> {
    if (!this._sessionId) await this.startSession();
  }

  async stop(): Promise<void> {
    const t = this.transport;
    this.transport = null;
    this._sessionId = null;
    if (t) await t.stop();
    this.log.info("stopped", {});
  }

  // --- prompting ----------------------------------------------------------------

  prompt(
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
    if (!this.transport) throw new NotConnectedError();
    await this.ensureSession(); // lazily create a session on first prompt

    const contentBlocks: schema.ContentBlock[] = [];
    if (item.text) contentBlocks.push({ type: "text", text: item.text });
    for (const att of item.attachments ?? []) {
      contentBlocks.push({
        type: "image",
        data: Buffer.from(att.data).toString("base64"),
        mimeType: att.mimeType,
      } as schema.ContentBlock);
    }
    if (contentBlocks.length === 0) contentBlocks.push({ type: "text", text: "" });

    this.active = { chunks: [], handlers: item.handlers, cancelled: false };
    const t0 = Date.now();
    this.log.debug("prompt_start", { chars: item.text.length });
    this.log.debug("prompt_request", { sessionId: this._sessionId, prompt: contentBlocks });
    try {
      const res = await this.transport.prompt({
        sessionId: this._sessionId,
        prompt: contentBlocks,
      } as schema.PromptRequest);
      this.log.debug("prompt_response", { response: res });

      const cancelled = this.active.cancelled;
      const text = this.active.chunks.join("");
      this.log[text.length === 0 && !cancelled ? "warn" : "info"]("prompt_end", {
        stopReason: res.stopReason,
        status: cancelled ? "cancelled" : "completed",
        chars: text.length,
        elapsedMs: Date.now() - t0,
      });
      return {
        text,
        stopReason: res.stopReason,
        status: cancelled ? "cancelled" : "completed",
        usage: (res.usage ?? null) as PromptResult["usage"],
      };
    } finally {
      this.active = null;
    }
  }

  interrupt(options: InterruptOptions = {}): void {
    if (options.clearQueue) {
      const dropped = this.queue.splice(0);
      for (const item of dropped) {
        item.resolve({ text: "", stopReason: "cancelled", status: "cancelled", usage: null });
      }
    }
    if (this.active && this.transport && this._sessionId) {
      this.active.cancelled = true;
      // ACP baseline: session/cancel. The in-flight prompt() then resolves naturally.
      void this.transport.cancel({ sessionId: this._sessionId } as schema.CancelNotification);
    }
  }

  // --- config -------------------------------------------------------------------

  async setConfig(configId: string, value: unknown): Promise<void> {
    if (!this.transport || !this._sessionId) throw new NotConnectedError();
    const existing = this._configOptions.get(configId);
    const res = await this.transport.setSessionConfigOption({
      sessionId: this._sessionId,
      configId,
      ...(existing?.type === "boolean" ? { type: "boolean" } : {}),
      value,
    } as unknown as schema.SetSessionConfigOptionRequest);
    this._configOptions = parseConfigOptions(res.configOptions);
  }

  // --- internal handlers --------------------------------------------------------

  private handleUpdate(notification: schema.SessionNotification): void {
    // Raw protocol trace (logged even outside an active turn, e.g. session/load replay).
    this.log.debug("session_update", { notification });

    const update = notification.update;
    if (
      (update as Record<string, any>).sessionUpdate === "config_option_update" &&
      (!notification.sessionId || notification.sessionId === this._sessionId)
    ) {
      this._configOptions = parseConfigOptions((update as Record<string, any>).configOptions);
    }

    if (!this.active) {
      if (this.replay && (!notification.sessionId || notification.sessionId === this.replay.sessionId)) {
        this.replay.onUpdate?.(notification);
      }
      return;
    }
    if (notification.sessionId && notification.sessionId !== this._sessionId) return;

    const text = extractChunkText(update);
    if (text) {
      this.active.chunks.push(text);
      this.active.handlers?.onChunk?.(text);
    }
    const activity = toActivityEvent(update);
    if (activity) this.active.handlers?.onActivity?.(activity);
  }

  private async handlePermission(
    params: schema.RequestPermissionRequest,
  ): Promise<schema.RequestPermissionResponse> {
    this.log.debug("permission_request", { request: params });
    const handler = this.active?.handlers?.onPermissionRequest;
    const request = toPermissionRequest(params);

    let outcome: PermissionOutcome;
    if (handler) {
      outcome = await handler(request);
    } else {
      outcome = this.defaultOutcome(request);
    }

    this.log.debug("permission_response", { outcome });
    if (outcome.outcome === "selected") {
      return { outcome: { outcome: "selected", optionId: outcome.optionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  private defaultOutcome(request: PermissionRequest): PermissionOutcome {
    if ((this.config.defaultPermission ?? "cancel") === "approve") {
      const first = request.options[0];
      if (first) return { outcome: "selected", optionId: first.optionId };
    }
    return { outcome: "cancelled" };
  }
}

function toPermissionRequest(
  params: schema.RequestPermissionRequest,
): PermissionRequest {
  const p = params as Record<string, any>;
  return {
    toolCallId: p.toolCall?.toolCallId ?? "",
    title: p.toolCall?.title,
    options: (p.options ?? []).map((o: Record<string, any>) => ({
      optionId: o.optionId,
      name: o.name,
      kind: o.kind,
    })),
    raw: params,
  };
}
