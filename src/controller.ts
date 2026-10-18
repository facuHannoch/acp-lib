import { ProviderRequestTimeoutError, ForcedStopError } from "./operations/errors.ts";
import type { OutputListener } from "./operations/contracts.ts";
import {
  AcpClient,
  type AcpClientConfig,
  type ConnectResult,
  type SessionLoadFailure,
  type SwitchSessionOptions,
} from "./client.ts";
import type * as schema from "@agentclientprotocol/sdk";
import type { Adapter } from "./adapters.ts";
import type { AgentClient, Bridgeable, BridgeOptions, InterruptOptions } from "./agent-client.ts";
import type { Capabilities } from "./capabilities.ts";
import type { CommandDescriptor } from "./command-descriptors.ts";
import type { ConfigOption, ConfigOptions } from "./config-options.ts";
import type { Logger } from "./logger.ts";
import type { AcpLauncher } from "./launcher.ts";
import type {
  InternalSessionCommand,
  Attachment,
  PromptHandlers,
  PromptResult,
  SessionListPage,
  WireEntry,
} from "./types.ts";
import { NotConnectedError } from "./errors.ts";

const NO_AVAILABLE_COMMANDS: readonly InternalSessionCommand[] = Object.freeze([]);

/**
 * How the controller talks to the agent. Orthogonal to `adapter` (which agent):
 *   - "normal"   → AcpClient: full ACP JSON-RPC (capabilities, config, sessions).
 *   - "degraded" → PtyClient: scrape an interactive CLI in a pty (no rich surface).
 * Degrading/upgrading swaps the leaf in place, keeping `adapter` fixed.
 */
export type AgentMode = "normal" | "degraded";

export interface AgentControllerConfig {
  operationLifecycle?: import("./operations/contracts.ts").OperationLifecycleConfig;
  /** The single adapter this controller drives. Switching adapter = a new AgentSession. */
  adapter: Adapter;
  /** Stable id for the adapter (catalog/display, e.g. "codex"). */
  adapterId: string;
  /** How to talk to the agent on start(). Default "normal". */
  mode?: AgentMode;
  /** Runtime-specific launcher shared by normal ACP and degraded PTY modes. */
  launcher?: AcpLauncher;
  /** @deprecated Use launcher. */
  execPrefix?: string[];
  /** @deprecated Use launcher and its exact spawnEnv. */
  env?: Record<string, string>;
  cwd?: string;
  /** Session id to load on start(). */
  sessionId?: string;
  /** Policy when sessionId cannot be loaded. Default "new" for compatibility. */
  sessionLoadFailure?: SessionLoadFailure;
  /** Receives the history a loaded `sessionId` replays (raw `session/update` notifications). */
  onSessionReplay?: (notification: unknown) => void;
  /** Default MCP servers bound at session creation/switch, unless a call overrides them. */
  mcpServers?: schema.McpServer[];
  defaultPermission?: "approve" | "cancel";
  clientInfo?: AcpClientConfig["clientInfo"];
  /** What we let the agent do through us (terminals, filesystem). All on by default. */
  clientCapabilities?: AcpClientConfig["clientCapabilities"];
  /** Client-side ACP implementations; their presence determines advertisement. */
  clientHandlers?: AcpClientConfig["clientHandlers"];
  logger?: Logger;
  /** Raw protocol traffic for debugging — see `AcpClientConfig.wire`. */
  wire?: (entry: WireEntry) => void;
}

/** @internal Startup observations used by the managed AgentSession coordinator. */
export type AgentControllerStartEvent =
  | { readonly stage: "initialized"; readonly capabilities: Capabilities }
  | {
      readonly stage: "internal_session_acquired";
      readonly internalSessionId: string;
      readonly disposition: "created" | "resumed";
    };

export type ControllerCommandId =
  | "caps"
  | "session"
  | "sessions"
  | "config"
  | "login"
  | "new"
  | "load"
  | "resume"
  | "fork"
  | "bridge"
  | "degrade"
  | "upgrade";

export interface ControllerCommand extends CommandDescriptor<ControllerCommandId> {}

export type ConfigValueParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export interface SetConfigFromStringResult {
  configId: string;
  value: unknown;
  currentValue: unknown;
}

