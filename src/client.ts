// AcpClient — the core deliverable. Implements the AgentClient output contract and
// adds the rich ACP input surface (capabilities, configOptions, sessions, auth).
//
// Lifecycle (SPEC.md): construct (sync, no spawn) → connect() (spawn + initialize +
// session/new|load) → prompt(). Capabilities and configOptions are populated by
// connect() so callers can inspect them BEFORE prompting.

import type { OutputListener, ProviderOutput } from "./operations/contracts.ts";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import type { Adapter } from "./adapters.ts";
import { AcpTransport } from "./transport/acp-transport.ts";
import { prepareLaunch, type AcpLauncher } from "./launcher.ts";
import {
  parseCapabilities,
  type Capabilities,
  type ClientCapabilities,
  type ClientCapabilityConfig,
} from "./capabilities.ts";
import { parseConfigOptions, type ConfigOptions } from "./config-options.ts";
import { extractResponseChunk, toActivityEvent, toAvailableCommands } from "./updates.ts";
import { ResponseAccumulator } from "./response.ts";
import { normalizeTokenUsage } from "./metering/usage.ts";
import { TerminalRegistry } from "./terminals.ts";
import { readTextFile, writeTextFile } from "./fs-access.ts";
import { ConnectionCancelledError, NotConnectedError, ProcessCrashError } from "./errors.ts";
import { ConnectionAttempts, untilAborted } from "./connection-attempt.ts";
import { resolveClientHandlers, type ResolvedClientHandlers, type AcpClientHandlers } from "./acp-client-handlers.ts";
export type { AcpClientHandlers, FilesystemHandlers } from "./acp-client-handlers.ts";
import { noopLogger, type Logger } from "./logger.ts";
import type { AgentClient, InterruptOptions } from "./agent-client.ts";
import type {
  ActivityEvent,
  PromptResult,
  PromptHandlers,
  PermissionOutcome,
  Attachment,
  SessionListPage,
  InternalSessionCommand,
  ToolContent,
  WireEntry,
} from "./types.ts";
import { promptParts } from "./media/parts.ts";
import { resolveParts } from "./media/store.ts";
import { assertPartCapabilities, attachmentParts, partsToAcp } from "./media/acp.ts";
import { redactMedia } from "./media/redact.ts";
import type { ClientPrompt } from "./agent-client.ts";
import { answerPermissionLevel, ownPermissions, permissionLevel, recordingPermissionHandlers, type PermissionPolicyConfig } from "./permissions/policy.ts";
import { stampAcpPermission } from "./permissions/arrival.ts";
import { toPermissionRequest } from "./permissions/acp.ts";
import { AIR_CLIENT_CAPABILITY_META } from "./provider-notices.ts";

export interface AcpClientConfig extends PermissionPolicyConfig {
  /** How to launch the agent binary. */
  adapter: Adapter;
  /** Runtime-specific launcher for exact ACP/PTY host process preparation. */
  launcher?: AcpLauncher;
  /**
   * Prefix merged before the adapter command, e.g. ["docker","exec","-i","<ctr>"].
   * @deprecated Use launcher.
   */
  execPrefix?: string[];
  /** @deprecated Use launcher and its exact spawnEnv. */
  env?: Record<string, string>;
  /** Exact environment for built-in ACP terminals. */
  terminalEnv?: Record<string, string>;
  /** Workspace visible to the ACP target and sent in session requests. */
  cwd?: string;
  /** Additional workspace roots passed to ACP session creation and loading. */
  additionalDirectories?: string[];
  /** Resume this session id when startSession() is called. */
  sessionId?: string;
  /** Policy when config.sessionId cannot be loaded. Default "new" for compatibility. */
  sessionLoadFailure?: SessionLoadFailure;
  /** Identification sent in initialize. */
  clientInfo?: { name: string; title?: string; version?: string };
  /**
   * What we let the agent do through us: filesystem reads/writes and terminals. All
   * enabled by default. Disabling one stops us advertising it, so the agent falls back
   * to its own implementation instead of calling a method we won't answer.
   * @deprecated Use clientHandlers; when a new handler selection is present it wins.
   */
  clientCapabilities?: ClientCapabilityConfig;
  /**
   * Client-side ACP implementations. Omitted selects the built-in host implementation;
   * false disables implementation and advertisement; custom handlers are advertised.
   */
  clientHandlers?: AcpClientHandlers;
  /** Diagnostics sink. Omit for a silent library. */
  logger?: Logger;
  /**
   * Raw protocol traffic, every line in both directions — the debugging view. Off unless
   * set; a wire log holds everything the agent said, file contents and command output
   * included, so where it goes is the caller's call. `createWireLog()` builds a sink.
   */
  wire?: (entry: WireEntry) => void;
}

