import type { ExecuteTurnTool, Message } from "../contracts/loop.ts";
import type { TurnContext } from "../contracts/context.ts";

/** Run a live turn to its next durable resting point: completed, or
 * checkpointed for suspension. Every pass starts at the iteration boundary. */
export async function runTurn(
  context: TurnContext,
  infer: (signal?: AbortSignal) => Promise<Extract<Message, { role: "assistant" }>>,
  executeTool: ExecuteTurnTool,
): Promise<"completed" | "suspended"> {
  const signal = context.signal;
  while (true) {
    // Suspension wins the boundary: checkpoint without taking input or inferring.
    if (context.checkpoint?.()) return "suspended";
    context.drainNotices?.();
    const answer = await infer(signal);
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
          context.append({ role: "tool", callId: call.id, content: result.content, ...(result.outcome ? { outcome: result.outcome } : {}) });
          // A dispatched call whose executor reported a typed failure, or whose
          // wait ended at its deadline, still has a paired result: the turn goes on.
          const status = result.outcome?.status === "interrupted" ? "interrupted" : result.outcome?.status === "failed" ? "failed" : "completed";
          context.emit?.({ type: "tool_call", id: call.id, name: call.name, status, output: result.content });
        }
      } catch (error) {
        // A stopped turn has already reported its interruption; stay silent after it.
        if (!signal?.aborted) context.emit?.({ type: "tool_call", id: call.id, name: call.name, status: "failed", output: String(error) });
        throw error;
      }
    }
  }
}
