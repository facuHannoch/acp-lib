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
  AcpClientHandlers,
  FilesystemHandlers,
} from "./client.ts";

export type { AcpLauncher, PreparedLaunch, LaunchKind } from "./launcher.ts";

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

export {
  AgentSession,
  AgentSessionPromptBlockedError,
  AdapterMismatchError,
  ContinuationUnavailableError,
} from "./agent-session.ts";
export type {
  AgentSessionConfig,
  AgentSessionOpenConfig,
  AgentSessionOpenResult,
  AgentSessionPromptability,
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
  ConfigurationRestoreStatus,
  ConfigurationMismatchResolution,
  ConfigurationMismatchResolutionResult,
  ContinuationAttempt,
  ContinuationReport,
  ContinuationStrategy,
  OpenContinuationOptions,
  TranscriptContinuationBuilder,
  TranscriptContinuationBuilderContext,
  PromptBlocker,
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
export type { TerminalHandlers } from "./transport/acp-transport.ts";

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
export { SessionManager, SessionManagerModeError, mergeSessions } from "./session-manager.ts";
export type { MergedSession, SessionInput, SessionManagerConfig } from "./session-manager.ts";

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
  PersistenceConfigurationError,
} from "./persistence/config.ts";
export type {
  AgentSessionPersistenceOptions,
  AuditLogCapturePolicy,
  AuditLogConfig,
  ManagedSessionPersistenceOptions,
  PersistenceLimits,
  SessionConfigurationPersistenceConfig,
  SessionPersistenceConstraints,
  TranscriptCapturePolicy,
  TranscriptConfig,
  TranscriptPreset,
} from "./persistence/config.ts";
export {
  PersistenceSerializationError,
  checkpointDigest,
  checkpointDigestMatches,
} from "./persistence/integrity.ts";
export type { PersistedMachineCode } from "./persistence/integrity.ts";
export {
  CheckpointValidationError,
  createAgentSessionCheckpoint,
  validateAgentSessionCheckpoint,
} from "./persistence/checkpoint.ts";
export type {
  AgentSessionBoundary,
  AgentSessionCheckpoint,
  AgentSessionCheckpointInput,
  CheckpointIdentityExpectation,
  JsonObject,
  JsonValue,
  PersistedProtocol,
  PersistedSessionConfigSelection,
  SessionConfigurationCheckpoint,
  TransitionKind,
} from "./persistence/checkpoint.ts";
export {
  SessionLogRecordValidationError,
  validateAuditLogRecord,
  validateTranscriptRecord,
} from "./persistence/records.ts";
export type * from "./persistence/records.ts";
export {
  AgentSessionRecordValidationError,
  AgentSessionStoreConflictError,
  SessionMaintenanceInProgressError,
  internalSessionHistoryDigest,
  validateAgentSessionRecord,
} from "./persistence/registry.ts";
export type * from "./persistence/registry.ts";
export {
  AgentSessionRegistryCursorError,
  AgentSessionRegistryError,
  AgentSessionRegistryLockError,
  FileAgentSessionStore,
  MaintenanceOutcomeUnknownError,
} from "./persistence/file-registry-store.ts";
export type {
  FileAgentSessionStoreOptions,
  RegistryRecoveryNotice,
} from "./persistence/file-registry-store.ts";
export {
  FileSessionLogWriter,
  SessionLogAlreadyExistsError,
  SessionLogInUseError,
  SessionLogRecordTooLargeError,
  SessionLogWriteError,
} from "./persistence/session-log-writer.ts";
export type {
  FileSessionLogWriterOptions,
  ResumedTranscriptWriter,
  ResumeTranscriptWriterOptions,
  SessionLogKind,
} from "./persistence/session-log-writer.ts";
export {
  projectAuditEvent,
  projectTranscriptEvent,
} from "./persistence/projection.ts";
export type {
  AuditProjectionContext,
  NormalizedActivityProjection,
  NormalizedPersistenceEvent,
  TranscriptProjectionContext,
} from "./persistence/projection.ts";
export {
  SessionLogTruncationError,
  truncateSessionLogRecord,
} from "./persistence/truncation.ts";
export type { SessionLogTruncationOptions } from "./persistence/truncation.ts";
export {
  EMPTY_HISTORY_DIGEST,
  TranscriptReductionError,
  reduceTranscriptHistory,
  reduceInternalSessionHistory,
  reduceTranscriptState,
} from "./persistence/reducer.ts";
export {
  TranscriptCorruptionError,
  TranscriptIdentityError,
  TranscriptNotFoundError,
  TranscriptUnavailableError,
  scanTranscriptContinuation,
} from "./persistence/transcript-scanner.ts";
export {
  TranscriptPersistenceRuntime,
  TranscriptRuntimeStateError,
} from "./persistence/transcript-runtime.ts";
export type {
  CreateTranscriptRuntimeOptions,
  TranscriptTerminalCheckpointChanges,
} from "./persistence/transcript-runtime.ts";
export { persistenceEventFromActivity } from "./persistence/activity-projection.ts";
export {
  snapshotSessionConfiguration,
  snapshotSessionConfigurationAfterSelection,
  snapshotAcceptedEffectiveConfiguration,
} from "./persistence/configuration-state.ts";
export type {
  SnapshotAcceptedEffectiveConfigurationOptions,
  SnapshotSessionConfigurationAfterSelectionOptions,
  SnapshotSessionConfigurationOptions,
} from "./persistence/configuration-state.ts";
export type {
  TranscriptContinuationScan,
  TranscriptScanExpectation,
} from "./persistence/transcript-scanner.ts";
export type {
  PersistenceRepair,
  SessionRecoveryStatus,
  TranscriptHistoryReduction,
  TranscriptReductionResult,
  TranscriptStructuralRecord,
} from "./persistence/reducer.ts";