export interface StartSessionOptions {
  additionalDirectories?: string[];
  /** Resume this session. Defaults to config.sessionId. */
  sessionId?: string;
  /** What to do when the requested session cannot be loaded. Default config policy, then "new". */
  loadFailure?: SessionLoadFailure;
  /** MCP servers bound at session creation. */
  mcpServers?: schema.McpServer[];
  /**
   * Raw `session/update` notifications of the history a loaded session replays. Without it the replay is
   * dropped: it arrives before the load returns and belongs to no turn.
   */
  onReplayUpdate?: (notification: unknown) => void;
}

export type SessionLoadFailure = "error" | "new";

export interface ListSessionsOptions {
  /** Filter by working directory. Defaults to config.cwd. */
  cwd?: string;
  /** Pagination cursor from a previous page's nextCursor. */
  cursor?: string;
}

/** A recoverable ACP startup refusal on an initialized connection. */
export interface AcpSessionStartFailure {
  /** The adapter's original JSON-RPC error code, when available. */
  readonly rpcCode?: number;
  readonly message: string;
}

export interface ConnectResult {
  sessionId: string;
  /** true = resumed an existing session; false = started fresh (incl. resume fallback). */
  resumed: boolean;
  sessionStartFailure?: AcpSessionStartFailure;
}

export interface SwitchSessionOptions {
  /** MCP servers bound while loading/resuming/forking the target session. */
  mcpServers?: schema.McpServer[];
  /** Additional absolute workspace roots to activate for the target session. */
  additionalDirectories?: string[];
  /** Raw session updates emitted while switching sessions, e.g. session/load replay. */
  onUpdate?: (notification: unknown) => void;
}

interface QueueItem extends ClientPrompt {
  text: string;
  handlers?: PromptHandlers;
  attachments?: Attachment[];
  resolve: (r: PromptResult) => void;
  reject: (e: unknown) => void;
}

export type AvailableCommandsListener = (commands: readonly InternalSessionCommand[]) => void;

/**
 * A raw ACP `usage_update`, with the session it named.
 *
 * Delivered raw rather than as an ActivityEvent because metering needs two things the
 * folded event discards: ACP's absent-versus-null `cost`, and un-coerced counters (the
 * activity projection defaults them to zero).
 */
export type UsageUpdateListener = (update: unknown, sessionId: string | null) => void;

interface CommandTransition {
  previous: readonly InternalSessionCommand[];
  bySession: Map<string, readonly InternalSessionCommand[]>;
}

export class AcpClient implements AgentClient {
  private transport: AcpTransport | null = null;
  private readonly connections = new ConnectionAttempts<Capabilities>();
  private _capabilities: Capabilities | null = null;
  private _configOptions: ConfigOptions = new Map();
  private _availableCommands: readonly InternalSessionCommand[] = Object.freeze([]);
  private readonly availableCommandListeners = new Set<AvailableCommandsListener>();
  private readonly usageUpdateListeners = new Set<UsageUpdateListener>();
  /** The stop in progress; later operations wait on it before reconnecting. */
  private stopPromise: Promise<void> | null = null;
  private readonly disconnectListeners = new Set<() => void>();
  /** Answers `cancelled` to each permission request still waiting on the consumer's handler. */
  private readonly pendingPermissions = new Set<() => void>();
  private readonly outputListeners = new Set<OutputListener>();
  /**
   * Latest usage_update seen, replayed to a late subscriber.
   *
   * Listeners are attached after connect + session/new, so a harness that notifies during
   * startup would otherwise be unobserved. Mirrors how `availableCommands` is cached and
   * re-emitted on attach.
   */
  private lastUsageUpdate: { update: unknown; sessionId: string | null } | null = null;
  private commandTransition: CommandTransition | null = null;
  private _sessionId: string | null = null;

