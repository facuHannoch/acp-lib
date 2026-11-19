
/** Caller-provided routing and sender identity; not authentication. */
export interface ChannelInput {
  channelId: string;
  participantId: string;
  text: string;
  itemId?: string;
}

export interface ChannelNotice {
  channelId: string;
  fromChannelId: string;
  text: string;
}

// ---- Durable delivery, decision 0013.

export type ItemKind = "participant_message" | "channel_notice";

/** Last confirmed evidence for an accepted input. `received`: committed to the
 * durable inbox. `taken`: committed to the timeline and linked to its turn.
 * `delivered`/`seen`: provider evidence from a request in that turn.
 * `withdrawn`: removed from pending delivery before any take. */
export type ItemMilestone = "received" | "taken" | "delivered" | "seen" | "withdrawn";
// `withdrawn` (decision 0014) is the other terminal state of a `received` item:
// never taken, never in the timeline, never pending again.

/** Acknowledgment of durable acceptance only. It is returned after the inbox
 * commit and says nothing about a reply. A retry with the same ID and payload
 * returns the original item's current state with `duplicate: true`. Completion,
 * replies and failure are observed separately as channel events: the
 * `turn_started`/`turn_took` event listing `itemId` names the turn, and that
 * turn's `message_completed`/`turn_ended` events carry the outcome. */
export type SendResult =
  | { accepted: true; itemId: string; duplicate: boolean; milestone: ItemMilestone; turnId?: number }
  | { accepted: false; error: string;
      code: "invalid_input" | "item_conflict" | "not_running" | "stopped" | "not_found" | "storage_failure"
        /** Decision 0014: the target channel is suspending or suspended. A retry of
         * an already accepted input never gets this; it returns its recorded outcome. */
        | "channel_suspended"
        /** Decision 0014: the channel ID was deleted and is reserved. */
        | "channel_retired" };

/** Shared entity with one delivery behavior for messages and notices: accept
 * durably, then the channel takes the item as soon as it can. An active turn
 * takes it at its next inference boundary; otherwise it starts the channel's
 * next turn. Turns are sequential per channel and concurrent across channels.
 * A failed or interrupted turn ends; its channel keeps accepting and running
 * new work. There is deliberately no wait-for-reply operation here. */
export interface SessionAgent {
  /** No running turn and no pending item that this process may start. */
  idle(): boolean;
  /** Synchronous: returns once the item is committed (Received) or refused. */
  send(input: ChannelInput): SendResult;
  /** Same acceptance for an internal notice; never waits for the target turn. */
  notify(notice: ChannelNotice): SendResult;
}

/** Identity of a live turn handed to composition. `resumed` marks continuation
 * from a suspension checkpoint, where recorded work must not be repeated. */
export interface ActiveTurn { channelId: string; turnId: number; resumed: boolean }

/** The scheduler's durable boundary operations for one running turn. */
export interface TurnPort {
  /** Take pending items into this turn before building the next inference. */
  take(): void;
  /** Record provider evidence after a valid model response for this turn. */
  confirm(milestone: "delivered" | "seen"): void;
  /** Atomic finish decision after a tool-free response: true ends the turn as
   * completed; false means items arrived first and the turn stays open. The
   * loop then returns to the iteration boundary: checkpoint() first, and only
   * if that is false, take() and another inference. */
  finish(): boolean;
  /** At every iteration boundary, before take(): false while neither the
   * session nor this turn's channel is suspending. While either is suspending,
   * checkpoints the turn and returns true; the loop must return "suspended"
   * without taking or inferring. A naturally finished
   * turn never reaches this call, because finish() returned true. */
  checkpoint(): boolean;
  /** Aborted on stop or when this turn is interrupted (decision 0014). Passed to
   * the model and tools; after abort the turn is already interrupted and nothing
   * further may be recorded for it. Interrupting another turn never aborts it. */
  signal: AbortSignal;
}

/** Runs one live turn to its next durable resting point. Rejection fails the turn. */
export type TurnExecutor = (turn: ActiveTurn, port: TurnPort) => Promise<"completed" | "suspended">;
