/**
 * Turns the backend starts on its own (controller-interface spec, How a turn runs after the refactor):
 * a reported `turn_started` with `sentBySession: false` joins the conversation's operation queue as an
 * item, so it never overlaps another operation, and runs when its turn comes: `turn_started` is emitted
 * when the item runs, then `runTurn` without the ACP content phase (no user record, no ACP input, the
 * session's own recording handlers; supervised and metered like any turn), then completion after
 * finalization. The controller holds the turn's output until its prepared turn's `prompt()` is called.
 * No ACP path reports such a turn; the fake controller and, later, the native controller do.
 */
import type { AgentSessionPromptResult } from "../agent-conversation-contracts.ts";
import type { AgentSessionEvent } from "../agent-conversation-contracts.ts";
import type { ConversationController, TurnCause, TurnStarted } from "../conversation-controller/contracts.ts";
import type { PromptQueueItem, TurnContext } from "./context.ts";
import { copyPromptResult } from "./record-helpers.ts";

/** A reported turn waiting in the queue for its turn to run. */
export interface BackendTurnItem {
  readonly kind: "backend_turn";
  readonly turnId: string;
  readonly cause: TurnCause;
}

/** What the backend-turn path needs from the session. */
export interface BackendTurnHost {
  /** The conversation is stopped (or stopping): a waiting turn is abandoned, not run. */
  readonly stopped: boolean;
  emit(event: AgentSessionEvent): void;
  /** Queues the item and wakes the queue. */
  enqueue(item: BackendTurnItem): void;
  /** Runs the turn through `runTurn` (the session's `runPrompt`). */
  run(turn: TurnContext): Promise<AgentSessionPromptResult>;
}

/**
 * The prompt item a turn without messages is run with: it carries nothing the turn would write or send
 * (no text, no handlers), only what `runTurn`'s metering and persistence need to name the operation.
 */
export function backendTurnItem(turnId: string): PromptQueueItem {
  return {
    kind: "prompt",
    turnId,
    operationKind: "prompt",
    delivery: "queue",
    waited: false,
    text: "",
    resolve: () => undefined,
    reject: () => undefined,
  };
}

/** The controller reported a turn the session didn't send: queue it (or abandon it if the conversation is stopped). */
export function reportBackendTurn(host: BackendTurnHost, controller: ConversationController, event: TurnStarted): void {
  if (host.stopped) {
    controller.abandonTurn(event.turnId, new Error("the conversation is stopped"));
    return;
  }
  host.enqueue({ kind: "backend_turn", turnId: event.turnId, cause: event.cause });
}

/** Runs one queued backend turn: events as for any turn, a failure abandons it. */
export async function runBackendTurn(host: BackendTurnHost, controller: ConversationController, item: BackendTurnItem): Promise<void> {
  if (host.stopped) {
    controller.abandonTurn(item.turnId, new Error("the conversation stopped before the turn ran"));
    return;
  }
  try {
    host.emit({ kind: "turn_started", turnId: item.turnId, cause: item.cause });
    const result = await host.run({ turnId: item.turnId, cause: item.cause });
    host.emit({ kind: "turn_completed", turnId: item.turnId, result: copyPromptResult(result) });
  } catch (error) {
    // A turn that never reached its prepared turn's `prompt()` is released; for one that did, this does nothing.
    controller.abandonTurn(item.turnId, error);
    host.emit({ kind: "turn_failed", turnId: item.turnId, error: String(error) });
  }
}

/**
 * Queue clearing (`interrupt({ clearQueue })`, `stop`): a turn the backend already started is not a queued message.
 * It stays queued and runs, except on stop, where it is abandoned. Returns what is left to drop.
 */
export function settleClearedBackendTurns<T extends { readonly kind: string }>(
  cleared: readonly T[],
  controller: ConversationController,
  stopping: boolean,
  requeue: (turn: BackendTurnItem) => void,
): Array<Exclude<T, BackendTurnItem>> {
  const others: Array<Exclude<T, BackendTurnItem>> = [];
  for (const item of cleared) {
    if (item.kind !== "backend_turn") others.push(item as Exclude<T, BackendTurnItem>);
    else if (stopping) controller.abandonTurn((item as unknown as BackendTurnItem).turnId, new Error("the conversation stopped"));
    else requeue(item as unknown as BackendTurnItem);
  }
  return others;
}
