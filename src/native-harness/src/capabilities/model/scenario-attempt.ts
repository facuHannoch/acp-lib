import type { ModelAttempt, ModelRequest } from "../../contracts/model-execution.ts";
import type { LoadedScenario } from "../../contracts/scenario.ts";

export function scenarioAttempt(scenario: LoadedScenario, channel: string, step: number, observe?: (request: ModelRequest) => void): ModelAttempt {
  const record = (scenario.channelModels.get(channel) ?? scenario.defaultModels)[step];
  return async function* (request, signal) {
    if (signal.aborted) return;
    observe?.(request);
    if (!record) {
      yield { type: "failure", kind: "provider", message: "script_exhausted" };
      return;
    }
    if (record.delayMs && !await wait(signal, record.delayMs)) return;
    yield { type: "accepted" };
    if (record.usage !== undefined) yield { type: "usage", usage: record.usage };
    for (const chunk of record.chunks ?? []) {
      if (chunk.afterMs && !await wait(signal, chunk.afterMs)) return;
      if (signal.aborted) return;
      if (chunk.text.length) yield { type: "text_delta", text: chunk.text };
    }
    if (record.wait) { await wait(signal); return; }
    if (signal.aborted) return;
    if (record.failure) { yield { type: "failure", ...record.failure }; return; }
    const calls = (record.calls ?? []).map(call => ({ ...call, arguments: JSON.stringify(call.arguments) }));
    yield { type: "response", response: { role: "assistant", content: record.content, calls, stopReason: calls.length ? "tool_calls" : "complete" } };
  };
}

async function wait(signal: AbortSignal, ms?: number): Promise<boolean> {
  if (signal.aborted) return false;
  // A long offset must not overflow the platform timer and fire immediately.
  const end = ms === undefined ? undefined : performance.now() + ms;
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (success: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(success);
    };
    const abort = () => finish(false);
    const arm = () => {
      if (end === undefined) return;
      const remaining = end - performance.now();
      if (remaining <= 0) finish(true);
      else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
    };
    signal.addEventListener("abort", abort, { once: true });
    arm();
  });
}
