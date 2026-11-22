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
import type { PromptHandlers } from "../types.ts";
import type { PromptQueueItem, TurnContext } from "./context.ts";
import { copyPromptResult } from "./record-helpers.ts";
import { turnRunOf } from "./turn-run.ts";

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
  readonly permissionHandler?: PromptHandlers["onPermissionRequest"];
}

/** The backend-turn path's state: reported turns not yet ended, and messages waiting for the turn that takes them. */
/**
 * Where a message handed to a backend-scheduled controller is: `sending` (`send` has not resolved yet), `waiting` (accepted,
 * no turn has claimed it: the only state a local withdraw or `clearQueue` may cancel), or `taken` (a turn's cause or a
 * `turn_took` names it: that turn owns its settlement).
 */
type MessageState = "sending" | "waiting" | "taken";

export class BackendTurns {
  readonly #turns = new Map<string, BackendTurnItem>();
  readonly #messages = new Map<string, { readonly item: PromptQueueItem; state: MessageState }>();
  /** The backend turn running now (it holds the session's queue), if any. */
  running: string | null = null;

  /** A message is handed to a backend-scheduled controller: `send` is in flight. */
  wait(item: PromptQueueItem): void { this.#messages.set(item.turnId, { item, state: "sending" }); }
  /** `send` resolved: the message is accepted (unless a turn already claimed it meanwhile). */
  accepted(messageId: string): void {
    const message = this.#messages.get(messageId);
    if (message?.state === "sending") message.state = "waiting";
  }
  unwait(messageId: string): void { this.#messages.delete(messageId); }

  report(item: BackendTurnItem): void {
    this.#turns.set(item.turnId, item);
    this.#claim(item.messageIds);
  }

  /** A turn names these messages: they are its to settle now, and no local withdraw or clear may cancel them. */
  #claim(ids: Iterable<string>): void {
    for (const id of ids) {
      const message = this.#messages.get(id);
      if (message) message.state = "taken";
    }
  }

  /** `turn_took`: more folded into a turn that has not ended. False for an unknown or ended turn. */
  took(event: TurnTook): boolean {
    const turn = this.#turns.get(event.turnId);
    if (!turn) return false;
    for (const id of event.cause.messageIds ?? []) turn.messageIds.add(id);
    this.#claim(event.cause.messageIds ?? []);
    turn.cause = mergeCause(turn.cause, event.cause);
    return true;
  }

  /** The turn ended (or was abandoned): the messages it took settle with `outcome`, and it is forgotten. */
  end(turn: BackendTurnItem, outcome: { result: AgentSessionPromptResult } | { error: unknown }, log?: Logger): void {
    this.#turns.delete(turn.turnId);
    for (const id of turn.messageIds) {
      const message = this.#messages.get(id);
      if (!message) {
        log?.warn("backend_turn_names_unknown_message", { turnId: turn.turnId, messageId: id }); // recorded, not trusted for settlement
        continue;
      }
      this.#messages.delete(id);
      if ("result" in outcome) message.item.resolve(outcome.result);
      else message.item.reject(outcome.error);
    }
  }

  /**
   * The handlers a turn that took these messages runs with: those of the first message, in the order
   * given, that brought any. A message folded in later (`turn_took`) does not change them.
   */
  handlersOf(ids: Iterable<string>): PromptHandlers | undefined {
    for (const id of ids) {
      const handlers = this.#messages.get(id)?.item.handlers;
      if (handlers) return handlers;
    }
    return undefined;
  }

  permissionHandlerOf(ids: Iterable<string>): PromptHandlers["onPermissionRequest"] {
    for (const id of ids) {
      const handler = this.#messages.get(id)?.item.handlers?.onPermissionRequest;
      if (handler) return handler;
    }
  }

  /** One accepted, unclaimed message leaves (to be dropped as cancelled); undefined for any other (in flight, taken, unknown). */
  take(messageId: string): PromptQueueItem | undefined {
    const message = this.#messages.get(messageId);
    if (message?.state !== "waiting") return undefined;
    this.#messages.delete(messageId);
    return message.item;
  }

  /**
   * `interrupt({ clearQueue })`: the accepted, unclaimed messages leave (to be dropped as cancelled); messages in flight or
   * taken by a turn stay. Stop: every message leaves and the turns are forgotten.
   */
  clear(stopping: boolean): PromptQueueItem[] {
    const leaving = [...this.#messages].filter(([, message]) => stopping || message.state === "waiting");
    for (const [id] of leaving) this.#messages.delete(id);
    if (stopping) this.#turns.clear();
    return leaving.map(([, message]) => message.item);
  }
}

/** The turn's cause after `took`: both lists grow (a cause can hold messages and items together). */
function mergeCause(cause: TurnCause, took: TurnCause): TurnCause {
  const messageIds = [...new Set([...(cause.messageIds ?? []), ...(took.messageIds ?? [])])];
  const items = [...(cause.items ?? []), ...(took.items ?? [])];
  return { ...(messageIds.length > 0 ? { messageIds } : {}), ...(items.length > 0 ? { items } : {}) } as TurnCause;
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
export function backendTurnItem(turnId: string, handlers?: PromptHandlers): PromptQueueItem {
  return {
    kind: "prompt",
    turnId,
    operationKind: "prompt",
    delivery: "queue",
    waited: false,
    text: "",
    ...(handlers ? { handlers } : {}),
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
    messageIds: new Set(event.cause.messageIds ?? []),
    permissionHandler: host.turns.permissionHandlerOf(event.cause.messageIds ?? []),
    controller,
  };
  host.turns.report(item);
  host.enqueue(item);
}

const isBackendTurn = (item: { readonly kind: string }): item is BackendTurnItem => item.kind === "backend_turn";

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
    // No turn id: the backend assigns turn ids. The message goes as the queue holds it.
    const { turnId: _sessionTurnId, ...run } = turnRunOf(message);
    await controller.send(run);
    host.turns.accepted(message.turnId);
  } catch (error) {
    host.turns.unwait(message.turnId);
    message.reject(error);
  }
}

/**
 * Withdraws a message the backend accepted and no turn has taken yet: it resolves as cancelled and the wait ends. Local only
 * (the backend is not told; a turn that later names the id finds it unknown and ignores it). False when it isn't waiting.
 */
export function withdrawWaiting(turns: BackendTurns, messageId: string, drop: (messages: PromptQueueItem[]) => void): boolean {
  const message = turns.take(messageId);
  if (message) drop([message]);
  return message !== undefined;
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
    // The consumer's own handlers, when a message the turn took brought them: its stream and its
    // permission requests reach the consumer that sent the message, as for a turn the session sends.
    const streamHandlers = host.turns.handlersOf(item.messageIds);
    const handlers = streamHandlers && { ...streamHandlers, onPermissionRequest: item.permissionHandler };
    const result = await host.run({ turnId: item.turnId, get cause() { return item.cause; }, ...(handlers ? { handlers } : {}) });
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
    if (!isBackendTurn(item)) others.push(item as Exclude<T, BackendTurnItem>);
    else if (stopping) item.controller.abandonTurn(item.turnId, new Error("the conversation stopped"));
    else requeue(item);
  }
  return others;
}
