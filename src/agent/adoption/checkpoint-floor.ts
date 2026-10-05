import type { AgentConversationId } from "../../agent-ids.ts";
import { createConversationRecoveryCheckpointId } from "../../checkpointing/ids.ts";
import type { ConversationRecoveryCheckpointRepository } from "../../checkpointing/contracts.ts";

/** Messages left after the floor, so a recovery or a first checkpoint still sees the end of the history. */
export const DEFAULT_ADOPTION_TAIL_MESSAGES = 50;

export interface AdoptionRecapPlacement {
  readonly summary: string;
  /** Sequence of the stored recap message. */
  readonly sequence: number;
}

/**
 * Where checkpointing starts for an adopted conversation, so that nothing ever summarizes the history that
 * came before it. Summarizing stored records is a prompt, and a long history does not fit one (a harness
 * refuses a message past about a million characters), so the floor sits `tailMessages` before the end of
 * what is stored: the recap's own message when that is later, so a conversation whose history is short
 * keeps the recap as the first thing it recovers from.
 *
 * With a recap the checkpoint's summary is the recap, which covers the whole provider history; without one the
 * checkpoint is a baseline with no summary, and recovery seeds only the messages after it. A conversation
 * with no recap and no more than `tailMessages` stored messages has nothing to place a floor under, and gets
 * none: its first scheduled checkpoint summarizes those few messages.
 *
 * The checkpoint schedule counts responses after the stored history, so an import does not use up the
 * milestones a new conversation starts with.
 */
export async function publishAdoptionFloor(
  repository: ConversationRecoveryCheckpointRepository,
  conversationId: AgentConversationId,
  options: { readonly recap?: AdoptionRecapPlacement; readonly tailMessages?: number },
): Promise<boolean> {
  const tail = Math.max(0, options.tailMessages ?? DEFAULT_ADOPTION_TAIL_MESSAGES);
  const lastSequence = await repository.latestMessageSequence(conversationId);
  const floor = Math.max(options.recap?.sequence ?? 0, lastSequence - tail);
  if (floor < 1) return false;
  await repository.publish({
    checkpointId: createConversationRecoveryCheckpointId(),
    agentConversationId: conversationId,
    coveredSequence: floor,
    source: options.recap ? "adoption_recap" : "adoption_baseline",
    summary: options.recap?.summary ?? "",
    responsesCountedAfterSequence: lastSequence,
  });
  return true;
}
