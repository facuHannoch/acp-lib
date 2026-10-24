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
  AGENT_CONVERSATION_ID_PREFIX,
  AGENT_SESSION_ID_PREFIX,
  createAgentConversationId,
  createAgentSessionId,
  isAgentConversationId,
  isAgentSessionId,
  parseAgentConversationId,
  parseAgentSessionId,
} from "./agent-ids.ts";
export type { AgentConversationId, AgentSessionId } from "./agent-ids.ts";
export * from "./observation/index.ts";
export * from "./internal-inference/index.ts";
export * from "./checkpointing/index.ts";
export { conversationTimelineItemId, reconcileConversationTimeline } from "./persistence/timeline-reconcile.ts";
export type { ConversationTimelineItem } from "./persistence/timeline-reconcile.ts";
export * from "./audit/index.ts";

export { Agent } from "./agent.ts";
export type {
  AgentConfig,
  AgentConversationManager,
  AgentConversationRuntimeDefaults,
  AgentPersistenceConfig,
  CreateAgentConversationConfig,
  OpenAgentConversationConfig,
  OpenOwnedAgentConversationResult,
  AdoptProviderSessionConfig,
  ClearTranscriptOptions,
  ClearTranscriptResult,
  DeleteConversationOptions,
  DeleteConversationResult,
  ListProviderSessionsOptions,
  ProviderSessionSummary,
  AgentConversationAuditCaptureConfig,
  AgentConversationPersistenceOverride,
  AgentScopeAuditObservationKind,
  ConversationPersistenceContext,
  ConversationPersistenceResolver,
} from "./agent.ts";
export {
  OUT_OF_BAND_MESSAGE_ORIGIN,
  OUT_OF_BAND_PROMPT_MAX_CHARS,
  isOutOfBandMessage,
} from "./out-of-band-messages.ts";
export type { AppendAssistantMessageInput } from "./out-of-band-messages.ts";
export { AgentAdapterRegistry } from "./agent-adapter-registry.ts";
export type { AgentAdapterRegistration } from "./agent-adapter-registry.ts";
export { NoopAgentIdentityRuntime, composeIdentityPrompt } from "./identity.ts";
export { CheckpointBackedIdentityRuntime } from "./identity/checkpoint-backed.ts";
export type { CheckpointBackedIdentityConfig } from "./identity/checkpoint-backed.ts";
export type {
  AgentIdentityRuntime,
  IdentityDeliveryReceipt,
  IdentityConsistency,
  IdentityLoadInput,
  IdentitySynchronizationInput,
  IdentityUpdateInput,
  IdentityWatermark,
  LoadedIdentityContext,
} from "./identity.ts";

