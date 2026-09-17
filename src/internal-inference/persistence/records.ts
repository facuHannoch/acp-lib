import type { AgentConversationId, AgentSessionId } from "../../agent-ids.ts";
import type { PersistenceJsonValue } from "../../persistence/backend.ts";
import type {
  InternalInferenceChainStatus,
  InternalInferenceCompletion,
  InternalInferenceId,
  InternalInferenceInputDescriptor,
  InternalInferencePurpose,
  InternalInferenceStatus,
} from "../contracts.ts";

export interface InternalInferenceAttemptRecord {
  readonly internalInferenceId: InternalInferenceId;
  readonly rootInternalInferenceId: InternalInferenceId;
  readonly retryOfInternalInferenceId?: InternalInferenceId;
  readonly attemptNumber: number;
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId?: AgentConversationId;
  readonly purpose: InternalInferencePurpose;
  readonly status: InternalInferenceStatus;
  readonly adapterId: string;
  readonly executionProfileId?: string;
  readonly input: InternalInferenceInputDescriptor;
  readonly model?: string;
  readonly internalSessionId?: string;
  readonly sourceCheckpointId?: string;
  readonly sourceFromSequence?: number;
  readonly sourceThroughSequence?: number;
  readonly requestedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly nextAttemptAt?: string;
  readonly workerId?: string;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: string;
  readonly heartbeatAt?: string;
  readonly revision: number;
  readonly completion?: InternalInferenceCompletion;
  readonly error?: string;
  readonly failureCode?: string;
  readonly meteringOperationId?: string;
  readonly metadata?: string;
}

export interface InternalInferenceChainRecord {
  readonly rootInternalInferenceId: InternalInferenceId;
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId?: AgentConversationId;
  readonly purpose: InternalInferencePurpose;
  readonly status: InternalInferenceChainStatus;
  readonly activeInternalInferenceId?: InternalInferenceId;
  readonly requestedThroughSequence?: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string;
}

export interface EnqueueInternalInferenceInput {
  readonly internalInferenceId: InternalInferenceId;
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId?: AgentConversationId;
  readonly purpose: InternalInferencePurpose;
  readonly adapterId: string;
  readonly executionProfileId?: string;
  readonly input: InternalInferenceInputDescriptor;
  readonly sourceCheckpointId?: string;
  readonly sourceFromSequence?: number;
  readonly sourceThroughSequence?: number;
  readonly requestedThroughSequence?: number;
  readonly requestedAt?: string;
  readonly nextAttemptAt?: string;
  readonly metadata?: string;
}

export interface ClaimInternalInferenceInput {
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
  readonly now?: string;
}

export interface ClaimedInternalInference {
  readonly attempt: InternalInferenceAttemptRecord;
  readonly chain: InternalInferenceChainRecord;
}

export interface InternalInferencePage {
  readonly attempts: readonly InternalInferenceAttemptRecord[];
  readonly nextCursor?: string;
}

export interface InternalInferenceListOptions {
  readonly agentConversationId?: AgentConversationId;
  readonly purpose?: InternalInferencePurpose;
  readonly status?: InternalInferenceStatus;
  readonly rootId?: InternalInferenceId;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CompleteInternalInferenceInput {
  readonly internalInferenceId: InternalInferenceId;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly completion: InternalInferenceCompletion;
  readonly model?: string;
  readonly internalSessionId: string;
  readonly meteringOperationId?: string;
  readonly completedAt?: string;
}

export interface FailInternalInferenceInput {
  readonly internalInferenceId: InternalInferenceId;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly error: string;
  readonly failureCode: string;
  readonly retry?: {
    readonly internalInferenceId: InternalInferenceId;
    readonly nextAttemptAt?: string;
  };
  readonly completedAt?: string;
  readonly resultMetadata?: PersistenceJsonValue;
}

export interface RecoverExpiredInternalInferenceInput {
  readonly retryInternalInferenceId: InternalInferenceId;
  readonly maxAttempts: number;
  readonly nextAttemptAt?: string;
  readonly now?: string;
}
