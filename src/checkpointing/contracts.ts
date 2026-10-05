import type { AgentConversationId } from "../agent-ids.ts";
import type { InternalInferenceId } from "../internal-inference/contracts.ts";

export type ConversationRecoveryCheckpointId = `chk-${string}`;

/**
 * What made a checkpoint. `internal_inference` is the normal case: a model call over stored records.
 * The adoption sources have no generator: the summary is the recap the adopted session wrote of its own
 * history (`adoption_recap`), or empty (`adoption_baseline`, a floor only). Either way the checkpoint says
 * where summarizing starts, so nothing ever tries to summarize the history that came before it.
 */
export type ConversationRecoveryCheckpointSource =
  | "internal_inference"
  | "adoption_recap"
  | "adoption_baseline";

export interface ConversationRecoveryCheckpoint {
  readonly checkpointId: ConversationRecoveryCheckpointId;
  readonly agentConversationId: AgentConversationId;
  readonly revision: number;
  readonly coveredSequence: number;
  readonly previousCheckpointId?: ConversationRecoveryCheckpointId;
  /** Absent for the adoption sources, which no internal inference generated. */
  readonly generatorInternalInferenceId?: InternalInferenceId;
  readonly source: ConversationRecoveryCheckpointSource;
  /** Empty only for `adoption_baseline`. */
  readonly summary: string;
  /**
   * Adoption only: the checkpoint schedule counts successful responses after this sequence, so the history
   * an adoption imported does not use up the milestones a new conversation starts with.
   */
  readonly responsesCountedAfterSequence?: number;
  readonly createdAt: string;
  readonly metadata?: string;
}

export interface PublishConversationRecoveryCheckpointInput {
  readonly checkpointId: ConversationRecoveryCheckpointId;
  readonly agentConversationId: AgentConversationId;
  readonly coveredSequence: number;
  readonly previousCheckpointId?: ConversationRecoveryCheckpointId;
  readonly generatorInternalInferenceId?: InternalInferenceId;
  /** Default `internal_inference`, which requires a generator and a summary. */
  readonly source?: ConversationRecoveryCheckpointSource;
  readonly summary: string;
  readonly responsesCountedAfterSequence?: number;
  readonly createdAt?: string;
  readonly metadata?: string;
}

export interface ConversationRecoveryCheckpointListOptions {
  readonly limit?: number;
  readonly beforeRevision?: number;
}

export interface ConversationRecoveryCheckpointRepository {
  /**
   * Count completed provider turns using the stable operation ID on assistant messages, after the
   * adoption checkpoint's `responsesCountedAfterSequence` when the conversation has one.
   */
  successfulResponseCount(agentConversationId: AgentConversationId): Promise<number>;
  latestMessageSequence(agentConversationId: AgentConversationId): Promise<number>;
  latest(agentConversationId: AgentConversationId): Promise<ConversationRecoveryCheckpoint | null>;
  get(checkpointId: ConversationRecoveryCheckpointId): Promise<ConversationRecoveryCheckpoint | null>;
  list(
    agentConversationId: AgentConversationId,
    options?: ConversationRecoveryCheckpointListOptions,
  ): Promise<readonly ConversationRecoveryCheckpoint[]>;
  publish(input: PublishConversationRecoveryCheckpointInput): Promise<ConversationRecoveryCheckpoint>;
  /** Delete every checkpoint of a conversation. Returns how many. Optional. */
  deleteForConversation?(agentConversationId: AgentConversationId): Promise<number>;
}