/**
 * Reusable app-level controller over AcpClient.
 *
 * AcpClient remains the one-process/one-session ACP primitive. This controller owns
 * mutable "current client" behavior such as adapter switching and config validation,
 * so CLIs and app UIs do not have to reimplement it.
 */
export class AgentController implements AgentClient {
  // `current` is the universal leaf (prompt/interrupt/stop) — an AcpClient in normal
  // mode, a PtyClient in degraded mode. `acp` is the SAME object only in normal mode,
  // typed for the rich ACP surface; it is null when degraded (that surface genuinely
  // doesn't exist when screen-scraping).
  private readonly forceStopListeners = new Set<() => void>();
  private readonly connectionListeners = new Set<() => void>();
  private detachDisconnect: (() => void) | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private current: AgentClient | null = null;
  private acp: AcpClient | null = null;
  private mode: AgentMode;
  private readonly availableCommandListeners = new Set<
    (commands: readonly InternalSessionCommand[]) => void
  >();
  private detachAvailableCommands: (() => void) | null = null;
  private readonly usageUpdateListeners = new Set<
    (update: unknown, sessionId: string | null) => void
  >();
  private readonly outputListeners = new Set<OutputListener>();
  private detachOutput: (() => void) | null = null;
  private detachUsageUpdates: (() => void) | null = null;

  constructor(private readonly config: AgentControllerConfig) {
    this.mode = config.mode ?? "normal";
  }

  get isConnected(): boolean { return this.current !== null && ((this.current as AgentClient & { isConnected?: boolean }).isConnected ?? true); }
  subscribeConnection(listener: () => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }
  private connectionChanged(): void {
    for (const listener of [...this.connectionListeners]) {
      try { listener(); } catch (error) { this.config.logger?.warn("connection_listener_failed", { error: String(error) }); }
    }
  }
  async reconnect(sessionId: string): Promise<ConnectResult> {
    await this.stopping;
    await this.stop();
    const brought = await this.bringUp(this.mode, sessionId, undefined, "error");
    this.current = brought.client;
    this.acp = brought.acp;
    this.attachAvailableCommandSource();
    if (!brought.result.resumed || brought.result.sessionId !== sessionId) {
      await this.stop();
      throw new Error("provider did not load the requested session");
    }
    return brought.result;
  }

  get cancelGraceMs(): number | undefined { return this.config.adapter.cancelGraceMs; }

  get currentAdapterId(): string {
    return this.config.adapterId;
  }

  /** Whether the controller is talking ACP ("normal") or scraping a pty ("degraded"). */
  get currentMode(): AgentMode {
    return this.mode;
  }

  /** True when the rich ACP surface (capabilities, config, sessions) is available. */
  get isDegraded(): boolean {
    return this.mode === "degraded";
  }

  /** The underlying ACP client. Throws in degraded mode — guard with isDegraded. */
  get currentClient(): AcpClient {
    return this.requireAcp();
  }

  get currentSessionId(): string | null {
    return this.acp?.currentSessionId ?? null;
  }

  get capabilities(): Capabilities {
    return this.requireAcp().capabilities;
  }

  get configOptions(): ConfigOptions {
    return this.acp?.configOptions ?? new Map();
  }

  /** Auth methods the agent advertised (empty in degraded mode or if none). */
  get authMethods(): Capabilities["authMethods"] {
    return this.acp?.authMethods ?? [];
  }

  /** Slash commands the active ACP harness exposes. */
  get availableCommands(): readonly InternalSessionCommand[] {
    return this.acp?.availableCommands ?? NO_AVAILABLE_COMMANDS;
  }

  /** Observe future command-set changes across ACP leaf and mode replacements. */
  subscribeAvailableCommands(
    listener: (commands: readonly InternalSessionCommand[]) => void,
  ): () => void {
    this.availableCommandListeners.add(listener);
    return () => this.availableCommandListeners.delete(listener);
  }

  /**
   * Observe raw ACP `usage_update` notifications (context window, provider cost).
   *
   * Degraded (pty) mode has no ACP notifications, so this simply never fires there.
   */
  subscribeUsageUpdate(listener: (update: unknown, sessionId: string | null) => void): () => void {
    this.usageUpdateListeners.add(listener);
    return () => this.usageUpdateListeners.delete(listener);
  }

