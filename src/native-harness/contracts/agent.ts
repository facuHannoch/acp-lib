import type { Message } from "./loop.ts";

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

/** Executes one turn against the channel's mutable history. */
export type TurnRunner = (messages: Message[], input: ChannelInput) => Promise<string>;
