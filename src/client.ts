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

export interface ConnectOptions {
  /** MCP servers bound at session creation. */
  mcpServers?: schema.McpServer[];
}

export interface ConnectResult {
  sessionId: string;
  /** true = resumed an existing session; false = started fresh (incl. resume fallback). */
  resumed: boolean;
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
  get isConnected(): boolean {
    return this.transport !== null && this._sessionId !== null;
  }

  // --- lifecycle ----------------------------------------------------------------

  async connect(options: ConnectOptions = {}): Promise<ConnectResult> {
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

    const mcpServers = options.mcpServers ?? [];
    const cwd = this.config.cwd ?? process.cwd();

    let resumed = false;
    let sessionId: string;

    if (this.config.sessionId && this._capabilities.agent.loadSession) {
      try {
        await transport.loadSession({
          sessionId: this.config.sessionId,
          cwd,
          mcpServers,
        } as schema.LoadSessionRequest);
        sessionId = this.config.sessionId;
        resumed = true;
        this.log.info("session_loaded", { sessionId });
      } catch (err) {
        this.log.warn("session_load_failed", {
          sessionId: this.config.sessionId,
          error: String(err),
        });
        sessionId = await this.startNewSession(transport, cwd, mcpServers);
      }
    } else {
      sessionId = await this.startNewSession(transport, cwd, mcpServers);
    }

    this._sessionId = sessionId;
    return { sessionId, resumed };
  }

  private async startNewSession(
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
    return res.sessionId;
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
    if (!this.transport || !this._sessionId) throw new NotConnectedError();

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
    try {
      const res = await this.transport.prompt({
        sessionId: this._sessionId,
        prompt: contentBlocks,
      } as schema.PromptRequest);

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
    await this.transport.setSessionConfigOption({
      sessionId: this._sessionId,
      configId,
      value,
    } as unknown as schema.SetSessionConfigOptionRequest);
    const existing = this._configOptions.get(configId);
    if (existing) existing.currentValue = value;
  }

  // --- internal handlers --------------------------------------------------------

  private handleUpdate(notification: schema.SessionNotification): void {
    if (!this.active) return;
    if (notification.sessionId && notification.sessionId !== this._sessionId) return;

    const update = notification.update;
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
    const handler = this.active?.handlers?.onPermissionRequest;
    const request = toPermissionRequest(params);

    let outcome: PermissionOutcome;
    if (handler) {
      outcome = await handler(request);
    } else {
      outcome = this.defaultOutcome(request);
    }

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
