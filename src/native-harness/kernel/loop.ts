import type { ExecuteTool, Message, Model, ToolDefinition } from "../contracts/loop.ts";

/** Append a user turn and run until the model returns no tool calls. */
export async function runTurn(
  messages: Message[],
  prompt: string,
  model: Model,
  tools: readonly ToolDefinition[],
  executeTool: ExecuteTool,
): Promise<string> {
  messages.push({ role: "user", content: prompt });
  while (true) {
    const answer = await model(messages, tools);
    messages.push(answer);
    if (answer.calls.length === 0) return answer.content ?? "";

    for (const call of answer.calls) {
      const content = await executeTool(call);
      messages.push({ role: "tool", callId: call.id, content });
    }
  }
}
