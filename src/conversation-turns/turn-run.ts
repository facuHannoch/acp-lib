/**
 * The run the session sends for a queued prompt (controller-interface spec, Ids). A run's turn id is
 * its first message's id; `messageIds` lists every message it carries, in queue order: one, or each
 * original message of a combined steer run (the list steering reports in `message_delivered`). No
 * new ids are minted.
 */
import type { TurnRun } from "../conversation-controller/contracts.ts";
import type { PromptQueueItem } from "./context.ts";

export function turnRunOf(prompt: PromptQueueItem): TurnRun {
  const messageIds = prompt.parts?.map((part) => part.id) ?? [prompt.turnId];
  return Object.freeze({
    turnId: prompt.turnId,
    messageIds: Object.freeze([...messageIds]),
    operationKind: prompt.operationKind,
  });
}

/**
 * A run must carry at least one message, each once, each one the session knows. A violation is a
 * bug in the session: it throws rather than send.
 */
export function checkTurnRun(run: TurnRun, known: (messageId: string) => boolean): void {
  if (run.messageIds.length === 0) throw new Error("a run carries at least one message id");
  const seen = new Set<string>();
  for (const id of run.messageIds) {
    if (seen.has(id)) throw new Error(`a run repeats message id ${id}`);
    if (!known(id)) throw new Error(`a run names message id ${id}, which the session does not know`);
    seen.add(id);
  }
  if (run.turnId !== undefined && run.turnId !== run.messageIds[0]) {
    throw new Error(`a run's turn id ${run.turnId} is not its first message's id ${run.messageIds[0]}`);
  }
}
