import type { SessionAgent } from "../../contracts/agent.ts";
import type { ExecuteTool, ToolDefinition } from "../../contracts/loop.ts";
import { currentTimeDefinition, executeCurrentTime } from "./current-time.ts";
import type { createDashboardWork } from "./dashboard.ts";

export const notifyChannelDefinition: ToolDefinition = {
  name: "notify_channel",
  description: "Deliver important information to an existing channel. Acceptance does not mean the target has acted.",
  parameters: { type: "object", properties: { channelId: { type: "string" }, text: { type: "string" } },
    required: ["channelId", "text"], additionalProperties: false },
};

export function executeNotice(args: Record<string, unknown>, notify: (channel: string, text: string) => ReturnType<SessionAgent["notify"]>) {
  if (!args || Array.isArray(args) || Object.keys(args).some(key => !["channelId", "text"].includes(key))
    || typeof args.channelId !== "string" || !args.channelId.trim() || typeof args.text !== "string" || !args.text.trim())
    throw new Error("notify_channel requires channelId and text");
  const receipt = notify(args.channelId, args.text);
  return receipt.accepted ? { accepted: true } : { accepted: false, error: receipt.error };
}

export const scenarioDefinitions: ToolDefinition[] = [currentTimeDefinition, {
  name: "dashboard_work",
  description: "Perform one of five dashboard implementation steps. Each step takes five seconds. Call at most once per inference, then reconsider the latest information before continuing. No work runs between calls.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
}, notifyChannelDefinition];

export function createScenarioTools(input: { channelId: string; turnId: number }, dashboard: ReturnType<typeof createDashboardWork>, notify: SessionAgent["notify"]) {
  let dashboardCalled = false;
  const execute: ExecuteTool = async call => {
    if (call.name === "current_time") return executeCurrentTime(call);
    console.log(`[tool ${input.channelId}] ${call.name} ${call.arguments}`);
    let result: unknown;
    try {
      const args = JSON.parse(call.arguments);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
      if (call.name === "dashboard_work") {
        if (Object.keys(args).length) throw new Error("dashboard_work requires an empty object");
        if (dashboardCalled) throw new Error("Only one dashboard step per inference; reconsider context before continuing");
        dashboardCalled = true;
        result = await dashboard(input);
      } else if (call.name === "notify_channel") {
        result = executeNotice(args, (channelId, text) => notify({ channelId, text, fromChannelId: input.channelId }));
      } else throw new Error(`Tool not allowed: ${call.name}`);
    } catch (error) { result = { ok: false, error: String(error) }; }
    const content = JSON.stringify(result);
    console.log(`[result ${input.channelId}] ${content}`);
    return content;
  };
  return { execute, beginInference() { dashboardCalled = false; } };
}
