import type { AgentConversationId } from "../agent-ids.ts";
import type { InternalInferenceManager } from "../internal-inference/contracts.ts";
import type { PersistenceBackend } from "../persistence/backend.ts";
import type { ConversationRecoveryCheckpoint } from "./contracts.ts";
import type { ResolvedConversationCheckpointingConfig } from "./config.ts";
import { isConversationCheckpointDue } from "./config.ts";
import { CONVERSATION_CHECKPOINT_STRATEGY_ID } from "./strategy.ts";

/** Schedules rolling summaries without waiting for their provider execution. */
export class ConversationCheckpointCoordinator {
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(
    private readonly persistence: PersistenceBackend,
    private readonly inferences: InternalInferenceManager,
    private readonly config: ResolvedConversationCheckpointingConfig,
  ) {
    this.unsubscribe = inferences.subscribe((event) => {
      if (
        event.snapshot.purpose === "conversation_checkpoint"
        && event.snapshot.status === "completed"
        && event.snapshot.agentConversationId
      ) void this.scheduleIfDue(event.snapshot.agentConversationId).catch(() => undefined);
    });
  }

  async latest(conversationId: AgentConversationId): Promise<ConversationRecoveryCheckpoint | null> {
    return await this.requireRepository().latest(conversationId);
  }

  async afterSuccessfulResponse(conversationId: AgentConversationId): Promise<void> {
    await this.scheduleIfDue(conversationId);
  }

  async request(conversationId: AgentConversationId): Promise<void> {
    await this.enqueueLatest(conversationId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
  }

  private async scheduleIfDue(conversationId: AgentConversationId): Promise<void> {
    if (this.closed || !this.config.enabled) return;
    const count = await this.requireRepository().successfulResponseCount(conversationId);
    if (!isConversationCheckpointDue(count, this.config)) return;
    await this.enqueueLatest(conversationId);
  }

  private async enqueueLatest(conversationId: AgentConversationId): Promise<void> {
    if (this.closed) return;
    const conversation = await this.persistence.conversations.get(conversationId);
    if (!conversation || conversation.deletedAt || conversation.latestSequence < 1) return;
    const previous = await this.requireRepository().latest(conversationId);
    if (previous && previous.coveredSequence >= conversation.latestSequence) return;
    await this.inferences.enqueue({
      purpose: "conversation_checkpoint",
      agentConversationId: conversationId,
      input: {
        strategyId: CONVERSATION_CHECKPOINT_STRATEGY_ID,
        version: 1,
        payload: { instruction: this.config.summaryInstruction },
      },
      ...(previous ? { sourceCheckpointId: previous.checkpointId } : {}),
      sourceFromSequence: previous?.coveredSequence ?? 0,
      sourceThroughSequence: conversation.latestSequence,
      requestedThroughSequence: conversation.latestSequence,
    });
  }

  private requireRepository() {
    const repository = this.persistence.recoveryCheckpoints;
    if (!repository) throw new Error("persistence does not support recovery checkpoints");
    return repository;
  }
}
