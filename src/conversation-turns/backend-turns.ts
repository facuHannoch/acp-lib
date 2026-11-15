/**
 * Turns the backend starts on its own (controller-interface spec, How a turn runs after the refactor):
 * a reported `turn_started` with `sentBySession: false` joins the conversation's operation queue as an
 * item, so it never overlaps another operation, and runs when its turn comes: `turn_started` is emitted
 * when the item runs, then `runTurn` without the ACP content phase (no user record, no ACP input, the
 * session's own recording handlers; supervised and metered like any turn), then completion after
 * finalization. The controller holds the turn's output until its prepared turn's `prompt()` is called.
 * No ACP path reports such a turn; the fake controller and, later, the native controller do.
 *
 * A backend-scheduled controller (`nativeSteering`) also decides which turn takes which message: the
 * session hands each message over with `send`, whose queue operation ends when the backend has accepted
 * it, and the message's promise settles with the turn that takes it (named by that turn's cause, extended
 * by `turn_took`): its finalized result when the turn completes, a rejection when it fails.
 */
import type { AgentSessionPromptResult } from "../agent-conversation-contracts.ts";
import type { AgentSessionEvent } from "../agent-conversation-contracts.ts";
import type { ConversationController, TurnCause, TurnStarted, TurnTook } from "../conversation-controller/contracts.ts";
import type { Logger } from "../logger.ts";
import type { PromptQueueItem, TurnContext } from "./context.ts";
import { copyPromptResult } from "./record-helpers.ts";

/**
 * A reported turn waiting in the queue for its turn to run. It remembers the controller that reported it: the
 * turn and its held output belong to that controller, which a handoff queued ahead of it may replace.
 * `cause` and `messageIds` grow when the backend folds more into the turn (`turn_took`).
 */
export interface BackendTurnItem {
  readonly kind: "backend_turn";
  readonly turnId: string;
  cause: TurnCause;
  /** The messages the session sent that this turn took: from its cause and from `turn_took`. */
  readonly messageIds: Set<string>;
  readonly controller: ConversationController;
}

/** The backend-turn path's state: reported turns not yet ended, and messages waiting for the turn that takes them. */
export class BackendTurns {
  readonly #turns = new Map<string, BackendTurnItem>();
  readonly #waiting = new Map<string, PromptQueueItem>();
  /** The backend turn running now (it holds the session's queue), if any. */
  running: string | null = null;

