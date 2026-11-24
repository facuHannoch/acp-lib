import type { ModelAttempt, ModelAttemptEvent, ModelCallStore, ModelExecutionSettings, ModelRequest, ModelResponse, CallOutcome } from "../../contracts/model-execution.ts";
import type { StorageResult, TimelineEntry } from "../../contracts/storage.ts";

/** One deadline covers the first attempt, retry wait and retry. */
export const MODEL_EXECUTION_DEFAULTS: Readonly<ModelExecutionSettings> = { timeoutMs: 120_000, retryDelayMs: 1_000, maxRetries: 1 };
export class ModelCallError extends Error {
  constructor(readonly outcome: Exclude<CallOutcome, "running" | "succeeded">, message: string) { super(message); this.name = "ModelCallError"; }
}
class ModelStorageError extends Error {}
function take<T>(result: StorageResult<T>): T {
  if (!result.ok) throw new ModelStorageError(`Model call storage ${result.error.code}: ${result.error.message}`);
  return result.value;
}
function validResponse(response: ModelResponse): boolean {
  if (!response || response.role !== "assistant" || !(response.content === null || typeof response.content === "string") || !Array.isArray(response.calls)) return false;
  if (!(response.stopReason === "complete" && response.calls.length === 0 || response.stopReason === "tool_calls" && response.calls.length > 0 || response.stopReason === "output_limit")) return false;
  const ids = new Set<string>();
  for (const call of response.calls) {
    if (!call || typeof call.id !== "string" || !call.id.trim() || ids.has(call.id) || typeof call.name !== "string" || !call.name.trim() || typeof call.arguments !== "string") return false;
    try { const args: unknown = JSON.parse(call.arguments); if (!args || typeof args !== "object" || Array.isArray(args)) return false; } catch { return false; }
    ids.add(call.id);
  }
  return true;
}
export interface RunModelCallOptions {
  turnId: string; itemIds: readonly string[]; request: ModelRequest; scripted: boolean;
  store: ModelCallStore; attempt: (scriptStep?: number, ordinal?: number) => ModelAttempt;
  signal?: AbortSignal; settings?: Partial<ModelExecutionSettings>;
  /** Called synchronously; never wait for a reader. */
  delta?: (event: { messageId: string; text: string }) => void;
  incomplete?: (event: { messageId: string; reason: Exclude<CallOutcome, "running" | "succeeded"> }) => void;
  receipt?: (milestone: "delivered" | "seen", items: string[], revision: number) => void;
  /** The durable call record exists: its ID, before any attempt starts. */
  started?: (callId: string) => void;
}
/** Run one frozen request; only commitResponse can produce a dispatchable answer. */
export async function runModelCall(options: RunModelCallOptions): Promise<{ response: ModelResponse; messageId: string; entry: TimelineEntry; revision: number }> {
  const settings = { ...MODEL_EXECUTION_DEFAULTS, ...options.settings };
  const request = structuredClone(options.request);
  const call = take(options.store.startCall(options.turnId, options.itemIds));
  options.started?.(call.callId);
  let deadline = 0, output = false;
  const finish = (outcome: Exclude<CallOutcome, "running" | "succeeded">, detail: string = outcome): never => {
    const result = options.store.finishCall(call.callId, outcome);
    if (!result.ok && !(outcome === "interrupted" && result.error.code === "invalid_state")) take(result);
    if (output) options.incomplete?.({ messageId: call.messageId, reason: outcome });
    throw new ModelCallError(outcome, detail);
  };
  for (let ordinal = 0; ordinal <= Math.min(1, settings.maxRetries); ordinal++) {
    if (options.signal?.aborted) return finish("interrupted");
    const attempt = take(options.store.startAttempt(call.callId, options.scripted));
    if (!deadline) deadline = Date.now() + settings.timeoutMs;
    const controller = new AbortController();
    let cancel!: (reason: "timeout" | "interrupted") => void;
    const cancelled = new Promise<{ reason: "timeout" | "interrupted" }>(resolve => { cancel = reason => resolve({ reason }); });
    const abort = () => { controller.abort(); cancel("interrupted"); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => { controller.abort(); cancel("timeout"); }, Math.max(0, deadline - Date.now()));
    let terminal: ModelAttemptEvent | undefined;
    let cancellation: "timeout" | "interrupted" | undefined;
    try {
      const iterator = options.attempt(attempt.scriptStep, attempt.ordinal)(structuredClone(request), controller.signal)[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([iterator.next().then(value => ({ value })), cancelled]);
        if ("reason" in next) { cancellation = next.reason; break; }
        if (next.value.done) break;
        const event = next.value.value;
        if (event.type === "response" || event.type === "failure") { terminal = event; break; }
        if (event.type === "accepted") {
          if (event.providerRequestId) take(options.store.recordProviderRequestId(call.callId, attempt.attemptId, event.providerRequestId));
          const result = options.store.confirm(call.callId, attempt.attemptId, "delivered"); const items = take(result); if (result.ok && items.length) options.receipt?.("delivered", items, result.revision);
        } else if (event.type === "seen" || event.type === "text_delta" && event.text.length) {
          const result = options.store.confirm(call.callId, attempt.attemptId, "seen"); const items = take(result); if (result.ok && items.length) options.receipt?.("seen", items, result.revision);
          if (event.type === "text_delta") { output = true; options.delta?.({ messageId: call.messageId, text: event.text }); }
        } else if (event.type === "usage") take(options.store.recordUsage(call.callId, attempt.attemptId, event.usage));
      }
    } catch (error) { if (error instanceof ModelStorageError) throw error; terminal = { type: "failure", kind: "provider", message: String(error) }; }
    finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); controller.abort(); }
    if (options.signal?.aborted || cancellation === "interrupted") {
      // The lifecycle transaction may already have ended this call. In that
      // case its invalid_state fence is the durable cancellation record.
      const ended = options.store.finishAttempt(call.callId, attempt.attemptId, "interrupted");
      if (!ended.ok && ended.error.code === "invalid_state") { if (output) options.incomplete?.({ messageId: call.messageId, reason: "interrupted" }); throw new ModelCallError("interrupted", "interrupted"); }
      take(ended); return finish("interrupted");
    }
    if (Date.now() >= deadline || cancellation === "timeout") {
      take(options.store.finishAttempt(call.callId, attempt.attemptId, "timeout")); return finish("timeout");
    }
    if (terminal?.type === "response") {
      if (terminal.providerRequestId) take(options.store.recordProviderRequestId(call.callId, attempt.attemptId, terminal.providerRequestId));
      if (!validResponse(terminal.response)) { take(options.store.finishAttempt(call.callId, attempt.attemptId, "invalid_request")); return finish("failed"); }
      const result = options.store.confirm(call.callId, attempt.attemptId, "seen"); const items = take(result); if (result.ok && items.length) options.receipt?.("seen", items, result.revision);
      if (terminal.response.stopReason === "output_limit") { take(options.store.finishAttempt(call.callId, attempt.attemptId, "output_limit")); return finish("output_limit"); }
      const committed = options.store.commitResponse(call.callId, attempt.attemptId, terminal.response, terminal.providerRequestId);
      const entry = take(committed);
      if (!committed.ok) throw new ModelStorageError(committed.error.message);
      return { response: terminal.response, messageId: call.messageId, entry, revision: committed.revision };
    }
    if (terminal?.type === "failure" && terminal.providerRequestId) take(options.store.recordProviderRequestId(call.callId, attempt.attemptId, terminal.providerRequestId));
    const failure = terminal?.type === "failure" ? terminal.kind : "incomplete";
    const attemptOutcome = failure === "transient" ? "transient_failure" : failure === "provider" ? "provider_failure" : failure;
    take(options.store.finishAttempt(call.callId, attempt.attemptId, attemptOutcome));
    if (terminal?.type === "failure" && terminal.message === "script_exhausted" && options.scripted) return finish("failed", "script_exhausted");
    if (terminal?.type === "failure" && terminal.code) return finish("failed", JSON.stringify({ code: terminal.code, attachmentIds: terminal.attachmentIds ?? [] }));
    if (failure !== "transient" || output || ordinal >= Math.min(1, settings.maxRetries)) return finish(failure === "incomplete" ? "incomplete" : "failed");
    if (deadline - Date.now() < settings.retryDelayMs) return finish("timeout");
    const delay = await new Promise<"ready" | "interrupted">(resolve => {
      const done = (result: "ready" | "interrupted") => { clearTimeout(wait); options.signal?.removeEventListener("abort", interrupted); resolve(result); };
      const interrupted = () => done("interrupted"); const wait = setTimeout(() => done("ready"), settings.retryDelayMs);
      options.signal?.addEventListener("abort", interrupted, { once: true }); if (options.signal?.aborted) interrupted();
    });
    if (delay === "interrupted") return finish("interrupted");
    if (Date.now() >= deadline) return finish("timeout");
  }
  return finish("failed");
}
