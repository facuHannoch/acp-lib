import type { AgentConversationId, AgentSessionId } from "../agent-ids.ts";
import type { AgentSessionMeteringState } from "../metering/state.ts";
import type { OperationMeteringRecord, OperationOutcome } from "../metering/record.ts";
import type { StatefulSubscribable, Subscribable } from "../observation/contracts.ts";
import type { PersistenceJsonValue, PersistenceScope } from "../persistence/backend.ts";
import type { ResponseMessage, TokenUsage } from "../types.ts";

export type InternalInferenceId = `aii-${string}`;
export type BuiltinInternalInferencePurpose =
  | "conversation_checkpoint"
  | "conversation_recovery"
  | "identity_update";
export type InternalInferencePurpose = BuiltinInternalInferencePurpose | (string & {});
export type InternalInferenceStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type InternalInferenceChainStatus = "active" | "completed" | "failed" | "cancelled";
export type InternalInferenceStage =
  | "queued"
  | "claiming"
  | "preparing_input"
  | "starting_harness"
  | "creating_session"
  | "prompting"
  | "persisting_result"
  | "completed"
  | "retry_wait"
  | "failed"
  | "cancelled";

export interface InternalInferenceInputDescriptor {
  readonly version: number;
  readonly strategyId: string;
  readonly payload: PersistenceJsonValue;
}

export interface InternalInferenceRequest {
  readonly internalInferenceId: InternalInferenceId;
  readonly purpose: InternalInferencePurpose;
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId?: AgentConversationId;
  readonly adapterId: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly metadata?: string;
}

export interface InternalInferenceResult {
  readonly internalInferenceId: InternalInferenceId;
  readonly internalSessionId: string;
  readonly adapterId: string;
  readonly model: string | null;
  readonly messages: readonly ResponseMessage[];
  readonly usage: TokenUsage | null;
  readonly stopReason?: string;
  readonly metadata?: string;
}

export interface InternalInferenceCompletion {
  readonly internalInferenceId: InternalInferenceId;
  readonly rootInternalInferenceId: InternalInferenceId;
  readonly internalSessionId: string;
  readonly purpose: InternalInferencePurpose;
  readonly artifactId?: string;
  readonly meteringOperationId?: string;
  readonly completedAt: string;
  readonly metadata?: string;
}

export interface InternalInferenceSnapshot {
  readonly id: InternalInferenceId;
  readonly rootId: InternalInferenceId;
  readonly retryOfId?: InternalInferenceId;
  readonly revision: number;
  readonly purpose: InternalInferencePurpose;
  readonly status: InternalInferenceStatus;
  readonly stage: InternalInferenceStage;
  readonly adapterId: string;
  readonly agentConversationId?: AgentConversationId;
  readonly requestedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly attemptNumber: number;
  readonly error?: string;
}

export interface InternalInferenceRunSnapshot {
  readonly rootId: InternalInferenceId;
  readonly status: InternalInferenceChainStatus;
  readonly revision: number;
  readonly activeAttemptId?: InternalInferenceId;
  readonly requestedThroughSequence?: number;
  readonly error?: string;
}

export interface InternalInferenceEvent {
  readonly kind: "changed";
  /** Monotonic within one manager process, including ephemeral progress changes. */
  readonly sequence: number;
  readonly inferenceId: InternalInferenceId;
  readonly rootId: InternalInferenceId;
  readonly revision: number;
  readonly snapshot: InternalInferenceSnapshot;
}

export interface InternalInference extends StatefulSubscribable<InternalInferenceSnapshot, InternalInferenceEvent> {
  readonly id: InternalInferenceId;
  readonly result: Promise<InternalInferenceCompletion>;
  cancel(): Promise<void>;
}

export interface InternalInferenceRun extends StatefulSubscribable<InternalInferenceRunSnapshot, InternalInferenceEvent> {
  readonly rootId: InternalInferenceId;
  readonly activeAttempt: InternalInference;
  readonly result: Promise<InternalInferenceCompletion>;
  cancel(): Promise<void>;
}

