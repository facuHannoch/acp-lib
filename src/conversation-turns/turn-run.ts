/**
 * The run the session sends for a queued prompt (controller-interface spec, Ids). A run's turn id is
 * its first message's id; `messageIds` lists every message it carries, in queue order: one, or each
 * original message of a combined steer run (the list steering reports in `message_delivered`). No
 * new ids are minted.
 */
import type { TurnRun } from "../conversation-controller/contracts.ts";
import { partOf } from "../steering/combine.ts";
import type { PromptQueueItem } from "./context.ts";

export function turnRunOf(prompt: PromptQueueItem): TurnRun {
  const messages = prompt.parts ?? [partOf(prompt)];
  return Object.freeze({
    turnId: prompt.turnId,
    messageIds: Object.freeze(messages.map((message) => message.id)),
    messages: Object.freeze([...messages]),
    operationKind: prompt.operationKind,
  });
}

/** What the session knows about one message named by a run. */
export interface RunMessageState {
  /** Its position in acceptance order (the queue is first in, first out). */
  readonly order: number;
  /** Already taken into a run. */
  readonly dispatched: boolean;
  /** Still waiting in the session's queue. */
  readonly queued: boolean;
}

/**
 * A run must carry at least one message, each once, each one the session accepted and has not
 * settled, taken out of the queue and into no other run, in queue order, the turn id being the
 * first message's id. `lookup` answers from the session's own message state (undefined for an id
 * it does not know). A violation is a bug in building the run: it throws rather than send.
 */
export function checkTurnRun(run: TurnRun, lookup: (messageId: string) => RunMessageState | undefined): void {
  if (run.messageIds.length === 0) throw new Error("a run carries at least one message id");
  const seen = new Set<string>();
  let previous = 0;
  for (const id of run.messageIds) {
    if (seen.has(id)) throw new Error(`a run repeats message id ${id}`);
    seen.add(id);
    const message = lookup(id);
    if (!message) throw new Error(`a run names message id ${id}, which the session does not know`);
    if (message.dispatched) throw new Error(`a run names message id ${id}, which another run already took`);
    if (message.queued) throw new Error(`a run names message id ${id}, which is still queued`);
    if (message.order <= previous) throw new Error(`a run names message id ${id} out of queue order`);
    previous = message.order;
  }
  if (run.messages.length !== run.messageIds.length || run.messages.some((message, index) => message.id !== run.messageIds[index])) {
    throw new Error("a run's messages are not the messages its ids name, in order");
  }
  if (run.turnId !== undefined && run.turnId !== run.messageIds[0]) {
    throw new Error(`a run's turn id ${run.turnId} is not its first message's id ${run.messageIds[0]}`);
  }
}
