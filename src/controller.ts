import { AcpClient, type AcpClientConfig, type ConnectResult, type SwitchSessionOptions } from "./client.ts";
import type { Adapter } from "./adapters.ts";
import type { AgentClient, Bridgeable, BridgeOptions, InterruptOptions } from "./agent-client.ts";
import type { Capabilities } from "./capabilities.ts";
import type { ConfigOption, ConfigOptions } from "./config-options.ts";
import type { Logger } from "./logger.ts";
import type {
  Attachment,
  PromptHandlers,
  PromptResult,
  SessionListPage,
} from "./types.ts";
import { NotConnectedError } from "./errors.ts";

/**
 * How the controller talks to the agent. Orthogonal to `adapter` (which agent):
 *   - "normal"   → AcpClient: full ACP JSON-RPC (capabilities, config, sessions).
 *   - "degraded" → PtyClient: scrape an interactive CLI in a pty (no rich surface).
 * Degrading/upgrading swaps the leaf in place, keeping `adapter` fixed.
 */
export type AgentMode = "normal" | "degraded";

export interface AgentControllerConfig {
  /** Named launch adapters the controller can switch between. */
  adapters: Record<string, Adapter>;
  /** Adapter to use on start(). */
  initialAdapter: string;
  /** How to talk to the agent on start(). Default "normal". */
  mode?: AgentMode;
  execPrefix?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Session id to load for the initial adapter only. */
  sessionId?: string;
  defaultPermission?: "approve" | "cancel";
  clientInfo?: AcpClientConfig["clientInfo"];
  logger?: Logger;
}

export interface SwitchAdapterResult extends ConnectResult {
  adapterId: string;
  previousAdapterId: string;
}

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
  | "switch"
  | "bridge";