export {
  CONVERSATION_RECORD_KINDS,
  DEFAULT_CONVERSATION_RECORD_CAPTURE,
  IMPLICIT_USER_PARTICIPANT_ID,
  PARTICIPANT_KINDS,
  PersistenceCapabilityError,
  PersistenceConflictError,
  isConversationRecordKind,
  isParticipantKind,
  normalizeParticipantRef,
  resolveConversationRecordCapture,
  shouldCaptureProtocolMethod,
  searchableText,
} from "./persistence/backend.ts";
export {
  CONVERSATION_ERROR_CODES,
  CONVERSATION_ERROR_RECOVERABILITIES,
  CONVERSATION_ERROR_SOURCES,
  buildConversationErrorDetails,
  conversationErrorDetailsFromError,
  sanitizeConversationErrorMessage,
} from "./persistence/error-records.ts";
export type {
  ConversationErrorCode,
  ConversationErrorDetailInput,
} from "./persistence/error-records.ts";
export {
  AgentDatabaseInUseError,
  SQLITE_AGENT_SCHEMA_VERSION,
  SqliteAgentPersistence,
  hasSafeConcurrentWal,
  requireSqliteSearch,
} from "./persistence/index.ts";
export type { SqliteAgentPersistenceConfig } from "./persistence/index.ts";
export type {
  AgentConversationSummary,
  AgentConversationPreview,
  ConversationPreviewPage,
  ConversationMessagePreview,
  AgentAuditState,
  AuditOutboxBacklog,
  AgentPersistenceIdentity,
  ConversationRecord,
  ConversationRecordCaptureConfig,
  ConversationRecordCapturePolicy,
  ConversationRecordEnvelope,
  ConversationRecordKind,
  ConversationErrorDetails,
  ConversationErrorRecoverability,
  ConversationErrorSource,
  ErrorRecord,
  RecentItemPage,
  RecentItemPageOptions,
  RecentRecordPage,
  RecentRecordPageOptions,
  IdentityMemoryObservation,
  IdentityDeliveryAdvance,
  IdentityDeliveryCursor,
  IdentityDeliveryPersistence,
  MessageRecord,
  AgentMeteringCommitInput,
  MeteringCommitInput,
  MeteringPersistence,
  MeteringRecordListOptions,
  MeteringRecordPage,
  MeteringRecordRetention,
  MeteringReferenceRecord,
  ProtocolRecordCapture,
  ProtocolRecordCaptureLevel,
  ProtocolRecordCaptureOptions,
  RecordCaptureLevel,
  ResolvedProtocolRecordCapturePolicy,
  NewConversationRecord,
  NewAuditOutboxItem,
  ParticipantKind,
  ParticipantRef,
  PersistedContent,
  PersistedContentBlock,
  PersistedMediaBlock,
  OutOfBandDeliveryPersistence,
  PersistedIdentitySnapshot,
  PersistedAgentMeteringState,
  PersistedConversationMeteringState,
  PersistenceBackend,
  PersistenceCapabilities,
  PersistenceExtension,
  PersistenceJsonValue,
  PersistenceScope,
  SearchMatch,
  SearchQuery,
  VectorIndex,
} from "./persistence/backend.ts";

export {
  AgentController,
  parseConfigValue,
  parseBoolean,
  parseJsonOrString,
  formatConfigValue,
} from "./controller.ts";
export type { CommandArgumentDescriptor, CommandDescriptor } from "./command-descriptors.ts";
export type {
  AgentControllerConfig,
  AgentMode,
  ControllerCommand,
  ControllerCommandId,
  ConfigValueParseResult,
  SetConfigFromStringResult,
} from "./controller.ts";

