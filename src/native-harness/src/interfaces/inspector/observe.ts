import type { SessionAgent } from "../../contracts/agent.ts";
import type { Model } from "../../contracts/loop.ts";
import type { PersistentSession } from "../../contracts/session.ts";
import type { Inspection } from "./state.ts";

/** Turn and lifecycle events only invalidate the development views. */
export function observeSession(session: PersistentSession, inspection: Inspection) {
  const stopEvents = session.store.subscribe(inspection.invalidate);
  const stopLifecycle = session.subscribeSession(inspection.invalidate);
  const agent: SessionAgent = {
    idle: () => session.agent.idle(),
    send(input) { const result = session.agent.send(input); if (result.accepted && !result.duplicate) inspection.invalidate(); return result; },
    notifyExternal(notice) { const result = session.agent.notifyExternal(notice); if (result.accepted && !result.duplicate) inspection.invalidate(); return result; },
    notify(notice) { const result = session.agent.notify(notice); if (result.accepted && !result.duplicate) inspection.invalidate(); return result; },
  };
  return { agent, stop() { stopEvents(); stopLifecycle(); } };
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
