import type { Model } from "../contracts/loop.ts";

/** Non-streaming adapter. Opaque assistant fields stay with OpenRouter. */
export function openRouter(apiKey: string, model: string, onRequest?: (body: string) => void): Model {
  return async (messages, tools) => {
    const body = JSON.stringify({
        model,
        messages: messages.map((message) => {
          if (message.role === "assistant") return message.providerState ?? {
            role: "assistant", content: message.content,
            ...(message.calls.length ? { tool_calls: message.calls.map((call) => ({
              id: call.id, type: "function",
              function: { name: call.name, arguments: call.arguments },
            })) } : {}),
          };
          if (message.role === "tool") return {
            role: "tool", content: message.content, tool_call_id: message.callId,
          };
          return message;
        }),
        ...(tools.length ? { tools: tools.map((tool) => ({ type: "function", function: tool })) } : {}),
      });
    onRequest?.(body);
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body,
    });
    if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}: ${await response.text()}`);
    const payload = await response.json() as {
      choices?: { finish_reason: string; message: {
        role: "assistant"; content: string | null;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      } }[];
    };
    const choice = payload.choices?.[0];
    if (!choice || !["stop", "tool_calls"].includes(choice.finish_reason)) {
      throw new Error(`Incomplete model response: ${choice?.finish_reason ?? "no choice"}`);
    }
    const answer = choice.message;
    return {
      role: "assistant", content: answer.content,
      calls: (answer.tool_calls ?? []).map((call) => ({
        id: call.id, name: call.function.name, arguments: call.function.arguments,
      })),
      providerState: answer,
    };
  };
}
