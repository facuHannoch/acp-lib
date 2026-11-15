import type { ExecuteTool, Model, ToolDefinition } from "../contracts/loop.ts";
import type { TurnContext } from "../contracts/context.ts";

/** Process an accepted turn until the model returns no tool calls. */
export async function runTurn(
  context: TurnContext,
  model: Model,
  tools: readonly ToolDefinition[],
  executeTool: ExecuteTool,
): Promise<string> {
  while (true) {
    context.drainNotices?.();
    const answer = await model(context.build(), tools);
    // Record the requesting assistant before its results, preserving the order
    // required to pair every tool result with the call that produced it.
    context.append(answer);
    if (answer.calls.length === 0) {
      if (context.finish?.() ?? true) return answer.content ?? "";
      continue;
    }

    for (const call of answer.calls) {
      const content = await executeTool(call);
      context.append({ role: "tool", callId: call.id, content });
    }
  }
}
