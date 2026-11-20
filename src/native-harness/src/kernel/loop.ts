import type { ExecuteTool, Model, ToolDefinition } from "../contracts/loop.ts";
import type { TurnContext } from "../contracts/context.ts";

/** Run a live turn to its next durable resting point: completed, or
 * checkpointed for suspension. Every pass starts at the iteration boundary. */
export async function runTurn(
  context: TurnContext,
  infer: Model,
  tools: readonly ToolDefinition[],
  executeTool: ExecuteTool,
): Promise<"completed" | "suspended"> {
  const signal = context.signal;
  while (true) {
    // Suspension wins the boundary: checkpoint without taking input or inferring.
    if (context.checkpoint?.()) return "suspended";
    context.drainNotices?.();
    const answer = await infer(context.build(), tools, signal);
    // A stopped turn is already interrupted; its late answer must not be recorded.
    signal?.throwIfAborted();
    // The injected inference boundary returns only a committed response.
    if (answer.calls.length === 0) {
      if (context.finish?.() ?? true) return "completed";
      continue;
    }

    for (const call of answer.calls) {
      try {
        const result = await context.dispatchTool(call, executeTool);
        signal?.throwIfAborted();
        // A skip is already paired synchronously by the gate, so interruption
        // cannot end a turn between its approval closure and its result commit.
        if (result.dispatched) {
          context.append({ role: "tool", callId: call.id, content: result.content });
          context.emit?.({ type: "tool_call", id: call.id, name: call.name, status: "completed", output: result.content });
        }
      } catch (error) {
        // A stopped turn has already reported its interruption; stay silent after it.
        if (!signal?.aborted) context.emit?.({ type: "tool_call", id: call.id, name: call.name, status: "failed", output: String(error) });
        throw error;
      }
    }
  }
}
