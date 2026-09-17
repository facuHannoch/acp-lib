import type { AgentMode } from "./controller.ts";
import type { ContextWindowStatus, ProviderCostSnapshot } from "./metering/context.ts";
import type { OperationMeteringRecord } from "./metering/record.ts";
import type { AgentSessionMeteringState } from "./metering/state.ts";
import type { AgentSessionCheckpoint, JsonValue } from "./persistence/checkpoint.ts";
import type { PersistedMachineCode } from "./persistence/integrity.ts";
import type { TranscriptPresentationItem } from "./persistence/presentation.ts";
import type { SessionRecoveryStatus } from "./persistence/reducer.ts";
import type { TranscriptReader } from "./persistence/transcript-reader.ts";
import type {
  ActivityEvent,
  InternalSessionCommand,
  PromptResult,
} from "./types.ts";

/** What the current durable conversation implementation is doing right now. */
export type AgentSessionPhase =
  | "idle"
  | "prompting"
  | "handoff"
  | "configuring"
  | "recovering"
  | "switching_mode"
  | "stopped";

/** Authoritative, immutable point-in-time state for orchestration consumers. */
export interface AgentSessionState {
  readonly phase: AgentSessionPhase;
  /** True only while an operation is executing; queued work is reported separately. */
  readonly isBusy: boolean;
  /** Operations waiting behind the active one. Does not count the active operation. */
  readonly queuedOperationCount: number;
  readonly agentSessionId: string;
  readonly internalSessionId: string | null;
  readonly adapterId: string;
  readonly mode: AgentMode;
  readonly promptability: AgentSessionPromptability;
}

export type ConfigurationRestoreStatus =
  | { readonly kind: "matched" }
  | { readonly kind: "partial"; readonly omittedConfigIds: readonly string[] }
  | {
      readonly kind: "mismatch";
      readonly configIds: readonly string[];
      readonly reasons: readonly string[];
    };

export type PromptBlocker =
  | "continuation_unavailable"
  | "recovery_required"
  | "configuration_mismatch"
  | "persistence_unhealthy"
  | "maintenance_pending"
  | "session_stopped";

export type AgentSessionPromptability =
  | { readonly promptable: true; readonly blockers: readonly [] }
  | { readonly promptable: false; readonly blockers: readonly PromptBlocker[] };

export interface ContinuationAttempt {
  readonly strategy: ContinuationStrategy["kind"];
  readonly status: "succeeded" | "failed" | "skipped";
  readonly errorCode?: PersistedMachineCode;
  readonly reason?: string;
}

export interface ContinuationReport {
  readonly recordedAdapterId: string;
  readonly recordedInternalSessionId: string | null;
  readonly requestedAdapterId: string;
  readonly recordedConversationAvailability: "available" | "partial" | "not_captured";
  readonly recordedThreadAvailability: "available" | "unavailable" | "not_checked";
  readonly attempts: readonly ContinuationAttempt[];
  readonly outcome:
    | { readonly kind: "loaded"; readonly activeInternalSessionId: string }
    | {
        readonly kind: "reconstructed";
        readonly source: "transcript" | "consumer";
        readonly activeInternalSessionId: string;
        readonly transitionId: string;
      }
    | { readonly kind: "unavailable" };
}

export interface TranscriptContinuationBuilderContext {
  readonly agentSessionId: string;
  readonly checkpoint: AgentSessionCheckpoint;
  /** Snapshot-bound access to captured history; the builder decides how much to read. */
  readonly transcript: TranscriptReader;
  readonly targetAdapterId: string;
}

export type TranscriptContinuationBuilder = (
  context: TranscriptContinuationBuilderContext,
) => Promise<{ readonly continuation: string; readonly metadata?: Readonly<Record<string, JsonValue>> }>;

export type ContinuationStrategy =
  | { readonly kind: "load_internal_session" }
  | {
      readonly kind: "new_from_transcript";
      readonly strategyId: string;
      readonly buildContinuation: TranscriptContinuationBuilder;
    }
  | {
      readonly kind: "new_from_consumer_continuation";
      readonly continuationId: string;
      readonly continuation: string;
    };

export interface OpenContinuationOptions {
  /** Defaults to only `load_internal_session`; an empty array is invalid. */
  readonly strategies?: readonly ContinuationStrategy[];
}

export type ConfigurationMismatchResolution =
  | { readonly strategy: "accept_effective" }
  | {
      readonly strategy: "replace_restoration_targets";
      readonly selections: readonly { readonly configId: string; readonly value: JsonValue }[];
    };

export interface ConfigurationMismatchResolutionResult {
  readonly configuration: ConfigurationRestoreStatus;
  readonly appliedConfigIds: readonly string[];
}

export type AgentSessionRecoveryResolution =
  | { readonly strategy: "accept_harness_state" }
  | {
      readonly strategy: "start_new_internal_session";
      /** When omitted, the currently loaded harness thread generates portable context. */
      readonly continuation?: string;
    };

