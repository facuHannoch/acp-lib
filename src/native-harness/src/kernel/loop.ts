import type { ExecuteTool, Model, ToolDefinition } from "../contracts/loop.ts";
import type { TurnContext } from "../contracts/context.ts";

/** Run a live turn to its next durable resting point: completed, or
 * checkpointed for suspension. Every pass starts at the iteration boundary. */
export async function runTurn(
  context: TurnContext,
  model: Model,
  tools: readonly ToolDefinition[],
  executeTool: ExecuteTool,
): Promise<"completed" | "suspended"> {
  const signal = context.signal;
  while (true) {
    // Suspension wins the boundary: checkpoint without taking input or inferring.
    if (context.checkpoint?.()) return "suspended";
    context.drainNotices?.();
    const answer = await model(context.build(), tools, signal);
    // A stopped turn is already interrupted; its late answer must not be recorded.
    signal?.throwIfAborted();
    // Record the requesting assistant before its results, preserving the order
    // required to pair every tool result with the call that produced it.
    // A resolved model call is the provider's evidence for this turn's inputs.
    // It is recorded first so its event precedes the message it enabled.
    context.confirm?.("seen");
    context.append(answer);
    if (answer.content) context.emit?.({ type: "message_completed", parts: [{ type: "text", text: answer.content }] });
    if (answer.calls.length === 0) {
      if (context.finish?.() ?? true) return "completed";
      continue;
    }

    for (const call of answer.calls) {
      context.emit?.({ type: "tool_call", id: call.id, name: call.name, status: "started", input: call.arguments });
      try {
        const content = await executeTool(call, signal);
        signal?.throwIfAborted();
        context.append({ role: "tool", callId: call.id, content });
        context.emit?.({ type: "tool_call", id: call.id, name: call.name, status: "completed", output: content });
      } catch (error) {
        context.emit?.({ type: "tool_call", id: call.id, name: call.name, status: "failed", output: String(error) });
        throw error;
      }
    }
  }
}
