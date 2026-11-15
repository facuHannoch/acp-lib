import type { Agent, ChannelInput, ChannelNotice, TurnInput, TurnRunner } from "../contracts/agent.ts";
import type { SharedContextStore } from "../contracts/context.ts";

/** Channels survive client disconnection, but not process restart. */
export function createChannelScheduler(store: SharedContextStore, run: TurnRunner): Agent {
  let nextTurnId = 0;
  const channels = new Map<string, {
    queue: Promise<void>;
    failed: boolean;
    active?: { input: TurnInput; notices: ChannelNotice[]; accepting: boolean };
  }>();

  function enqueue(input: ChannelInput, notice?: ChannelNotice): Promise<string> {
    if (![input.channelId, input.participantId, input.text].every(
      (value) => typeof value === "string" && value.trim().length > 0,
    )) return Promise.reject(new Error("channelId, participantId and text must be nonempty strings"));
    const accepted: TurnInput = { ...input, turnId: ++nextTurnId,
      kind: notice ? "channel_notice" : "participant_message", sourceChannelId: notice?.fromChannelId };
    let channel = channels.get(input.channelId);
    if (!channel) {
      channel = {
        queue: Promise.resolve(), failed: false,
      };
      channels.set(input.channelId, channel);
    }
    const current = channel;
    store.append({ channelId: input.channelId, turnId: accepted.turnId, from: input.participantId,
      kind: accepted.kind, sourceChannelId: accepted.sourceChannelId,
      message: { role: "user", content: notice ? notice.text : `Participant: ${JSON.stringify(input.participantId)}\n\n${input.text}` } });
    // Chain work per channel, not per agent: other channels can advance while
    // this one awaits a model or tool. Copy input before it enters the queue.
    const result = current.queue.then(async () => {
      if (current.failed) throw new Error("Channel stopped after a failed turn; restart the agent to reset it");
      const active = { input: accepted, notices: [] as ChannelNotice[], accepting: true };
      current.active = active;
      try { return await run(accepted, {
        drain() {
          for (const notice of active.notices.splice(0)) {
            store.append({ channelId: accepted.channelId, turnId: accepted.turnId,
              from: `channel:${notice.fromChannelId}`, kind: "channel_notice", sourceChannelId: notice.fromChannelId,
              message: { role: "user", content: notice.text } });
          }
        },
        finish() {
          if (active.notices.length) return false;
          // No await between checking the inbox and closing admission. A later
          // notice starts a new turn, even before this promise has settled.
          active.accepting = false;
          return true;
        },
      }); }
      // History may contain an unfinished tool exchange. Replaying or rolling
      // back could duplicate side effects, so this channel stops on failure.
      catch (error) { current.failed = true; throw error; }
      finally { current.active = undefined; }
    });
    // Keep the queue settled after either outcome so queued callers reach the
    // explicit failed-channel check instead of inheriting an unrelated error.
    current.queue = result.then(() => {}, () => {});
    return result;
  }

  const agent: Agent = {
    send: input => enqueue(input),
    notify(notice) {
      if (![notice.channelId, notice.fromChannelId, notice.text].every(
        value => typeof value === "string" && value.trim().length > 0,
      )) return { accepted: false, error: "Notice requires channelId, fromChannelId and text" };
      const channel = channels.get(notice.channelId);
      if (!channel) return { accepted: false, error: `Unknown channel: ${notice.channelId}` };
      if (channel.failed) return { accepted: false, error: "Target channel stopped after a failed turn" };
      if (channel.active?.accepting) {
        channel.active.notices.push({ ...notice });
        return { accepted: true, delivery: "inbox" };
      }
      const completion = enqueue({ channelId: notice.channelId,
        participantId: `channel:${notice.fromChannelId}`,
        text: notice.text }, notice);
      // Acceptance is immediate. The originating model must never await a target
      // turn; two channels may notify one another while both are working.
      void completion.catch(() => {});
      return { accepted: true, delivery: "turn", completion };
    },
  };
  return agent;
}