export interface EnqueueInternalInferenceRequest {
  readonly purpose: InternalInferencePurpose;
  readonly agentConversationId?: AgentConversationId;
  /** Overrides the configured policy; otherwise the manager resolves and snapshots it. */
  readonly adapterId?: string;
  readonly executionProfileId?: string;
  readonly input: InternalInferenceInputDescriptor;
  readonly sourceCheckpointId?: string;
  readonly sourceFromSequence?: number;
  readonly sourceThroughSequence?: number;
  readonly requestedThroughSequence?: number;
  readonly metadata?: string;
}

export interface InternalInferenceManager extends Subscribable<InternalInferenceEvent> {
  enqueue(request: EnqueueInternalInferenceRequest): Promise<InternalInferenceRun>;
  getAttempt(id: InternalInferenceId): Promise<InternalInference | null>;
  getRun(rootId: InternalInferenceId): Promise<InternalInferenceRun | null>;
  list(options?: InternalInferenceListOptions): Promise<InternalInferenceSnapshotPage>;
  cancel(rootId: InternalInferenceId, reason?: string): Promise<void>;
}

export interface InternalInferenceListOptions {
  readonly agentConversationId?: AgentConversationId;
  readonly purpose?: InternalInferencePurpose;
  readonly status?: InternalInferenceStatus;
  readonly rootId?: InternalInferenceId;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface InternalInferenceSnapshotPage {
  readonly attempts: readonly InternalInferenceSnapshot[];
  readonly nextCursor?: string;
}

export interface InternalInferenceRuntime {
  run(
    request: InternalInferenceRequest,
    signal?: AbortSignal,
    lifecycle?: InternalInferenceRuntimeLifecycle,
  ): Promise<InternalInferenceResult>;
}

export interface InternalInferenceRuntimeLifecycle {
  stageChanged?(stage: Extract<InternalInferenceStage, "creating_session" | "prompting">): void;
  sessionStarted(input: {
    readonly internalSessionId: string;
    readonly model: string | null;
  }): void | Promise<void>;
}

export interface InternalInferenceMeteringOperation {
  close(input: {
    readonly outcome: OperationOutcome;
    readonly result?: InternalInferenceResult;
    readonly error?: unknown;
  }): Promise<OperationMeteringRecord>;
  /** Releases restoration barriers after the record transaction settles. */
  settled(): void;
}

export type InternalInferenceRetryDisposition =
  | { readonly kind: "terminal"; readonly code: string }
  | { readonly kind: "retryable"; readonly code: string };

export interface PreparedInternalInference {
  readonly prompt: string;
  readonly cwd?: string;
  readonly metadata?: string;
}

export interface InternalInferencePreparationContext {
  readonly attempt: InternalInferenceSnapshot;
  /** Canonical agent persistence used to derive the prompt from durable source data. */
  readonly persistence: PersistenceScope;
  readonly signal?: AbortSignal;
}

export interface InternalInferenceCompletionContext {
  readonly attempt: InternalInferenceSnapshot;
  /** Transaction-scoped persistence used to publish the purpose artifact atomically. */
  readonly persistence: PersistenceScope;
  readonly meteringState?: AgentSessionMeteringState;
}

export interface InternalInferenceStrategy<TPayload = PersistenceJsonValue> {
  readonly strategyId: string;
  readonly purpose: InternalInferencePurpose;
  readonly version: number;
  validatePayload(payload: PersistenceJsonValue): TPayload;
  prepare(context: InternalInferencePreparationContext, payload: TPayload): Promise<PreparedInternalInference>;
  complete(
    context: InternalInferenceCompletionContext,
    result: InternalInferenceResult,
  ): Promise<InternalInferenceCompletion>;
  classifyError(error: unknown): InternalInferenceRetryDisposition;
}
