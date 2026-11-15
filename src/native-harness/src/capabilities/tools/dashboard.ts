import type { TurnInput } from "../../contracts/agent.ts";

/** One process-wide simulated job; nothing runs between explicit tool calls. */
export function createDashboardWork(wait = () => new Promise<void>(resolve => setTimeout(resolve, 8000))) {
  let completedSteps = 0;
  let working = false;
  return async (input: TurnInput) => {
    const origin = { channelId: input.channelId, turnId: input.turnId };
    if (working) return { ok: false, status: "busy", completedSteps, totalSteps: 5, ...origin };
    if (completedSteps === 5) return { ok: true, status: "completed", completedSteps, totalSteps: 5, ...origin };
    working = true;
    try {
      await wait();
      completedSteps++;
      return { ok: true, status: completedSteps === 5 ? "completed" : "in_progress", completedSteps, totalSteps: 5, ...origin };
    } finally { working = false; }
  };
}
