import type { SessionAgent } from "../../../contracts/agent.ts";
import type { ToolDefinition } from "../../../contracts/loop.ts";

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