export {
  AgentConversation,
  AgentSession,
  AgentSessionPromptBlockedError,
  AdapterMismatchError,
  ContinuationUnavailableError,
  DirectAuditPersistenceUnsupportedError,
  ProviderSessionError,
  ProviderSessionInUseError,
  ProviderSessionListUnsupportedError,
} from "./agent-session.ts";
export type { ProviderSessionErrorDetails } from "./agent-session.ts";
export type {
  AgentConversationConfig,
  AgentConversationOpenConfig,
  AgentConversationOpenResult,
  AgentConversationPromptability,
  AgentConversationPhase,
  AgentConversationState,
  AgentConversationEvent,
  AgentConversationNotification,
  AgentConversationListener,
  AgentConversationPromptResult,
  AgentConversationPromptInput,
  AgentConversationAttributedPromptInput,
  AgentConversationRecoveryResolution,
  AgentConversationRecoveryResolutionResult,
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
  AgentSessionRecoveryResolution,
  AgentSessionRecoveryResolutionResult,
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
export { formatResponseMessages } from "./response.ts";
export type {
  MessageDeliveryVia,
  MessageEvent,
  PendingMessage,
  PendingMessageId,
  PromptDelivery,
  PromptEndedBy,
  PromptHandle,
  CombinedMessage,
  PromptPart,
} from "./steering/index.ts";

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
  ManagedAgentSessionAuthorityConflictError,
  ManagedAgentSessionDeletedError,
  ManagedAgentSessionNotFoundError,
} from "./persistence/managed-load.ts";
export type { ManagedAgentSessionLoadConfig } from "./persistence/managed-load.ts";
export type {
  AgentSessionOpenStage,
  AgentSessionOpenProgressListener,
} from "./persistence/managed-open-progress.ts";
export type {
  GetAgentSessionCheckpointOptions,
  ResolvedAgentSessionCheckpoint,
} from "./persistence/managed-checkpoint.ts";
export { AgentSessionPersistenceReconfigurationError } from "./persistence/reconfiguration.ts";
export type { ReconfigureAgentSessionPersistenceOptions } from "./persistence/reconfiguration.ts";
export { AgentSessionRestorationError } from "./persistence/restoration.ts";
export type { RestoreAgentSessionOptions } from "./persistence/restoration.ts";

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
  MaintenanceAlreadyCompletedError,
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
  NormalizedPresentationMetadata,
  TranscriptProjectionContext,
} from "./persistence/projection.ts";
export { presentationItemFromRecord } from "./persistence/presentation.ts";
export type {
  TranscriptPresentationActivity,
  TranscriptPresentationItem,
  TranscriptPresentationMessage,
  TranscriptPresentationReasoning,
  TranscriptPresentationRecord,
} from "./persistence/presentation.ts";
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
export {
  TranscriptCursorInvalidError,
  TranscriptReader,
  TranscriptReaderError,
} from "./persistence/transcript-reader.ts";
export {
  AuditLogCursorInvalidError,
  AuditLogReader,
  AuditLogReaderError,
} from "./persistence/audit-log-reader.ts";
export type {
  AuditLogCursor,
  AuditLogSnapshotCursor,
  ReadAuditLogPageOptions,
} from "./persistence/audit-log-reader.ts";
export {
  LegacyTranscriptMigrationError,
  migrateLegacyTranscript,
} from "./persistence/migration.ts";
export type {
  LegacyTranscriptMigrationResult,
  MigrateLegacyTranscriptOptions,
} from "./persistence/migration.ts";
export { importLegacySessionRegistry } from "./persistence/legacy-registry-import.ts";
export type {
  LegacyRegistryImportEntry,
  LegacyRegistryImportReason,
  LegacyRegistryImportResult,
  LegacyRegistryImportStatus,
} from "./persistence/legacy-registry-import.ts";
export {
  AgentSessionDeletionError,
  deleteManagedAgentSession,
} from "./persistence/deletion.ts";
export type { DeleteAgentSessionOptions } from "./persistence/deletion.ts";
export {
  ManagedAgentSessionCreationError,
} from "./persistence/managed-creation.ts";
export type { ManagedAgentSessionCreateConfig } from "./persistence/managed-creation.ts";
export type {
  ActivityExecutionState,
  ListTranscriptActivitiesOptions,
  PersistedActivityState,
  PersistedActivityStatePage,
  ReadTranscriptPageOptions,
  ReadTranscriptPresentationPageOptions,
  TranscriptConversationItem,
  TranscriptCursor,
  TranscriptPage,
  TranscriptPresentationCursor,
  TranscriptPresentationPage,
  TranscriptSnapshotCursor,
  TranscriptTimelineItem,
  TranscriptReadableRecord,
  TranscriptView,
} from "./persistence/transcript-reader.ts";
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
  AgentSessionHandoffErrorDetails,
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

export * from "./operations/index.ts";

export type { MessagePart, MediaPart, MediaKind, MediaThresholds, ResolvedPart, ResolvedMediaPart } from "./media/parts.ts";

export type { MediaStore, MediaInfo, StoredMedia, MediaConfig } from "./media/store.ts";

export type { MediaCaptureLevel } from "./media/capture.ts";

export type { SharedFile, SharedFilePage, SharedFileQuery, SharedFilesPersistence } from "./media/files.ts";
