
/** Caller-provided routing and sender identity; not authentication. */
export interface ChannelInput {
  channelId: string;
  participantId: string;
  text: string;
}

/** Shared entity accepting independent, sequential-per-channel turns. */
export interface Agent {
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