export interface ControllerCommand {
  id: ControllerCommandId;
  usage: string;
  available: boolean;
  unavailableReason?: string;
}

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
  private current: AgentClient | null = null;
  private acp: AcpClient | null = null;
  private adapterId: string;
  private mode: AgentMode;

  constructor(private readonly config: AgentControllerConfig) {
    this.adapterId = config.initialAdapter;
    this.mode = config.mode ?? "normal";
    this.requireAdapter(this.adapterId);
  }

  get currentAdapterId(): string {
    return this.adapterId;
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

  get adapterIds(): string[] {
    return Object.keys(this.config.adapters);
  }

  hasAdapter(adapterId: string): boolean {
    return Object.hasOwn(this.config.adapters, adapterId);
  }

  async start(): Promise<ConnectResult> {
    if (this.current) {
      return { sessionId: this.currentSessionId ?? "", resumed: this.acp?.hasSession ?? false };
    }
    const brought = await this.bringUp(this.adapterId, this.mode, this.config.sessionId);
    this.current = brought.client;
    this.acp = brought.acp;
    return brought.result;
  }

  prompt(
    text: string,
    handlers?: PromptHandlers,
    attachments?: Attachment[],
  ): Promise<PromptResult> {
    return this.requireCurrent().prompt(text, handlers, attachments);
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
      adapter: this.requireAdapter(this.adapterId),
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
    if (client) await client.stop();
  }

  async switchAdapter(adapterId: string): Promise<SwitchAdapterResult> {
    this.requireAdapter(adapterId);
    const previous = this.requireCurrent();
    const previousAdapterId = this.adapterId;
    if (adapterId === previousAdapterId) {
      return {
        adapterId,
        previousAdapterId,
        sessionId: this.currentSessionId ?? "",
        resumed: this.acp?.hasSession ?? false,
      };
    }

    const brought = await this.bringUp(adapterId, this.mode);
    this.current = brought.client;
    this.acp = brought.acp;
    this.adapterId = adapterId;
    await previous.stop();
    return { ...brought.result, adapterId, previousAdapterId };
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
    const brought = await this.bringUp(this.adapterId, mode);
    this.current = brought.client;
    this.acp = brought.acp;
    this.mode = mode;
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

  /** Force a fresh session (e.g. after /login). */
  newSession(): Promise<ConnectResult> {
    return this.requireAcp().newSession();
  }

  listSessions(): Promise<SessionListPage> {
    return this.requireAcp().listSessions();
  }

  loadSession(sessionId: string, options: SwitchSessionOptions = {}): Promise<ConnectResult> {
    return this.requireAcp().loadSession(sessionId, options);
  }

  resumeSession(sessionId: string, options: SwitchSessionOptions = {}): Promise<ConnectResult> {
    return this.requireAcp().resumeSession(sessionId, options);
  }

  forkSession(sessionId: string, options: SwitchSessionOptions = {}): Promise<ConnectResult> {
    return this.requireAcp().forkSession(sessionId, options);
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
    const capabilities = acp ? acp.capabilities : null;
    const session = capabilities?.agent.sessionCapabilities;
    return [
      { id: "caps", usage: "/caps", available: Boolean(acp), unavailableReason: degradedReason },
      { id: "session", usage: "/session", available: Boolean(this.current) },
      {
        id: "login",
        usage: "/login [METHOD]",
        available: Boolean(acp),
        unavailableReason: degradedReason,
      },
      {
        id: "new",
        usage: "/new",
        available: Boolean(acp),
        unavailableReason: degradedReason,
      },
      {
        id: "sessions",
        usage: "/sessions",
        available: session?.list === true,
        unavailableReason: acp ? "agent does not support session/list" : degradedReason,
      },
      {
        id: "config",
        usage: "/config [CONFIG_ID [VALUE]]",
        available: Boolean(acp),
        unavailableReason: degradedReason,
      },
      {
        id: "load",
        usage: "/load SESSION_ID",
        available: capabilities?.agent.loadSession === true,
        unavailableReason: acp ? "load not supported by this agent" : degradedReason,
      },
      {
        id: "resume",
        usage: "/resume SESSION_ID",
        available: session?.resume === true,
        unavailableReason: acp ? "resume not supported by this agent" : degradedReason,
      },
      {
        id: "fork",
        usage: "/fork SESSION_ID",
        available: session?.fork === true,
        unavailableReason: acp ? "fork not supported by this agent" : degradedReason,
      },
      {
        id: "switch",
        usage: "/switch ADAPTER",
        available: this.adapterIds.length > 0,
      },
      {
        id: "bridge",
        usage: "/bridge",
        available: Boolean(this.current),
      },
    ];
  }

  /**
   * Bring up a fresh leaf for (adapter, mode). normal → AcpClient (connect + new/load
   * session); degraded → PtyClient (spawn interactive CLI). PtyClient is dynamically
   * imported so the normal-mode path never loads the degraded subpath.
   */
  private async bringUp(
    adapterId: string,
    mode: AgentMode,
    sessionId?: string,
  ): Promise<{ client: AgentClient; acp: AcpClient | null; result: ConnectResult }> {
    const adapter = this.requireAdapter(adapterId);
    if (mode === "degraded") {
      const { PtyClient } = await import("./degraded/index.ts");
      const client = new PtyClient({
        adapter,
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
      adapter,
      execPrefix: this.config.execPrefix,
      env: this.config.env,
      cwd: this.config.cwd,
      sessionId,
      defaultPermission: this.config.defaultPermission,
      clientInfo: this.config.clientInfo,
      logger: this.config.logger,
    });
    // connect() is fatal (no connection = nothing to do). startSession() is NOT: an
    // unauthenticated agent may refuse session/new, but we keep the connection up so the
    // user can /login and then create a session. (Auth state is opaque — see SPEC.)
    try {
      await client.connect();
    } catch (err) {
      await client.stop();
      throw err;
    }
    let result: ConnectResult;
    try {
      result = await client.startSession();
    } catch (err) {
      this.config.logger?.warn("session_start_failed", { error: String(err) });
      result = { sessionId: "", resumed: false };
    }
    return { client, acp: client, result };
  }

  private requireAdapter(adapterId: string): Adapter {
    const adapter = this.config.adapters[adapterId];
    if (!adapter) throw new Error(`unknown adapter: ${adapterId}`);
    return adapter;
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