  /** A message handed to a backend-scheduled controller waits for its turn. */
  wait(item: PromptQueueItem): void { this.#waiting.set(item.turnId, item); }
  unwait(messageId: string): void { this.#waiting.delete(messageId); }

  report(item: BackendTurnItem): void { this.#turns.set(item.turnId, item); }

  /** `turn_took`: more folded into a turn that has not ended. False for an unknown or ended turn. */
  took(event: TurnTook): boolean {
    const turn = this.#turns.get(event.turnId);
    if (!turn) return false;
    if (event.cause.kind === "messages") for (const id of event.cause.messageIds) turn.messageIds.add(id);
    turn.cause = mergeCause(turn.cause, event.cause);
    return true;
  }

  /** The turn ended (or was abandoned): its waiting messages settle with `outcome`, and it is forgotten. */
  end(turn: BackendTurnItem, outcome: { result: AgentSessionPromptResult } | { error: unknown }, log?: Logger): void {
    this.#turns.delete(turn.turnId);
    for (const id of turn.messageIds) {
      const message = this.#waiting.get(id);
      if (!message) {
        log?.warn("backend_turn_names_unknown_message", { turnId: turn.turnId, messageId: id }); // recorded, not trusted for settlement
        continue;
      }
      this.#waiting.delete(id);
      if ("result" in outcome) message.resolve(outcome.result);
      else message.reject(outcome.error);
    }
  }

  /** Stop: the waiting messages leave (to be dropped as cancelled) and the turns are forgotten. */
  clear(): PromptQueueItem[] {
    this.#turns.clear();
    const waiting = [...this.#waiting.values()];
    this.#waiting.clear();
    return waiting;
  }
}

/** The turn's cause after `took`: same kind merges, a different kind keeps the original (the ids are tracked separately). */
function mergeCause(cause: TurnCause, took: TurnCause): TurnCause {
  if (cause.kind === "messages" && took.kind === "messages") {
    return { kind: "messages", messageIds: [...new Set([...cause.messageIds, ...took.messageIds])] };
  }
  if (cause.kind === "items" && took.kind === "items") return { kind: "items", items: [...cause.items, ...took.items] };
  return cause;
}

/** What the backend-turn path needs from the session. */
export interface BackendTurnHost {
  readonly turns: BackendTurns;
  readonly log: Logger;
  /** The message left the queue and was handed to the backend. */
  markSent(messageId: string): void;
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
  const item: BackendTurnItem = {
    kind: "backend_turn",
    turnId: event.turnId,
    cause: event.cause,
    messageIds: new Set(event.cause.kind === "messages" ? event.cause.messageIds : []),
    controller,
  };
  host.turns.report(item);
  host.enqueue(item);
}

/** A turn started earlier took more: extend it. One that is unknown to the session, or has ended, is logged and ignored. */
export function reportTurnTook(host: BackendTurnHost, event: TurnTook): void {
  if (!host.turns.took(event)) host.log.warn("controller_turn_took_ignored", { turnId: event.turnId });
}

/**
 * Hands one message to a backend-scheduled controller: no turn id (the backend assigns turn ids), and the queue
 * operation ends when `send` resolves. The message waits for the turn that takes it; a rejected acceptance rejects it.
 */
export async function sendToBackend(host: BackendTurnHost, controller: ConversationController, message: PromptQueueItem): Promise<void> {
  host.turns.wait(message);
  try {
    await controller.send({ messageIds: [message.turnId], operationKind: message.operationKind });
  } catch (error) {
    host.turns.unwait(message.turnId);
    message.reject(error);
  }
}

/**
 * Native steering: while a backend turn runs, a steer message goes to the backend at once, to be folded into that turn,
 * instead of waiting behind it in the queue. Returns whether it was handed over (otherwise the caller queues it).
 */
export function steerIntoRunningTurn(host: BackendTurnHost, controller: ConversationController, message: PromptQueueItem): boolean {
  if (message.delivery !== "steer" || host.turns.running === null || !controller.conversationCapabilities.nativeSteering) return false;
  host.markSent(message.turnId);
  void sendToBackend(host, controller, { ...message, waited: false });
  return true;
}

/**
 * Runs one queued backend turn: events as for any turn, a failure abandons it. `current` is the conversation's live
 * controller: a turn whose controller was replaced while it waited (a handoff queued ahead of it) is abandoned on the
 * controller that reported it, never run on the new one, so nothing stays held. The messages it took settle with it.
 */
export async function runBackendTurn(host: BackendTurnHost, current: ConversationController, item: BackendTurnItem): Promise<void> {
  const controller = item.controller;
  if (host.stopped || current !== controller) {
    const error = new Error(host.stopped ? "the conversation stopped before the turn ran" : "the controller was replaced before the turn ran");
    controller.abandonTurn(item.turnId, error);
    host.turns.end(item, { error }, host.log);
    return;
  }
  host.turns.running = item.turnId;
  try {
    host.emit({ kind: "turn_started", turnId: item.turnId, cause: item.cause });
    const result = await host.run({ turnId: item.turnId, cause: item.cause });
    host.emit({ kind: "turn_completed", turnId: item.turnId, result: copyPromptResult(result) });
    host.turns.end(item, { result }, host.log);
  } catch (error) {
    // A turn that never reached its prepared turn's `prompt()` is released; for one that did, this does nothing.
    controller.abandonTurn(item.turnId, error);
    host.emit({ kind: "turn_failed", turnId: item.turnId, error: String(error) });
    host.turns.end(item, { error }, host.log);
  } finally {
    host.turns.running = null;
  }
}

/**
 * Queue clearing (`interrupt({ clearQueue })`, `stop`): a turn the backend already started is not a queued message.
 * It stays queued and runs, except on stop, where it is abandoned (and forgotten). Returns what is left to drop.
 */
export function settleClearedBackendTurns<T extends { readonly kind: string }>(
  cleared: readonly T[],
  stopping: boolean,
  requeue: (turn: BackendTurnItem) => void,
): Array<Exclude<T, BackendTurnItem>> {
  const others: Array<Exclude<T, BackendTurnItem>> = [];
  for (const item of cleared) {
    if (item.kind !== "backend_turn") others.push(item as Exclude<T, BackendTurnItem>);
    else if (stopping) (item as unknown as BackendTurnItem).controller.abandonTurn((item as unknown as BackendTurnItem).turnId, new Error("the conversation stopped"));
    else requeue(item as unknown as BackendTurnItem);
  }
  return others;
}
