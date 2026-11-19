import type { SessionAgent } from "../../contracts/agent.ts";
import type { Message, Model } from "../../contracts/loop.ts";
import type { ContextEntry, SharedContextStore } from "../../contracts/context.ts";
import type { EventSink } from "../../contracts/events.ts";
import type { Inspection } from "./state.ts";

/** Count inputs when they are durably accepted, before any turn takes them. */
export function observeAgent(agent: SessionAgent, inspection: Inspection): SessionAgent {
  return {
    idle: () => agent.idle(),
    notify(notice) {
      const result = agent.notify(notice);
      if (result.accepted && !result.duplicate) inspection.accepted(notice.channelId, `channel:${notice.fromChannelId}`);
      return result;
    },
    send(input) {
      const result = agent.send(input);
      if (result.accepted && !result.duplicate) inspection.accepted(input.channelId, input.participantId);
      return result;
    },
  };
}

/** Follow turn activity from committed events: an input stays pending until
 * the turn that took it ends, and several inputs may end with one turn. */
export function observeEvents(subscribe: (listener: EventSink) => () => void, inspection: Inspection) {
  const taken = new Map<string, number>();
  return subscribe(({ channel, event }) => {
    if (event.type === "turn_started" || event.type === "turn_took") {
      taken.set(event.turnId, (taken.get(event.turnId) ?? 0) + event.items.length);
      inspection.running(channel, true);
    } else if (event.type === "turn_resumed") inspection.running(channel, true);
    else if (event.type === "turn_suspended") inspection.running(channel, false);
    else if (event.type === "turn_ended") {
      inspection.running(channel, false);
      const error = event.outcome === "completed" ? undefined : event.error ?? `Turn ${event.outcome}`;
      for (let i = taken.get(event.turnId) ?? 0; i > 0; i--) inspection.finished(channel, error);
      taken.delete(event.turnId);
    }
  });
}

export function observeModel(
  inspection: Inspection,
  channelId: string,
  createModel: (onRequest: (body: string) => void) => Model,
  turnId?: number,
): Model {
  const model = createModel((body) => {
    // Capture the actual serialized request at the provider boundary, before
    // fetch, rather than reconstructing it later from changing channel history.
    inspection.request(channelId, body, turnId);
  });
  return async (messages, tools, signal) => {
    const response = await model(messages, tools, signal);
    inspection.response(channelId, response);
    return response;
  };
}

// Channel history is a projection of the shared store, not an independent log.
export function observeContext(store: SharedContextStore, inspection: Inspection,
  renderBase: (entries: readonly ContextEntry[]) => Message[],
) {
  const update = () => {
    const entries = store.snapshot();
    inspection.sharedContext(entries, renderBase(entries));
  };
  update();
  return store.subscribe(update);
}
