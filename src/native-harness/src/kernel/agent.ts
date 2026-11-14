import type { Agent, ChannelInput, TurnRunner } from "../contracts/agent.ts";
import type { Message } from "../contracts/loop.ts";

/** Channels survive client disconnection, but not process restart. */
export function createAgent(systemPrompt: string, run: TurnRunner): Agent {
  const channels = new Map<string, {
    messages: Message[];
    queue: Promise<void>;
    failed: boolean;
  }>();

  return {
    send(input: ChannelInput): Promise<string> {
      if (![input.channelId, input.participantId, input.text].every(
        (value) => typeof value === "string" && value.trim().length > 0,
      )) return Promise.reject(new Error("channelId, participantId and text must be nonempty strings"));
      const accepted = { ...input };
      let channel = channels.get(input.channelId);
      if (!channel) {
        channel = {
          messages: [{ role: "system", content: systemPrompt }],
          queue: Promise.resolve(), failed: false,
        };
        channels.set(input.channelId, channel);
      }
      const current = channel;
      // Chain work per channel, not per agent: other channels can advance while
      // this one awaits a model or tool. Copy input before it enters the queue.
      const result = current.queue.then(async () => {
        if (current.failed) throw new Error("Channel stopped after a failed turn; restart the agent to reset it");
        try { return await run(current.messages, accepted); }
        // History may contain an unfinished tool exchange. Replaying or rolling
        // back could duplicate side effects, so this channel stops on failure.
        catch (error) { current.failed = true; throw error; }
      });
      // Keep the queue settled after either outcome so queued callers reach the
      // explicit failed-channel check instead of inheriting an unrelated error.
      current.queue = result.then(() => {}, () => {});
      return result;
    },
  };
}
