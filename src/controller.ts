import { AcpClient, type AcpClientConfig, type ConnectResult, type SwitchSessionOptions } from "./client.ts";
import type { Adapter } from "./adapters.ts";
import type { AgentClient, InterruptOptions } from "./agent-client.ts";
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

export interface AcpControllerConfig {
  /** Named launch adapters the controller can switch between. */
  adapters: Record<string, Adapter>;
  /** Adapter to use on start(). */
  initialAdapter: string;
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
  | "load"
  | "resume"
  | "fork"
  | "switch";

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
export class AcpController implements AgentClient {
  private current: AcpClient | null = null;
  private adapterId: string;

  constructor(private readonly config: AcpControllerConfig) {
    this.adapterId = config.initialAdapter;
    this.requireAdapter(this.adapterId);
  }

  get currentAdapterId(): string {
    return this.adapterId;
  }

  get currentClient(): AcpClient {
    return this.requireCurrent();
  }

  get currentSessionId(): string | null {
    return this.current?.currentSessionId ?? null;
  }

  get capabilities(): Capabilities {
    return this.requireCurrent().capabilities;
  }

  get configOptions(): ConfigOptions {
    return this.requireCurrent().configOptions;
  }

  get adapterIds(): string[] {
    return Object.keys(this.config.adapters);
  }

  hasAdapter(adapterId: string): boolean {
    return Object.hasOwn(this.config.adapters, adapterId);
  }

  async start(): Promise<ConnectResult> {
    if (this.current) {
      return { sessionId: this.current.currentSessionId ?? "", resumed: this.current.hasSession };
    }
    const client = this.createClient(this.adapterId, this.config.sessionId);
    let result: ConnectResult;
    try {
      await client.connect();
      result = await client.startSession();
    } catch (err) {
      await client.stop();
      throw err;
    }
    this.current = client;
    return result;
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

  async stop(): Promise<void> {
    const client = this.current;
    this.current = null;
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
        sessionId: previous.currentSessionId ?? "",
        resumed: previous.hasSession,
      };
    }

    const next = this.createClient(adapterId);
    let started: ConnectResult;
    try {
      await next.connect();
      started = await next.startSession();
    } catch (err) {
      await next.stop();
      throw err;
    }

    this.current = next;
    this.adapterId = adapterId;
    await previous.stop();
    return { ...started, adapterId, previousAdapterId };
  }

  listSessions(): Promise<SessionListPage> {
    return this.requireCurrent().listSessions();
  }

  loadSession(sessionId: string, options: SwitchSessionOptions = {}): Promise<ConnectResult> {
    return this.requireCurrent().loadSession(sessionId, options);
  }

  resumeSession(sessionId: string, options: SwitchSessionOptions = {}): Promise<ConnectResult> {
    return this.requireCurrent().resumeSession(sessionId, options);
  }

  forkSession(sessionId: string, options: SwitchSessionOptions = {}): Promise<ConnectResult> {
    return this.requireCurrent().forkSession(sessionId, options);
  }

  setConfig(configId: string, value: unknown): Promise<void> {
    return this.requireCurrent().setConfig(configId, value);
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
    const client = this.current;
    const capabilities = client ? client.capabilities : null;
    const session = capabilities?.agent.sessionCapabilities;
    return [
      { id: "caps", usage: "/caps", available: Boolean(client) },
      { id: "session", usage: "/session", available: Boolean(client) },
      {
        id: "sessions",
        usage: "/sessions",
        available: session?.list === true,
        unavailableReason: "agent does not support session/list",
      },
      {
        id: "config",
        usage: "/config [CONFIG_ID [VALUE]]",
        available: Boolean(client),
      },
      {
        id: "load",
        usage: "/load SESSION_ID",
        available: capabilities?.agent.loadSession === true,
        unavailableReason: "load not supported by this agent",
      },
      {
        id: "resume",
        usage: "/resume SESSION_ID",
        available: session?.resume === true,
        unavailableReason: "resume not supported by this agent",
      },
      {
        id: "fork",
        usage: "/fork SESSION_ID",
        available: session?.fork === true,
        unavailableReason: "fork not supported by this agent",
      },
      {
        id: "switch",
        usage: "/switch ADAPTER",
        available: this.adapterIds.length > 0,
      },
    ];
  }

  private createClient(adapterId: string, sessionId?: string): AcpClient {
    return new AcpClient({
      adapter: this.requireAdapter(adapterId),
      execPrefix: this.config.execPrefix,
      env: this.config.env,
      cwd: this.config.cwd,
      sessionId,
      defaultPermission: this.config.defaultPermission,
      clientInfo: this.config.clientInfo,
      logger: this.config.logger,
    });
  }

  private requireAdapter(adapterId: string): Adapter {
    const adapter = this.config.adapters[adapterId];
    if (!adapter) throw new Error(`unknown adapter: ${adapterId}`);
    return adapter;
  }

  private requireCurrent(): AcpClient {
    if (!this.current) throw new NotConnectedError("AcpController is not started — call start() first");
    return this.current;
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
