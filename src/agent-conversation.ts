/**
 * Canonical conversation entry point.
 *
 * `agent-session.ts` remains the compatibility module until the old public
 * `AgentSession` vocabulary can be retired. Both exported constructors are the same
 * runtime class; this module does not introduce a wrapper or a second lifecycle.
 */
export { AgentConversation } from "./agent-session.ts";
export type {
  AgentConversationConfig,
  AgentConversationOpenConfig,
  AgentConversationOpenResult,
  ManagedAgentConversationCreationBootstrap,
  ManagedAgentConversationPersistenceSnapshot,
} from "./agent-session.ts";
export type {
  AgentConversationEvent,
  AgentConversationListener,
  AgentConversationNotification,
  AgentConversationPhase,
  AgentConversationPromptResult,
  AgentConversationPromptability,
  AgentConversationRecoveryResolution,
  AgentConversationRecoveryResolutionResult,
  AgentConversationState,
  ConfigurationMismatchResolution,
  ConfigurationMismatchResolutionResult,
  ConfigurationRestoreStatus,
  ContinuationAttempt,
  ContinuationReport,
  ContinuationStrategy,
  HandoffOptions,
  HandoffResult,
  OpenContinuationOptions,
  PromptBlocker,
  ProviderSession,
  TranscriptActivityConfig,
  TranscriptContinuationBuilder,
  TranscriptContinuationBuilderContext,
} from "./agent-conversation-contracts.ts";