  // Per-turn streaming state (only the in-flight turn).
  private active: {
    response: ResponseAccumulator;
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

  // While authenticating, agent stderr (login URL / device code) is teed here so the
  // caller can show it — auth output almost always arrives on stderr, not the protocol.
  private authStderrSink: ((line: string) => void) | null = null;

  // Terminals the AGENT is driving through us. Null when the capability is disabled.
  private terminals: TerminalRegistry | null = null;

  private readonly log: Logger;
  private readonly clientCapabilities: ClientCapabilities;
  private readonly handlers: ResolvedClientHandlers;

  constructor(private config: AcpClientConfig) {
    this.config = { ...config, permissions: ownPermissions(config.permissions) };
    this.log = config.logger ?? noopLogger;
    this.handlers = resolveClientHandlers(config.clientHandlers, config.clientCapabilities);
    this.clientCapabilities = {
      fs: {
        readTextFile: this.handlers.readTextFile !== false,
        writeTextFile: this.handlers.writeTextFile !== false,
      },
      terminal: this.handlers.terminal !== false,
      // Ask adapters that speak the AIR extension (codex-acp, claude-agent-acp) to report retries,
      // warnings and failures as typed session failures; read in provider-notices.ts.
      _meta: { ...AIR_CLIENT_CAPABILITY_META },
    };
  }

  // --- introspection (populated by connect) -------------------------------------

  get capabilities(): Capabilities {
    if (!this._capabilities) throw new NotConnectedError();
    return this._capabilities;
  }
  get configOptions(): ConfigOptions {
    return this._configOptions;
  }
  /** Auth methods the agent advertised. Empty does NOT mean authenticated (state is opaque). */
  get authMethods(): Capabilities["authMethods"] {
    return this._capabilities?.authMethods ?? [];
  }
  /** Slash commands the active harness exposes (from available_commands_update). */
  get availableCommands(): readonly InternalSessionCommand[] {
    return this._availableCommands;
  }
  /** Observe future command-set changes. Read availableCommands first for the current snapshot. */
  subscribeAvailableCommands(listener: AvailableCommandsListener): () => void {
    this.availableCommandListeners.add(listener);
    return () => this.availableCommandListeners.delete(listener);
  }
  /**
   * Observe `usage_update` notifications — context window and provider cost.
   *
   * Session-scoped rather than per-turn: ACP gives no ordering guarantee between a
   * prompt response and the usage update describing it, so an update can arrive well
   * after the turn's handlers are gone. Routing these only through PromptHandlers would
   * drop exactly the observations metering needs.
   */
  subscribeUsageUpdate(listener: UsageUpdateListener): () => void {
    this.usageUpdateListeners.add(listener);
    const buffered = this.lastUsageUpdate;
    if (buffered) {
      try {
        listener(buffered.update, buffered.sessionId);
      } catch (err) {
        this.log.warn("usage_update_listener_failed", { error: String(err) });
      }
    }
    return () => this.usageUpdateListeners.delete(listener);
  }
  subscribeDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }
  subscribeOutput(listener: OutputListener): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }
  private notifyDisconnected(): void {
    for (const listener of [...this.disconnectListeners]) {
      try { listener(); } catch (error) { this.log.warn("disconnect_listener_failed", { error: String(error) }); }
    }
  }
  private cancelPendingPermissions(): void {
    for (const cancel of [...this.pendingPermissions]) cancel();
  }
  private emitOutput(output: ProviderOutput): void {
    for (const listener of [...this.outputListeners]) {
      try { listener(output); }
      catch (error) { this.log.warn("output_listener_failed", { error: String(error) }); }
    }
  }
  get currentSessionId(): string | null {
    return this._sessionId;
  }
  get isConnected(): boolean {
    return this.transport?.isConnected ?? false;
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
  connect(): Promise<Capabilities> {
    return this.connections.run("connect", ({ signal }) => this.initialize(signal));
  }

  private async initialize(signal: AbortSignal): Promise<Capabilities> {
    await this.stopPromise;
    signal.throwIfAborted();
    if (this.transport?.isConnected) return this.capabilities;

    const preparing = prepareLaunch("acp", this.config.launcher, this.config);
    const launch = await untilAborted(preparing.then(async prepared => {
      if (signal.aborted) await prepared.dispose?.();
      signal.throwIfAborted();
      return prepared;
    }), signal);
    if (signal.aborted) {
      await launch.dispose?.();
      signal.throwIfAborted();
    }
    const caps = this.clientCapabilities;
    this.terminals = this.handlers.terminal === "builtin"
      ? new TerminalRegistry({
          cwd: this.config.cwd,
          terminalEnv: launch.terminalEnv ?? this.config.terminalEnv,
          logger: this.config.logger,
        })
      : null;

    const terminalHandlers = this.handlers.terminal === "builtin"
      ? this.terminalHandlers(this.terminals!)
      : this.handlers.terminal || undefined;
    const readHandler = this.handlers.readTextFile === "builtin"
      ? async (p: schema.ReadTextFileRequest) => ({ content: await readTextFile(p) })
      : this.handlers.readTextFile || undefined;
    const writeHandler = this.handlers.writeTextFile === "builtin"
      ? async (p: schema.WriteTextFileRequest) => {
          await writeTextFile(p);
          return {};
        }
      : this.handlers.writeTextFile || undefined;

    const transport = new AcpTransport({
      launch,
      onRequest: (sessionId) => this.emitOutput({ kind: "request", sessionId }),
      onUpdate: (n) => this.handleUpdate(n),
      onPermissionRequest: (p) => this.handlePermission(p),
      onReadTextFile: readHandler,
      onWriteTextFile: writeHandler,
      terminals: terminalHandlers,
      onWire: this.config.wire,
      onStderr: (line) => {
        this.log.debug("agent_stderr", { line });
        this.authStderrSink?.(line);
      },
      onDisconnect: () => {
        if (this.transport !== transport) return;
        this.cancelPendingPermissions();
        this.notifyDisconnected();
      },
      onCrash: (code) => {
        if (this.transport !== transport) return;
        this.cancelPendingPermissions();
        this.terminals?.releaseAll();
        this.terminals = null;
        this.transport = null;
        this._sessionId = null;
        this.commandTransition = null;
        this.setAvailableCommands([]);
        this.log.error("process_exit", { code });
        this.notifyDisconnected();
      },
    });
    try {
      this.log.info("connect", { command: launch.command });
      this.transport = transport;
      await transport.start();
      signal.throwIfAborted();

      const init = await transport.raceExit(
        transport.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: caps as unknown as schema.ClientCapabilities,
          clientInfo: this.config.clientInfo ?? {
            name: "acp-lib",
            title: "ACP Lib",
            version: "0.1.0",
          },
        } as schema.InitializeRequest),
      );
      signal.throwIfAborted();
      transport.throwIfClosed();
      this._capabilities = parseCapabilities(init, caps);
      this.log.info("initialized", {
        agent: this._capabilities.agentInfo?.name,
        protocolVersion: this._capabilities.protocolVersion,
        loadSession: this._capabilities.agent.loadSession,
      });
      this.log.debug("initialize_response", { response: init });
      return this._capabilities;
    } catch (error) {
      if (this.transport === transport) this.transport = null;
      await transport.stop().catch((cleanupError) => {
        this.log.warn("launch_cleanup_failed", { error: String(cleanupError) });
      });
      throw error;
    }
  }

  /**
   * Create a new session, or load one selected by sessionId. `loadFailure` controls
   * whether a failed/unsupported load rejects or explicitly falls back to session/new.
   * Populates `configOptions`.
   */
  async startSession(options: StartSessionOptions = {}): Promise<ConnectResult> {
    const transport = this.requireTransport();
    const mcpServers = options.mcpServers ?? [];
    const additionalDirectories = options.additionalDirectories ?? this.config.additionalDirectories;
    const cwd = this.config.cwd ?? process.cwd();
    const resumeId = options.sessionId ?? this.config.sessionId;
    const loadFailure = options.loadFailure ?? this.config.sessionLoadFailure ?? "new";

    let resumed = false;
    let sessionId: string;

    if (resumeId && this.capabilities.agent.loadSession) {
      try {
        const result = await this.loadSessionInternal(transport, resumeId, {
          mcpServers,
          additionalDirectories,
          ...(options.onReplayUpdate ? { onUpdate: options.onReplayUpdate } : {}),
        });
        sessionId = result.sessionId;
        resumed = result.resumed;
      } catch (err) {
        if (err instanceof ConnectionCancelledError || err instanceof ProcessCrashError) throw err;
        this.log.warn("session_load_failed", { sessionId: resumeId, error: String(err) });
        if (loadFailure === "error") throw err;
        sessionId = await this.newSessionInternal(transport, cwd, mcpServers, additionalDirectories);
      }
    } else if (resumeId && loadFailure === "error") {
      throw new Error("agent does not advertise session/load for the requested internal session");
    } else {
      sessionId = await this.newSessionInternal(transport, cwd, mcpServers, additionalDirectories);
    }

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
    return this.loadSessionInternal(transport, sessionId, options);
  }

  private async loadSessionInternal(
    transport: AcpTransport,
    sessionId: string,
    options: SwitchSessionOptions = {},
  ): Promise<ConnectResult> {
    this.beginCommandTransition();
    this.replay = { sessionId, onUpdate: options.onUpdate };
    let res: schema.LoadSessionResponse;
    try {
      res = await transport.loadSession({
        sessionId,
        cwd: this.config.cwd ?? process.cwd(),
        mcpServers: options.mcpServers ?? [],
        ...this.additionalDirectoriesParam(options.additionalDirectories ?? this.config.additionalDirectories),
      } as schema.LoadSessionRequest);
      if (this.transport !== transport) throw new ConnectionCancelledError();
    } catch (err) {
      this.abortCommandTransition();
      throw err;
    } finally {
      this.replay = null;
    }
    const configOptions = parseConfigOptions(res.configOptions);
    this._sessionId = sessionId;
    this._configOptions = configOptions;
    this.finishCommandTransition(sessionId);
    this.log.info("session_loaded", {
      sessionId,
      configOptions: [...configOptions.keys()],
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
    this.beginCommandTransition();
    this.replay = { sessionId, onUpdate: options.onUpdate };
    let res: schema.ResumeSessionResponse;
    try {
      res = await transport.resumeSession({
        sessionId,
        cwd: this.config.cwd ?? process.cwd(),
        mcpServers: options.mcpServers ?? [],
        ...this.additionalDirectoriesParam(options.additionalDirectories ?? this.config.additionalDirectories),
      } as schema.ResumeSessionRequest);
    } catch (err) {
      this.abortCommandTransition();
      throw err;
    } finally {
      this.replay = null;
    }
    this._sessionId = sessionId;
    this.finishCommandTransition(sessionId);
    this._configOptions = parseConfigOptions(res.configOptions);
    this.log.info("session_resumed", {
      sessionId,
      configOptions: [...this._configOptions.keys()],
    });
    this.log.debug("session_resume_response", { response: res });
    return { sessionId, resumed: true };
  }

  /**
   * Ask the agent to delete a session it holds (`session/delete`), when advertised. This is the provider's own
   * deletion: it does not touch any local record, and not every provider offers it.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const transport = this.requireTransport();
    if (!this.capabilities.agent.sessionCapabilities.delete) {
      throw new Error("agent does not advertise session/delete (sessionCapabilities.delete)");
    }
    await transport.deleteSession({ sessionId } as schema.DeleteSessionRequest);
    this.log.info("session_deleted", { sessionId });
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
    this.beginCommandTransition();
    this.replay = { sessionId, onUpdate: options.onUpdate };
    let res: schema.ForkSessionResponse;
    try {
      res = await transport.forkSession({
        sessionId,
        cwd: this.config.cwd ?? process.cwd(),
        mcpServers: options.mcpServers ?? [],
        ...this.additionalDirectoriesParam(options.additionalDirectories ?? this.config.additionalDirectories),
      } as schema.ForkSessionRequest);
    } catch (err) {
      this.abortCommandTransition();
      throw err;
    } finally {
      this.replay = null;
    }
    this._sessionId = res.sessionId;
    this.finishCommandTransition(res.sessionId);
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
    // Send cwd/cursor ONLY when set. An explicit `cwd: null` is a filter some agents read
    // as "sessions with no cwd" → empty; omitting it means "no filter" (all sessions).
    const params: Record<string, unknown> = {};
    const cwd = options.cwd ?? this.config.cwd;
    if (cwd) params.cwd = cwd;
    if (options.cursor) params.cursor = options.cursor;
    const res = await transport.listSessions(params as schema.ListSessionsRequest);
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

  /**
   * Authenticate the CONNECTION with one of the advertised methods. Connection-level, so
   * it works with or without a session. Auth state is opaque (an agent may answer ok and
   * still be unauthenticated), so this never throws on "wrong" — only on transport errors.
   * `onOutput` receives the agent's stderr during the call (login URL / device code).
   */
  async authenticate(
    methodId: string,
    handlers: { onOutput?: (line: string) => void } = {},
  ): Promise<schema.AuthenticateResponse> {
    const transport = this.requireTransport();
    this.log.info("authenticate", { methodId });
    this.authStderrSink = handlers.onOutput ?? null;
    try {
      const res = await transport.authenticate({ methodId } as schema.AuthenticateRequest);
      this.log.debug("authenticate_response", { response: res });
      return res;
    } finally {
      this.authStderrSink = null;
    }
  }

  /** Force a brand-new session, ignoring config.sessionId. Useful after authenticating. */
  async newSession(
    options: { mcpServers?: schema.McpServer[]; additionalDirectories?: string[] } = {},
  ): Promise<ConnectResult> {
    const transport = this.requireTransport();
    const cwd = this.config.cwd ?? process.cwd();
    const additionalDirectories = options.additionalDirectories ?? this.config.additionalDirectories;
    const sessionId = await this.newSessionInternal(transport, cwd, options.mcpServers ?? [], additionalDirectories);
    return { sessionId, resumed: false };
  }

  /**
   * ACP only allows `additionalDirectories` when the agent advertises it. Sending it anyway can make the
   * agent refuse the whole session request (Grok answers "Invalid params"), so unadvertised directories
   * are left out, with a warning: the agent then sees only its working directory.
   */
  private additionalDirectoriesParam(directories: string[] | undefined): { additionalDirectories?: string[] } {
    if (!directories?.length) return {};
    if (this._capabilities?.agent.sessionCapabilities.additionalDirectories) return { additionalDirectories: directories };
    this.log.warn("additional_directories_unsupported", { directories: directories.length });
    return {};
  }

  private async newSessionInternal(
    transport: AcpTransport,
    cwd: string,
    mcpServers: schema.McpServer[],
    additionalDirectories?: string[],
  ): Promise<string> {
    this.beginCommandTransition();
    let res: schema.NewSessionResponse;
    try {
      res = await transport.newSession({
        cwd,
        mcpServers,
        ...this.additionalDirectoriesParam(additionalDirectories),
      } as schema.NewSessionRequest);
      if (this.transport !== transport) throw new ConnectionCancelledError();
    } catch (err) {
      this.abortCommandTransition();
      throw err;
    }
    this._sessionId = res.sessionId;
    this.finishCommandTransition(res.sessionId);
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

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.cancelPendingPermissions();
    const connecting = this.connections.cancel();
    const t = this.transport;
    this.transport = null;
    this._sessionId = null;
    this.commandTransition = null;
    this.setAvailableCommands([]);
    this.terminals?.releaseAll();
    this.terminals = null;
    if (t) this.notifyDisconnected();
    const pending = Promise.all([connecting, t?.stop()]);
    this.stopPromise = pending.then(() => undefined).finally(() => {
      this.stopPromise = null;
      this.log.info("stopped", {});
    });
    return this.stopPromise;
  }

  /** Adapt the registry to the transport's async handler shape. */
  private terminalHandlers(registry: TerminalRegistry) {
    return {
      create: async (p: schema.CreateTerminalRequest) => ({
        terminalId: registry.create({ command: p.command, args: p.args, cwd: p.cwd, env: p.env, outputByteLimit: p.outputByteLimit }),
      }),
      output: async (p: schema.TerminalOutputRequest) => {
        const { output, truncated, exitStatus } = registry.output(p.terminalId);
        return { output, truncated, exitStatus };
      },
      waitForExit: async (p: schema.WaitForTerminalExitRequest) =>
        registry.waitForExit(p.terminalId),
      kill: async (p: schema.KillTerminalRequest) => registry.kill(p.terminalId),
      release: async (p: schema.ReleaseTerminalRequest) => registry.release(p.terminalId),
    };
  }

  // --- prompting ----------------------------------------------------------------

  prompt(
    input: string | ClientPrompt,
    handlers?: PromptHandlers,
    attachments?: Attachment[],
  ): Promise<PromptResult> {
    // The positional form is the compatibility signature; the object form can carry parts.
    const prompt: ClientPrompt = typeof input === "string"
      ? { text: input, handlers, attachments }
      : { ...input, parts: promptParts(input) };
    return new Promise<PromptResult>((resolve, reject) => {
      this.queue.push({ ...prompt, text: prompt.text ?? "", resolve, reject });
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

    const capabilities = this._capabilities?.agent.promptCapabilities;
    const parts = await resolveParts([
      ...(item.parts ?? (item.text ? [{ kind: "text" as const, text: item.text }] : [])),
      ...attachmentParts(item.attachments),
    ], { cwd: this.config.cwd ?? process.cwd(), capabilities });
    assertPartCapabilities(parts, capabilities);
    const contentBlocks = partsToAcp(parts);
    if (contentBlocks.length === 0) contentBlocks.push({ type: "text", text: "" });

    this.active = {
      response: new ResponseAccumulator(),
      handlers: item.handlers,
      cancelled: false,
    };
    const t0 = Date.now();
    this.log.debug("prompt_start", { chars: item.text.length });
    this.log.debug("prompt_request", { sessionId: this._sessionId, prompt: redactMedia(contentBlocks) });
    try {
      const res = await this.transport.prompt({
        sessionId: this._sessionId,
        prompt: contentBlocks,
      } as schema.PromptRequest);
      this.log.debug("prompt_response", { response: res });

      // What the provider reported, not what we asked for: a cancel can lose the race with a normal
      // ending, and the turn is then complete, not cancelled.
      const cancelled = res.stopReason === "cancelled";
      const text = this.active.response.text;
      const messages = this.active.response.snapshot();
      // ACP usage is optional and experimental: validate rather than cast. An
      // unavailable report is logged and surfaced as null — never zero-filled.
      const usage = normalizeTokenUsage(res.usage);
      if (!usage.ok) this.log.debug("prompt_usage_unavailable", { reason: usage.reason });
      this.log[text.length === 0 && !cancelled ? "warn" : "info"]("prompt_end", {
        stopReason: res.stopReason,
        status: cancelled ? "cancelled" : "completed",
        chars: text.length,
        elapsedMs: Date.now() - t0,
      });
      return {
        text,
        messages,
        stopReason: res.stopReason,
        status: cancelled ? "cancelled" : "completed",
        usage: usage.ok ? usage.usage : null,
      };
    } finally {
      this.cancelPendingPermissions();
      this.active = null;
    }
  }

  interrupt(options: InterruptOptions = {}): void {
    this.cancelPendingPermissions();
    if (options.clearQueue) {
      const dropped = this.queue.splice(0);
      for (const item of dropped) {
        item.resolve({
          text: "",
          messages: Object.freeze([]),
          stopReason: "cancelled",
          status: "cancelled",
          usage: null,
        });
      }
    }
    if (this.active && this.transport && this._sessionId) {
      this.active.cancelled = true;
      // ACP baseline: session/cancel. The in-flight prompt() then resolves naturally.
      try {
        void this.transport.cancel({ sessionId: this._sessionId } as schema.CancelNotification)
          .catch((error) => this.log.warn("cancel_notification_failed", { error: String(error) }));
      } catch (error) { this.log.warn("cancel_notification_failed", { error: String(error) }); }
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

    this.emitOutput({ kind: "update", sessionId: notification.sessionId ?? null,
      activity: toActivityEvent(notification.update) ?? undefined });
    const update = notification.update;
    const kind = (update as Record<string, any>).sessionUpdate;
    if (
      kind === "config_option_update" &&
      (!notification.sessionId || notification.sessionId === this._sessionId)
    ) {
      this._configOptions = parseConfigOptions((update as Record<string, any>).configOptions);
    }
    if (kind === "available_commands_update") {
      const commands = toAvailableCommands((update as Record<string, any>).availableCommands);
      const sessionId = notification.sessionId || "";
      if (this.commandTransition) {
        // A session/new notification can precede its response, so the target id is not
        // necessarily known yet. Buffer by wire session id and commit only the response's
        // selected id when the transition finishes.
        if (sessionId) this.commandTransition.bySession.set(sessionId, commands);
      } else if (!sessionId || sessionId === this._sessionId) {
        this.setAvailableCommands(commands);
      }
    }

    if (kind === "usage_update") {
      // Fired before the active-turn gate: a usage update is session state, and dropping
      // it between turns would lose the context/cost observation entirely.
      this.lastUsageUpdate = { update, sessionId: notification.sessionId ?? null };
      for (const listener of [...this.usageUpdateListeners]) {
        try {
          listener(update, notification.sessionId ?? null);
        } catch (err) {
          this.log.warn("usage_update_listener_failed", { error: String(err) });
        }
      }
    }

    if (!this.active) {
      if (this.replay && (!notification.sessionId || notification.sessionId === this.replay.sessionId)) {
        this.replay.onUpdate?.(notification);
      }
      return;
    }
    if (notification.sessionId && notification.sessionId !== this._sessionId) return;

    this.active.handlers?.onUpdate?.(notification);

    const responseChunk = extractResponseChunk(update);
    if (responseChunk) {
      const chunk = this.active.response.append(responseChunk);
      this.active.handlers?.onResponseChunk?.(chunk);
      this.active.handlers?.onChunk?.(chunk.text);
    }
    const activity = toActivityEvent(update);
    // Text after a new tool call is a new message, even when the agent sends no message ids.
    // Tool updates do not split: a running tool's output can arrive while the agent writes.
    if (activity?.kind === "tool") this.active.response.closeMessage();
    if (activity) this.active.handlers?.onActivity?.(this.enrich(activity));
  }

  /**
   * Fill in terminal output on tool-call content. The agent only sends a `terminalId`
   * (it's polling us for the bytes), so without this the caller sees a tool call it
   * cannot render — the terminal is OURS, and only we can read it.
   */
  private enrich(event: ActivityEvent): ActivityEvent {
    if (event.kind !== "tool" && event.kind !== "tool_update") return event;
    const registry = this.terminals;
    if (!registry || !event.content?.some((c) => c.type === "terminal")) return event;

    const content = event.content.map((c): ToolContent => {
      if (c.type !== "terminal" || !registry.has(c.terminalId)) return c;
      try {
        const snapshot = registry.output(c.terminalId);
        return { ...c, ...snapshot };
      } catch {
        return c; // released between the check and the read
      }
    });
    return { ...event, content };
  }

  private async handlePermission(
    params: schema.RequestPermissionRequest,
  ): Promise<schema.RequestPermissionResponse> {
    const request = stampAcpPermission(toPermissionRequest(params));
    this.log.debug("permission_request", { request: params });
    const handler = this.active?.handlers?.onPermissionRequest;

    const abort = new AbortController();
    let cancel!: () => void;
    const cancelled = new Promise<PermissionOutcome>((resolve) => {
      cancel = () => {
        abort.abort();
        resolve({ outcome: "cancelled" });
      };
    });
    this.pendingPermissions.add(cancel);
    this.emitOutput({ kind: "permission_started", sessionId: params.sessionId });
    let outcome: PermissionOutcome;
    try {
      // A stopped client may still read requests the dying process wrote; they belong to no turn.
      if (this.active?.cancelled || !this.transport) cancel();
      outcome = await Promise.race([
        cancelled,
        Promise.resolve().then(() => {
          if (abort.signal.aborted) return { outcome: "cancelled" as const };
          if (handler && recordingPermissionHandlers.has(handler)) return handler(request, abort.signal);
          return answerPermissionLevel(permissionLevel(request, this.config), request,
            handler && (() => handler(request, abort.signal)), this.config.permissions?.unanswered);
        }),
      ]);
    } finally {
      this.pendingPermissions.delete(cancel);
      this.emitOutput({ kind: "permission_ended", sessionId: params.sessionId });
    }

    this.log.debug("permission_response", { outcome });
    if (outcome.outcome === "selected") {
      return { outcome: { outcome: "selected", optionId: outcome.optionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  private beginCommandTransition(): void {
    // Session operations are serialized by their callers. Preserve the last snapshot so
    // a failed load/new can roll back without leaving an unrelated empty command palette.
    this.commandTransition = { previous: this._availableCommands, bySession: new Map() };
    this.setAvailableCommands([]);
  }

  private finishCommandTransition(sessionId: string): void {
    const transition = this.commandTransition;
    this.commandTransition = null;
    this.setAvailableCommands(transition?.bySession.get(sessionId) ?? []);
  }

  private abortCommandTransition(): void {
    const transition = this.commandTransition;
    this.commandTransition = null;
    if (transition) this.setAvailableCommands(transition.previous);
  }

  private setAvailableCommands(commands: readonly InternalSessionCommand[]): void {
    if (sameAvailableCommands(this._availableCommands, commands)) return;
    // Never expose the mutable transition scratch arrays used internally. Command
    // objects come from toAvailableCommands() frozen; the copy makes the collection itself
    // immutable as well, including the empty snapshots published between sessions.
    const snapshot: readonly InternalSessionCommand[] = Object.freeze([...commands]);
    this._availableCommands = snapshot;
    for (const listener of [...this.availableCommandListeners]) {
      try {
        listener(snapshot);
      } catch (err) {
        this.log.warn("available_commands_listener_failed", { error: String(err) });
      }
    }
  }
}

function sameAvailableCommands(
  a: readonly InternalSessionCommand[],
  b: readonly InternalSessionCommand[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((command, index) => {
    const other = b[index];
    return other != null &&
      command.name === other.name &&
      command.description === other.description &&
      command.input?.kind === other.input?.kind &&
      command.input?.hint === other.input?.hint;
  });
}
