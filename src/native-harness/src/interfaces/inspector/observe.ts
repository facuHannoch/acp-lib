import type { SessionAgent } from "../../contracts/agent.ts";
import type { Message, Model } from "../../contracts/loop.ts";
import type { ContextEntry, SharedContextStore } from "../../contracts/context.ts";
import type { PersistentSession } from "../../contracts/session.ts";
import type { Inspection } from "./state.ts";

/** Keep the inspector's session and channel status equal to storage: once at
 * attach, so restored state is visible before any new message, and again after
 * every acceptance and every committed event. Reading status never starts,
 * resumes or changes work. */
export function observeSession(session: PersistentSession, inspection: Inspection, storage: string) {
  const refresh = () => {
    const view = session.snapshot();
    inspection.status(session.status(), storage, Object.fromEntries(view.channels.map(channel => [channel.channelId,
      [...new Set(view.items.filter(item => item.channelId === channel.channelId).map(item => item.senderId))]])));
  };
  refresh();
  const stopEvents = session.subscribe(refresh), stopLifecycle = session.subscribeSession(refresh);
  const agent: SessionAgent = {
    idle: () => session.agent.idle(),
    send(input) { const result = session.agent.send(input); refresh(); return result; },
    notify(notice) { const result = session.agent.notify(notice); refresh(); return result; },
  };
  return { agent, refresh, stop() { stopEvents(); stopLifecycle(); } };
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
