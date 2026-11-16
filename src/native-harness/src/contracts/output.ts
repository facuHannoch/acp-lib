/** One completed assistant message or turn failure, including notice turns. */
export interface ChannelOutput {
  channelId: string;
  turnId: number;
  type: "reply" | "error";
  text: string;
}

/** Host-owned delivery port. Subscribers receive future events for one channel. */
export interface ChannelOutputs {
  publish(output: ChannelOutput): void;
  subscribe(channelId: string, listener: (output: ChannelOutput) => void): () => void;
}