export interface AgentSessionRecoveryResolutionResult {
  readonly previous: Extract<SessionRecoveryStatus, { readonly kind: "uncertain" }>;
  readonly recovery: Extract<SessionRecoveryStatus, { readonly kind: "clean" }>;
  /** Present when resolution deliberately replaced the provider thread. */
  readonly handoff?: HandoffResult;
}

export interface HandoffOptions {
  /** Portable continuation context. When omitted, the current thread generates it. */
  readonly summary?: string;
}

export interface HandoffResult {
  readonly handoffId: string;
  readonly agentSessionId: string;
  readonly fromInternalSessionId: string | null;
  readonly toInternalSessionId: string;
  readonly summary: string;
  /** One record per token-consuming operation the handoff performed, in order. */
  readonly meteringRecords: readonly OperationMeteringRecord[];
}

/** Conversation-owned lifecycle events. Harness activity remains in PromptHandlers.onActivity. */
export type AgentSessionEvent =
  | { kind: "state_changed"; state: AgentSessionState }
  | { kind: "turn_started"; turnId: string }
  | { kind: "turn_completed"; turnId: string; result: PromptResult }
  | { kind: "turn_failed"; turnId: string; error: string }
  | { kind: "presentation_recorded"; item: TranscriptPresentationItem }
  | { kind: "internal_session_commands_changed"; commands: readonly InternalSessionCommand[] }
  | { kind: "handoff_started"; handoffId: string; fromInternalSessionId: string | null }
  | { kind: "handoff_completed"; result: HandoffResult }
  | {
      kind: "handoff_failed";
      handoffId: string;
      fromInternalSessionId: string | null;
      toInternalSessionId?: string;
      error: string;
      meteringRecords: readonly OperationMeteringRecord[];
    }
  | { kind: "configuration_started"; operationId: string; configId: string }
  | { kind: "configuration_completed"; operationId: string; configId: string }
  | { kind: "configuration_failed"; operationId: string; configId: string; error: string }
  | { kind: "mode_change_started"; transitionId: string; from: AgentMode; to: AgentMode }
  | { kind: "mode_change_completed"; transitionId: string; from: AgentMode; to: AgentMode }
  | { kind: "mode_change_failed"; transitionId: string; from: AgentMode; to: AgentMode; error: string }
  | {
      kind: "configuration_mismatch_resolved";
      configuration: ConfigurationRestoreStatus;
      appliedConfigIds: readonly string[];
    }
  | {
      kind: "recovery_resolved";
      strategy: AgentSessionRecoveryResolution["strategy"];
      previous: Extract<SessionRecoveryStatus, { kind: "uncertain" }>;
      recovery: Extract<SessionRecoveryStatus, { kind: "clean" }>;
    }
  | { kind: "context_window_changed"; contextWindow: ContextWindowStatus | null }
  | { kind: "provider_cost_changed"; providerCost: ProviderCostSnapshot | null }
  | { kind: "metering_recorded"; record: OperationMeteringRecord }
  | { kind: "metering_blocked"; reason: string }
  | { kind: "metering_unblocked" }
  | {
      kind: "metering_reconciled";
      before: AgentSessionMeteringState;
      after: AgentSessionMeteringState;
      reason: string;
      reference?: string;
      reconciledAt: number;
    };

/** A prompt result enriched with the operation's metering record. */
export interface AgentSessionPromptResult extends PromptResult {
  readonly operationId: string;
  /** Null only when a queued prompt was cancelled before provider dispatch. */
  readonly metering: OperationMeteringRecord | null;
}

/** Ordered envelope delivered to every current AgentSession subscriber. */
export interface AgentSessionNotification {
  readonly seq: number;
  readonly ts: number;
  readonly agentSessionId: string;
  readonly event: AgentSessionEvent;
}

export type AgentSessionListener = (notification: AgentSessionNotification) => void;

/** Conversation-first names. The AgentSession forms remain compatibility aliases. */
export type AgentConversationPhase = AgentSessionPhase;
export type AgentConversationState = AgentSessionState;
export type AgentConversationPromptability = AgentSessionPromptability;
export type AgentConversationPromptResult = AgentSessionPromptResult;
export type AgentConversationEvent = AgentSessionEvent;
export type AgentConversationNotification = AgentSessionNotification;
export type AgentConversationListener = AgentSessionListener;
export type AgentConversationRecoveryResolution = AgentSessionRecoveryResolution;
export type AgentConversationRecoveryResolutionResult = AgentSessionRecoveryResolutionResult;

/** What to record when transcript activity capture is on. */
export interface TranscriptActivityConfig {
  kinds?: Array<ActivityEvent["kind"]>;
  checkpointOnInput?: boolean;
  rawOutput?: boolean;
  maxBytes?: number;
}

/** Explicit selection of the provider thread backing a newly opened conversation. */
export type ProviderSession =
  | { readonly kind: "new" }
  | {
      readonly kind: "load";
      readonly internalSessionId: string;
      /** Default "error": never silently replace a requested thread. */
      readonly onFailure?: "error" | "new";
    };