  subscribeOutput(listener: OutputListener): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  async start(onProgress?: (event: AgentControllerStartEvent) => void): Promise<ConnectResult> {
    await this.stopping;
    if (this.current && !this.isConnected) await this.stop();
    if (this.current) {
      return { sessionId: this.currentSessionId ?? "", resumed: this.acp?.hasSession ?? false };
    }
    const brought = await this.bringUp(this.mode, this.config.sessionId, onProgress);
    this.current = brought.client;
    this.acp = brought.acp;
    this.attachAvailableCommandSource();
    return brought.result;
  }

  /** Explicitly create a fresh provider thread, ignoring any startup load target. */
  async startFresh(onProgress?: (event: AgentControllerStartEvent) => void): Promise<ConnectResult> {
    await this.stopping;
    if (this.current && !this.isConnected) await this.stop();
    if (this.current) {
      if (!this.acp) throw new Error("fresh provider sessions require ACP normal mode");
      return await this.newSession();
    }
    const brought = await this.bringUp(this.mode, undefined, onProgress);
    this.current = brought.client;
    this.acp = brought.acp;
    this.attachAvailableCommandSource();
    return brought.result;
  }

  prompt(
    text: string,
    handlers?: PromptHandlers,
    attachments?: Attachment[],
  ): Promise<PromptResult> {
    const current = this.requireCurrent();
    let forced!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      forced = () => reject(new ForcedStopError());
      this.forceStopListeners.add(forced);
    });
    try {
      return Promise.race([current.prompt(text, handlers, attachments), interrupted])
        .finally(() => this.forceStopListeners.delete(forced));
    } catch (error) { this.forceStopListeners.delete(forced); throw error; }
  }

  cancel(): void { this.current?.interrupt(); }

  forceStop(): Promise<void> {
    for (const force of [...this.forceStopListeners]) force();
    return this.stop();
  }

  interrupt(options?: InterruptOptions): void {
    this.current?.interrupt(options);
  }

  /**
   * Hand a real terminal to the user. In degraded mode this bridges the LIVE pty (same
   * conversation). In normal (ACP) mode there's no pty, so it spins up an EPHEMERAL
   * interactive pty for the adapter, bridges it, and tears it down — the ACP session is
   * untouched. Useful for tty-auth (login) and as an escape hatch into the native TUI.
   */
  async bridge(options?: BridgeOptions): Promise<void> {
    const current = this.current as Partial<Bridgeable> | null;
    if (this.isDegraded && typeof current?.bridge === "function") {
      await current.bridge(options);
      return;
    }
    const { PtyClient } = await import("./degraded/index.ts");
    const pty = new PtyClient({
      adapter: this.config.adapter,
      launcher: this.config.launcher,
      execPrefix: this.config.execPrefix,
      env: this.config.env,
      cwd: this.config.cwd,
      logger: this.config.logger,
    });
    try {
      await pty.start();
      await pty.bridge(options);
    } finally {
      await pty.stop();
    }
  }

  async stop(): Promise<void> {
    const client = this.current;
    this.current = null;
    this.acp = null;
    this.detachDisconnect?.();
    this.detachDisconnect = null;
    this.connectionChanged();
    this.detachAvailableCommands?.();
    this.detachAvailableCommands = null;
    this.detachUsageUpdates?.();
    this.detachUsageUpdates = null;
    this.detachOutput?.();
    this.detachOutput = null;
    this.emitAvailableCommands(NO_AVAILABLE_COMMANDS);
    if (client) {
      const pending = client.stop();
      this.stopping = pending.then(() => {}, () => {});
      await pending;
    } else {
      await this.stopping;
    }
  }

  /**
   * Degrade to pty or upgrade back to ACP, keeping the adapter fixed. This tears down the
   * current leaf and brings up a fresh one in the new mode (sessions do NOT carry across —
   * the two transports are unrelated). Returns the new leaf's connect result.
   */
  async setMode(mode: AgentMode): Promise<ConnectResult> {
    if (mode === this.mode && this.current) {
      return { sessionId: this.currentSessionId ?? "", resumed: this.acp?.hasSession ?? false };
    }
    const previous = this.current;
    const brought = await this.bringUp(mode);
    this.current = brought.client;
    this.acp = brought.acp;
    this.mode = mode;
    this.attachAvailableCommandSource();
    if (previous) await previous.stop();
    return brought.result;
  }

  /** Authenticate the connection. Available whenever connected over ACP (with or without a session). */
  authenticate(
    methodId: string,
    handlers: { onOutput?: (line: string) => void } = {},
  ): Promise<unknown> {
    return this.requireAcp().authenticate(methodId, handlers);
  }

  /** Force a fresh session (e.g. after /login). mcpServers defaults to config.mcpServers. */
  newSession(options: { mcpServers?: schema.McpServer[] } = {}): Promise<ConnectResult> {
    return this.requireAcp().newSession({
      mcpServers: options.mcpServers ?? this.config.mcpServers,
    });
  }

  listSessions(): Promise<SessionListPage> {
    return this.requireAcp().listSessions();
  }

  loadSession(sessionId: string, options: SwitchSessionOptions = {}): Promise<ConnectResult> {
    return this.requireAcp().loadSession(sessionId, {
      ...options,
      mcpServers: options.mcpServers ?? this.config.mcpServers,
    });
  }

  resumeSession(sessionId: string, options: SwitchSessionOptions = {}): Promise<ConnectResult> {
    return this.requireAcp().resumeSession(sessionId, {
      ...options,
      mcpServers: options.mcpServers ?? this.config.mcpServers,
    });
  }

  forkSession(sessionId: string, options: SwitchSessionOptions = {}): Promise<ConnectResult> {
    return this.requireAcp().forkSession(sessionId, {
      ...options,
      mcpServers: options.mcpServers ?? this.config.mcpServers,
    });
  }

  setConfig(configId: string, value: unknown): Promise<void> {
    return this.requireAcp().setConfig(configId, value);
  }

  getConfig(configId: string): ConfigOption | undefined {
    return this.configOptions.get(configId);
  }

  parseConfigValue(configId: string, rawValue: string): ConfigValueParseResult {
    const option = this.getConfig(configId);
    if (!option) return { ok: false, error: `unknown config: ${configId}` };
    return parseConfigValue(option, rawValue);
  }

  async setConfigFromString(
    configId: string,
    rawValue: string,
  ): Promise<SetConfigFromStringResult> {
    const parsed = this.parseConfigValue(configId, rawValue);
    if (!parsed.ok) throw new Error(parsed.error);
    await this.setConfig(configId, parsed.value);
    return {
      configId,
      value: parsed.value,
      currentValue: this.getConfig(configId)?.currentValue ?? parsed.value,
    };
  }

  getCommands(): ControllerCommand[] {
    // The rich ACP commands are unavailable when degraded — `acp` is null there.
    const acp = this.acp;
    const degradedReason = "unavailable in degraded (pty) mode";
    const acpUnavailableReason = this.current ? degradedReason : "controller is not connected";
    const capabilities = acp ? acp.capabilities : null;
    const session = capabilities?.agent.sessionCapabilities;
    const command = (
      descriptor: Omit<ControllerCommand, "available" | "unavailableReason">,
      available: boolean,
      unavailableReason?: string,
    ): ControllerCommand => ({
      ...descriptor,
      available,
      ...(available || !unavailableReason ? {} : { unavailableReason }),
    });
    return [
      command({
        id: "caps",
        usage: "/caps",
        description: "Show capabilities negotiated with the active ACP harness.",
        arguments: [],
      }, Boolean(acp), acpUnavailableReason),
      command({
        id: "session",
        usage: "/session",
        description: "Show the active provider-thread identity, adapter, and transport mode.",
        arguments: [],
      }, Boolean(this.current), "controller is not connected"),
      {
        id: "login",
        usage: "/login [METHOD]",
        description: "List authentication methods or authenticate through the active ACP harness.",
        arguments: [{ name: "method", description: "Advertised authentication method ID.", required: false }],
        available: Boolean(acp),
        ...(acp ? {} : { unavailableReason: acpUnavailableReason }),
      },
      command({
        id: "new",
        usage: "/new",
        description: "Create a fresh provider thread in the active ACP harness.",
        arguments: [],
      }, Boolean(acp), acpUnavailableReason),
      command({
        id: "sessions",
        usage: "/sessions",
        description: "List provider sessions advertised by the active ACP harness.",
        arguments: [],
      }, session?.list === true, acp ? "agent does not support session/list" : acpUnavailableReason),
      command({
        id: "config",
        usage: "/config [CONFIG_ID [VALUE]]",
        description: "Inspect or change an ACP session configuration option.",
        arguments: [
          { name: "configId", description: "Advertised configuration option ID.", required: false },
          { name: "value", description: "New value for the selected option.", required: false, variadic: true },
        ],
      }, Boolean(acp), acpUnavailableReason),
      command({
        id: "load",
        usage: "/load SESSION_ID",
        description: "Load a provider session by ID.",
        arguments: [{ name: "sessionId", description: "Provider session ID to load.", required: true }],
      }, capabilities?.agent.loadSession === true, acp ? "load not supported by this agent" : acpUnavailableReason),
      command({
        id: "resume",
        usage: "/resume SESSION_ID",
        description: "Resume a provider session by ID.",
        arguments: [{ name: "sessionId", description: "Provider session ID to resume.", required: true }],
      }, session?.resume === true, acp ? "resume not supported by this agent" : acpUnavailableReason),
      command({
        id: "fork",
        usage: "/fork SESSION_ID",
        description: "Fork a provider session into a new provider thread.",
        arguments: [{ name: "sessionId", description: "Provider session ID to fork.", required: true }],
      }, session?.fork === true, acp ? "fork not supported by this agent" : acpUnavailableReason),
      command({
        id: "bridge",
        usage: "/bridge",
        description: "Open the harness's interactive terminal interface.",
        arguments: [],
      }, Boolean(this.current), "controller is not connected"),
      command({
        id: "degrade",
        usage: "/degrade",
        description: "Replace the ACP connection with the adapter's interactive PTY mode.",
        arguments: [],
      }, this.mode !== "degraded" && Boolean(this.config.adapter.ptyCommand),
      this.mode === "degraded" ? "already in degraded mode" : "adapter has no interactive PTY command"),
      command({
        id: "upgrade",
        usage: "/upgrade",
        description: "Replace degraded PTY mode with a fresh ACP connection.",
        arguments: [],
      }, this.mode === "degraded", "already in normal ACP mode"),
    ];
  }

  /**
   * Bring up a fresh leaf for the configured adapter in `mode`. normal → AcpClient
   * (connect + new/load session); degraded → PtyClient (spawn interactive CLI). PtyClient
   * is dynamically imported so the normal-mode path never loads the degraded subpath.
   */
  private async bringUp(
    mode: AgentMode,
    sessionId?: string,
    onProgress?: (event: AgentControllerStartEvent) => void,
    loadFailure = this.config.sessionLoadFailure,
  ): Promise<{ client: AgentClient; acp: AcpClient | null; result: ConnectResult }> {
    const adapter = this.config.adapter;
    if (mode === "degraded") {
      const { PtyClient } = await import("./degraded/index.ts");
      const client = new PtyClient({
        adapter,
        launcher: this.config.launcher,
        execPrefix: this.config.execPrefix,
        env: this.config.env,
        cwd: this.config.cwd,
        logger: this.config.logger,
      });
      try {
        await client.start();
      } catch (err) {
        await client.stop();
        throw err;
      }
      return { client, acp: null, result: { sessionId: "", resumed: false } };
    }

    const client = new AcpClient({
      operationLifecycle: this.config.operationLifecycle,
      adapter,
      launcher: this.config.launcher,
      execPrefix: this.config.execPrefix,
      env: this.config.env,
      cwd: this.config.cwd,
      sessionId,
      sessionLoadFailure: loadFailure,
      defaultPermission: this.config.defaultPermission,
      clientInfo: this.config.clientInfo,
      clientCapabilities: this.config.clientCapabilities,
      clientHandlers: this.config.clientHandlers,
      logger: this.config.logger,
      wire: this.config.wire,
    });
    // connect() is fatal (no connection = nothing to do). startSession() is NOT: an
    // unauthenticated agent may refuse session/new, but we keep the connection up so the
    // user can /login and then create a session. (Auth state is opaque — see SPEC.)
    try {
      const capabilities = await client.connect();
      this.reportStartProgress(onProgress, { stage: "initialized", capabilities });
    } catch (err) {
      await client.stop();
      throw err;
    }
    let result: ConnectResult;
    try {
      result = await client.startSession({
        mcpServers: this.config.mcpServers,
        loadFailure: loadFailure,
        ...(this.config.onSessionReplay ? { onReplayUpdate: this.config.onSessionReplay } : {}),
      });
    } catch (err) {
      if ((sessionId && loadFailure === "error") || err instanceof ProviderRequestTimeoutError) {
        await client.stop();
        throw err;
      }
      this.config.logger?.warn("session_start_failed", { error: String(err) });
      result = { sessionId: "", resumed: false };
    }
    if (result.sessionId) {
      this.reportStartProgress(onProgress, {
        stage: "internal_session_acquired",
        internalSessionId: result.sessionId,
        disposition: result.resumed ? "resumed" : "created",
      });
    }
    return { client, acp: client, result };
  }

  private reportStartProgress(
    listener: ((event: AgentControllerStartEvent) => void) | undefined,
    event: AgentControllerStartEvent,
  ): void {
    if (!listener) return;
    try {
      listener(event);
    } catch (error) {
      this.config.logger?.warn("controller_start_progress_listener_failed", {
        error: String(error),
      });
    }
  }

  private requireCurrent(): AgentClient {
    if (!this.current) throw new NotConnectedError("AgentController is not started — call start() first");
    return this.current;
  }

  private requireAcp(): AcpClient {
    if (!this.current) throw new NotConnectedError("AgentController is not started — call start() first");
    if (!this.acp) {
      throw new Error("operation requires ACP (normal) mode — the controller is degraded (pty)");
    }
    return this.acp;
  }

  private attachAvailableCommandSource(): void {
    this.detachDisconnect?.();
    this.detachDisconnect = this.acp?.subscribeDisconnect(() => this.connectionChanged()) ?? null;
    this.connectionChanged();
    this.detachOutput?.();
    this.detachOutput = (this.current as (AgentClient & { subscribeOutput?: (listener: OutputListener) => () => void }) | null)?.subscribeOutput?.((output) => {
      for (const listener of [...this.outputListeners]) {
        try { listener(output); }
        catch (error) { this.config.logger?.warn("controller_output_listener_failed", { error: String(error) }); }
      }
    }) ?? null;
    this.detachAvailableCommands?.();
    this.detachAvailableCommands = this.acp?.subscribeAvailableCommands((commands) =>
      this.emitAvailableCommands(commands)) ?? null;
    this.emitAvailableCommands(this.acp?.availableCommands ?? NO_AVAILABLE_COMMANDS);

    this.detachUsageUpdates?.();
    this.detachUsageUpdates =
      this.acp?.subscribeUsageUpdate((update, sessionId) => {
        for (const listener of [...this.usageUpdateListeners]) {
          try {
            listener(update, sessionId);
          } catch (err) {
            this.config.logger?.warn("controller_usage_update_listener_failed", {
              error: String(err),
            });
          }
        }
      }) ?? null;
  }

  private emitAvailableCommands(commands: readonly InternalSessionCommand[]): void {
    for (const listener of [...this.availableCommandListeners]) {
      try {
        listener(commands);
      } catch (err) {
        this.config.logger?.warn("controller_available_commands_listener_failed", {
          error: String(err),
        });
      }
    }
  }
}

export function parseConfigValue(
  option: ConfigOption,
  rawValue: string,
): ConfigValueParseResult {
  switch (option.type) {
    case "boolean": {
      const value = parseBoolean(rawValue);
      if (value == null) return { ok: false, error: `invalid boolean: ${rawValue}` };
      return { ok: true, value };
    }
    case "select": {
      const choice = option.allowedValues?.find((c) => String(c.value) === rawValue);
      if (!choice) {
        const allowed = option.allowedValues?.map((c) => formatConfigValue(c.value)).join(", ") || "(none)";
        return {
          ok: false,
          error: `invalid value "${rawValue}" for ${option.configId}; allowed: ${allowed}`,
        };
      }
      return { ok: true, value: choice.value };
    }
    default:
      return { ok: true, value: parseJsonOrString(rawValue) };
  }
}

export function parseBoolean(value: string): boolean | null {
  switch (value.toLowerCase()) {
    case "true":
    case "on":
    case "yes":
    case "1":
      return true;
    case "false":
    case "off":
    case "no":
    case "0":
      return false;
    default:
      return null;
  }
}

export function parseJsonOrString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function formatConfigValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
