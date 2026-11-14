import type { Agent, TurnRunner } from "../../contracts/agent.ts";
import type { ExecuteTool, Message, Model } from "../../contracts/loop.ts";
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
  return async (messages, input) => {
    // The kernel invokes this only when the turn leaves its channel queue.
    inspection.running(input.channelId, true);
    try { return await run(messages, input); }
    finally {
      inspection.history(input.channelId, messages);
      inspection.running(input.channelId, false);
    }
  };
}

export function observeModel(
  inspection: Inspection,
  channelId: string,
  messages: Message[],
  createModel: (onRequest: (body: string) => void) => Model,
): Model {
  const model = createModel((body) => {
    // Capture the actual serialized request at the provider boundary, before
    // fetch, rather than reconstructing it later from changing channel history.
    inspection.history(channelId, messages);
    inspection.request(channelId, body);
  });
  return async (history, definitions) => {
    const answer = await model(history, definitions);
    // The loop appends after this returns. Show the response now without
    // modifying the loop's array or mixing inspection metadata into context.
    inspection.history(channelId, [...history, answer]);
    return answer;
  };
}

export function observeTool(
  inspection: Inspection, channelId: string, messages: Message[], execute: ExecuteTool,
): ExecuteTool {
  return async (call) => {
    const content = await execute(call);
    inspection.history(channelId, [...messages, { role: "tool", callId: call.id, content }]);
    return content;
  };
}
