
/** Caller-provided routing and sender identity; not authentication. */
export interface ChannelInput {
  channelId: string;
  participantId: string;
  text: string;
}

/** Shared entity accepting independent, sequential-per-channel turns. */
export interface Agent {
  send(input: ChannelInput): Promise<string>;
}

/** Identifies the active turn in the shared record. */
export interface TurnInput extends ChannelInput {
  turnId: number;
}

/** Executes one accepted input; context is supplied by composition. */
export type TurnRunner = (input: TurnInput) => Promise<string>;
