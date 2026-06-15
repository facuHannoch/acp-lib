// PUBLIC SURFACE of the core ACP library — re-exports only.
// NOTE: this barrel must NOT reference ./degraded or ./parser. Those are separate
// subpath exports (acp-lib/degraded, acp-lib/parser) so importing the core never pulls
// in node-pty / ollama. See SPEC.md "opt-in by design".

export { AcpClient } from "./client.ts";
export type {
  AcpClientConfig,
  StartSessionOptions,
  ListSessionsOptions,
  SwitchSessionOptions,
  ConnectResult,
} from "./client.ts";

export {
  AgentController,
  parseConfigValue,
  parseBoolean,
  parseJsonOrString,
  formatConfigValue,
} from "./controller.ts";
export type {
  AgentControllerConfig,
  AgentMode,
  SwitchAdapterResult,
  ControllerCommand,
  ControllerCommandId,
  ConfigValueParseResult,
  SetConfigFromStringResult,
} from "./controller.ts";

export type { AgentClient, InterruptOptions } from "./agent-client.ts";

export { ADAPTERS, buildSpawnCommand } from "./adapters.ts";
export type { Adapter, AdapterPreset } from "./adapters.ts";

export type {
  Capabilities,
  ClientCapabilities,
  AgentCapabilities,
} from "./capabilities.ts";
export type {
  ConfigOption,
  ConfigOptions,
  ConfigOptionChoice,
} from "./config-options.ts";

export { listSessions, saveSession, deleteSession } from "./sessions.ts";
export type { SessionRecord } from "./sessions.ts";

export { ProcessCrashError, NotConnectedError, TimeoutError } from "./errors.ts";

export { noopLogger, createConsoleLogger } from "./logger.ts";
export type { Logger, LogLevel, ConsoleLoggerOptions } from "./logger.ts";

export type {
  PromptResult,
  PromptHandlers,
  ActivityEvent,
  PlanEntry,
  PermissionRequest,
  PermissionOutcome,
  Usage,
  Attachment,
  SessionListEntry,
  SessionListPage,
} from "./types.ts";