export {
  MAX_SCALE,
  EMPTY_MONEY_TOTAL,
  addMoney,
  addToTotal,
  canonicalizeMoney,
  isTotalComplete,
  mergeTotals,
  soleAmount,
  totalOf,
  ratioOf,
  subtractMoney,
  decimalFromNumber,
  isValidMoney,
  rateTokens,
  sumMoneyByCurrency,
} from "./metering/money.ts";
export type { Money, MoneyResult, MoneyTotal, TokenUnitPrice } from "./metering/money.ts";
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
  CostReconciliation,
  MeteringUsageResult,
  OperationMeteringRecord,
  OperationOutcome,
  ProviderIdentitySnapshot,
} from "./metering/record.ts";
export {
  CERTIFIED_INTEGRATIONS,
  OPENCODE_PLUGIN_CERTIFICATION,
  billingRefusalReason,
  certificationFor,
} from "./metering/certification.ts";
export {
  OpencodeMeteringChannel,
  createOpencodeMetering,
  meteringPluginPath,
  writeManagedProfile,
} from "./metering/opencode/index.ts";
export type {
  ChannelHandshake,
  ManagedProfile,
  OpencodeMetering,
  OpencodeMeteringOptions,
  ProviderInference,
} from "./metering/opencode/index.ts";
export type { CertificationRequirements } from "./metering/certification.ts";
export { MeteringEngine, sumInferenceTokens } from "./metering/engine.ts";
export type { InferenceSource, MeteringEngineOptions, OpenOperation } from "./metering/engine.ts";
export {
  activeModel,
  counterInterpretationForAdapter,
  providerIdForAdapter,
  resolveModelReference,
} from "./metering/provider.ts";
export type { CounterInterpretation, ModelReference } from "./metering/provider.ts";
export { baselineMatches, calculateDelta } from "./metering/delta.ts";
export type { DeltaResult } from "./metering/delta.ts";
export { rateDelta, selectSchedule, unpricedUsage } from "./metering/rating.ts";
export type {
  AttributableUsage,
  BillingFacts,
  PricedTokenAmount,
  RatedLineItem,
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
  MeteringStateVersion,
  OperationAccrual,
  StateRestoration,
  UnallocatedUsageAccrual,
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
  pricingCapturedAt,
  unitPriceFor,
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
export { createLiveModelsDevResolver, fetchLiveCatalog } from "./metering/catalog/live.ts";
export type { LiveCatalogOptions } from "./metering/catalog/live.ts";
export {
  MODELS_DEV_SOURCE,
  catalogProviderIds,
  createModelsDevResolver,
  loadPinnedCatalog,
  verifyCatalogIntegrity,
} from "./metering/catalog/index.ts";
export type {
  CatalogEntry,
  CatalogProviderInfo,
  PricingCatalog,
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
