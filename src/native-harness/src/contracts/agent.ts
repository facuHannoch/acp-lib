
/** Caller-provided routing and sender identity; not authentication. */
export interface ChannelInput {
  channelId: string;
  participantId: string;
  text: string;
  itemId?: string;
}

/** Memory-only revision: send resolves with the turn's final text. Superseded by
 * SessionAgent (decision 0013) and removed when the scheduler moves to storage. */
export interface Agent {
  idle(): boolean;
  send(input: ChannelInput): Promise<string>;
  /** Accept without waiting for target inference, avoiding cross-channel deadlocks. */
  notify(notice: ChannelNotice): NoticeReceipt;
}

export interface ChannelNotice {
  channelId: string;
  fromChannelId: string;
  text: string;
}

/** Completion is for host observation; tools return only acceptance/delivery. */
export type NoticeReceipt = { accepted: false; error: string } | {
  accepted: true;
  delivery: "inbox" | "turn";
  completion?: Promise<string>;
};

export interface TurnMailbox {
  /** Consume pending notices before building the next inference context. */
  drain(): void;
  /** Atomically stop accepting into this turn if no notices remain. */
  finish(): boolean;
}

/** Identifies the active turn in the shared record. */
export interface TurnInput extends ChannelInput {
  turnId: number;
  kind?: "participant_message" | "channel_notice";
  sourceChannelId?: string;
}

/** Executes one accepted input; context is supplied by composition. */
export type TurnRunner = (input: TurnInput, mailbox: TurnMailbox) => Promise<string>;

// ---- Durable delivery, decision 0013. Type-only until the scheduler adopts it.

export type ItemKind = "participant_message" | "channel_notice";

/** Last confirmed evidence for an accepted input. `received`: committed to the
 * durable inbox. `taken`: committed to the timeline and linked to its turn.
 * `delivered`/`seen`: provider evidence from a request in that turn. */
export type ItemMilestone = "received" | "taken" | "delivered" | "seen";

/** Acknowledgment of durable acceptance only. It is returned after the inbox
 * commit and says nothing about a reply. A retry with the same ID and payload
 * returns the original item's current state with `duplicate: true`. Completion,
 * replies and failure are observed separately as channel events: the
 * `turn_started`/`turn_took` event listing `itemId` names the turn, and that
 * turn's `message_completed`/`turn_ended` events carry the outcome. */
export type SendResult =
  | { accepted: true; itemId: string; duplicate: boolean; milestone: ItemMilestone; turnId?: number }
  | { accepted: false; error: string;
      code: "invalid_input" | "item_conflict" | "not_running" | "stopped" | "not_found" | "storage_failure" };

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
  /** Atomic finish decision: true ends the turn as completed; false means
   * items arrived first and the loop must take them and infer again. */
  finish(): boolean;
  /** At an iteration boundary: true when the session is suspending and the turn
   * was checkpointed; the loop must return "suspended" without another inference. */
  checkpoint(): boolean;
  /** Aborted on stop. Passed to the model and tools; after abort the turn is
   * already interrupted and nothing further may be recorded for it. */
  signal: AbortSignal;
}

/** Runs one live turn to its next durable resting point. Rejection fails the turn. */
export type TurnExecutor = (turn: ActiveTurn, port: TurnPort) => Promise<"completed" | "suspended">;
