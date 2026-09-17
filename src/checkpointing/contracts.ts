import type { AgentConversationId } from "../agent-ids.ts";
import type { InternalInferenceId } from "../internal-inference/contracts.ts";

export type ConversationRecoveryCheckpointId = `chk-${string}`;

export interface ConversationRecoveryCheckpoint {
  readonly checkpointId: ConversationRecoveryCheckpointId;
  readonly agentConversationId: AgentConversationId;
  readonly revision: number;
  readonly coveredSequence: number;
  readonly previousCheckpointId?: ConversationRecoveryCheckpointId;
  readonly generatorInternalInferenceId: InternalInferenceId;
  readonly summary: string;
  readonly createdAt: string;
  readonly metadata?: string;
}

export interface PublishConversationRecoveryCheckpointInput {
  readonly checkpointId: ConversationRecoveryCheckpointId;
  readonly agentConversationId: AgentConversationId;
  readonly coveredSequence: number;
  readonly previousCheckpointId?: ConversationRecoveryCheckpointId;
  readonly generatorInternalInferenceId: InternalInferenceId;
  readonly summary: string;
  readonly createdAt?: string;
  readonly metadata?: string;
}

export interface ConversationRecoveryCheckpointListOptions {
  readonly limit?: number;
  readonly beforeRevision?: number;
}

export interface ConversationRecoveryCheckpointRepository {
  latest(agentConversationId: AgentConversationId): Promise<ConversationRecoveryCheckpoint | null>;
  get(checkpointId: ConversationRecoveryCheckpointId): Promise<ConversationRecoveryCheckpoint | null>;
  list(
    agentConversationId: AgentConversationId,
    options?: ConversationRecoveryCheckpointListOptions,
  ): Promise<readonly ConversationRecoveryCheckpoint[]>;
  publish(input: PublishConversationRecoveryCheckpointInput): Promise<ConversationRecoveryCheckpoint>;
}
