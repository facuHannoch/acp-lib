import type { Model } from "../../contracts/loop.ts";
import type { ModelAttempt } from "../../contracts/model-execution.ts";

/** Bridge a complete-response adapter through the same validation and commit
 * path as streaming. Errors are provider failures unless classified upstream. */
export function completeModelAttempt(model: Model): ModelAttempt {
  return async function* (request, signal) {
    try {
      const answer = await model(request.messages, request.tools, signal);
      if (signal.aborted) return;
      yield { type: "response", response: { ...answer, stopReason: answer.calls.length ? "tool_calls" : "complete" } };
    } catch (error) {
      if (!signal.aborted) yield { type: "failure", kind: "provider", message: String(error) };
    }
  };
}

/** Assembly attaches a provider-specific attempt to a legacy model identity;
 * the fallback keeps existing embedders on the complete-response path. */
const attempts = new WeakMap<Model, { scripted: boolean; create: (step?: number) => ModelAttempt }>();
export function bindModelAttempt(model: Model, binding: { scripted: boolean; create: (step?: number) => ModelAttempt }): Model {
  attempts.set(model, binding); return model;
}
export function getModelAttempt(model: Model) {
  return attempts.get(model) ?? { scripted: false, create: () => completeModelAttempt(model) };
}
