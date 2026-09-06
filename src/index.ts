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
  SessionLoadFailure,
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
  ControllerCommand,
  ControllerCommandId,
  ConfigValueParseResult,
  SetConfigFromStringResult,
} from "./controller.ts";

export { AgentSession } from "./agent-session.ts";
export type {
  AgentSessionConfig,
  TranscriptActivityConfig,
  AgentSessionPhase,
  AgentSessionState,
  AgentSessionEvent,
  AgentSessionNotification,
  AgentSessionListener,
  AgentSessionPromptResult,
  HandoffOptions,
  HandoffResult,
  ProviderSession,
} from "./agent-session.ts";

export type {
  AgentClient,
  InterruptOptions,
  Bridgeable,
  BridgeOptions,
} from "./agent-client.ts";

export { ADAPTERS, buildSpawnCommand } from "./adapters.ts";
export type { Adapter, AdapterPreset } from "./adapters.ts";

export { buildClientCapabilities, CLIENT_CAPABILITIES } from "./capabilities.ts";
export type {
  Capabilities,
  ClientCapabilities,
  ClientCapabilityConfig,
  AgentCapabilities,
  AuthMethod,
} from "./capabilities.ts";

export { TerminalRegistry, UnknownTerminalError } from "./terminals.ts";
export type {
  CreateTerminalParams,
  TerminalOutput,
  TerminalRegistryOptions,
} from "./terminals.ts";

export { extractChunkText, extractResponseChunk, toActivityEvent } from "./updates.ts";

export {
  ActivityAggregator,
  foldRecords,
  foldFrame,
  wireFrames,
  isActivityDelta,
} from "./activity.ts";
export type {
  ActivityAggregatorOptions,
  ActivityDelta,
  ActivityFrame,
  ActivitySnapshot,
  AggregatedRecord,
  ApplyResult,
  EmitReason,
} from "./activity.ts";
export type {
  ConfigOption,
  ConfigOptions,
  ConfigOptionChoice,
} from "./config-options.ts";

export {
  FileSessionStore,
  defaultSessionsDir,
} from "./session-store.ts";
export type { SessionStore, SessionRecord } from "./session-store.ts";
export { SessionManager, mergeSessions } from "./session-manager.ts";
export type { MergedSession, SessionInput } from "./session-manager.ts";

export {
  appendTranscriptLine,
  readActivityRecords,
  readTranscript,
  readTranscriptLines,
  toActivityRecord,
} from "./transcript.ts";
export type {
  ReadTranscriptOptions,
  TranscriptActivityLine,
  TranscriptEntry,
  TranscriptLine,
  TranscriptMessageLine,
  TranscriptMetaLine,
  TranscriptPermissionLine,
  TranscriptRawLine,
  TranscriptHandoffLine,
  TranscriptRole,
} from "./transcript.ts";

export {
  MAX_SCALE,
  addMoney,
  canonicalizeMoney,
  decimalFromNumber,
  isValidMoney,
  rateTokens,
  sumMoneyByCurrency,
} from "./metering/money.ts";
export type { Money, MoneyResult, TokenUnitPrice } from "./metering/money.ts";
export { normalizeTokenUsage } from "./metering/usage.ts";
export {
  ACP_PROVENANCE,
  acpProvenance,
  AgentSessionHandoffError,
  AgentSessionOperationError,
  MeteringPreflightError,
  UNAVAILABLE_PROVENANCE,
} from "./metering/record.ts";
export type {
  AgentSessionMeteringSnapshot,
  MeteredOperationKind,
  MeteringConfig,
  MeteringEnforcement,
  MeteringPricingStatus,
  MeteringProvenance,
  MeteringReconciliation,
  MeteringUsageResult,
  OperationMeteringRecord,
  OperationOutcome,
  ProviderIdentitySnapshot,
} from "./metering/record.ts";
export { MeteringEngine } from "./metering/engine.ts";
export type { MeteringEngineOptions, OpenOperation } from "./metering/engine.ts";
export {
  activeModel,
  counterInterpretationForAdapter,
  providerIdForAdapter,
} from "./metering/provider.ts";
export type { CounterInterpretation } from "./metering/provider.ts";
export { baselineMatches, calculateDelta } from "./metering/delta.ts";
export type { DeltaResult } from "./metering/delta.ts";
export { rateDelta, selectSchedule, unpricedUsage } from "./metering/rating.ts";
export type {
  AttributableUsage,
  BillingFacts,
  PricedTokenAmount,
  RatingResult,
  ScheduleSelection,
} from "./metering/rating.ts";
export {
  METERING_STATE_VERSION,
  accrueOperation,
  accumulateByCurrency,
  emptyMeteringState,
  restoreMeteringState,
} from "./metering/state.ts";
export type {
  AgentSessionMeteringState,
  AggregateUsageTotal,
  CategoryCoverage,
  MeteringBaseline,
  OperationAccrual,
  StateRestoration,
  UnallocatedUsageState,
  UsageCategoryTotal,
  UsageTotals,
} from "./metering/state.ts";
export {
  contextWindowChanged,
  parseContextWindow,
  parseProviderCost,
  providerCostChanged,
} from "./metering/context.ts";
export type {
  ContextWindowStatus,
  ProviderCostSnapshot,
  ProviderCostUpdate,
} from "./metering/context.ts";
export {
  TOKEN_CATEGORIES,
  pricedCategories,
  validatePricingPolicy,
} from "./metering/pricing.ts";
export type {
  CacheInputConvention,
  CategoryApplicability,
  PolicyValidation,
  PricingCondition,
  PricingConfiguration,
  PricingContext,
  PricingPolicy,
  PricingResolver,
  PricingSchedule,
  PricingSource,
  TokenCategory,
} from "./metering/pricing.ts";
export {
  MODELS_DEV_SOURCE,
  catalogProviderIds,
  createModelsDevResolver,
  verifyCatalogIntegrity,
} from "./metering/catalog/index.ts";
export type { UsageNormalization } from "./metering/usage.ts";

export { ProcessCrashError, NotConnectedError, TimeoutError } from "./errors.ts";

export { createWireLog } from "./wire-log.ts";
export type { WireLogOptions } from "./wire-log.ts";

export { noopLogger, createConsoleLogger } from "./logger.ts";
export type { Logger, LogLevel, ConsoleLoggerOptions } from "./logger.ts";

export type {
  PromptResult,
  PromptHandlers,
  ResponseChunk,
  ResponseMessage,
  ActivityEvent,
  ToolActivity,
  ToolUpdateActivity,
  ToolContent,
  ToolLocation,
  TerminalExitStatus,
  ContentBlock,
  PlanEntry,
  PermissionRequest,
  PermissionOutcome,
  PermissionOptionKind,
  TokenUsage,
  /** @deprecated alias of TokenUsage */
  Usage,
  Attachment,
  SessionListEntry,
  SessionListPage,
  InternalSessionCommand,
  InternalSessionCommandInput,
  WireEntry,
} from "./types.ts";
