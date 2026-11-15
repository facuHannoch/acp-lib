import type { Agent, TurnRunner } from "../../contracts/agent.ts";
import type { Message, Model } from "../../contracts/loop.ts";
import type { ContextEntry, SharedContextStore } from "../../contracts/context.ts";
import type { Inspection } from "./state.ts";

export function observeAgent(agent: Agent, inspection: Inspection): Agent {
  return {
    async send(input) {
      // Count at submission, before the channel queue starts executing the turn.
      inspection.accepted(input.channelId, input.participantId);
      try {
        const answer = await agent.send(input);
        inspection.finished(input.channelId);
        return answer;
      } catch (error) {
        inspection.finished(input.channelId, String(error));
        throw error;
      }
    },
  };
}

export function observeTurn(run: TurnRunner, inspection: Inspection): TurnRunner {
  return async (input) => {
    // The kernel invokes this only when the turn leaves its channel queue.
    inspection.running(input.channelId, true);
    try { return await run(input); }
    finally {
      inspection.running(input.channelId, false);
    }
  };
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
  return async (messages, tools) => {
    const response = await model(messages, tools);
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
