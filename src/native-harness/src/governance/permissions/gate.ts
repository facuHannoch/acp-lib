import { randomUUID } from "node:crypto";
import type { ApprovalAnswer, ApprovalCloseReason, ApprovalRequest, ToolDecision } from "../../contracts/config-permissions.ts";
import type { ExecuteTool, ToolCall } from "../../contracts/loop.ts";

type ClosedCode = ApprovalCloseReason;
type Answer = { allowed: true } | { allowed: false; content: string };
type Entry = { request: ApprovalRequest; granted: boolean; closed: boolean; resolve(answer: Answer): void;
  reject(error: unknown): void; recordError?: unknown; close(code: ClosedCode): string; cleanup(): void; clearTimer(): void };
const skipped = (code: string) => JSON.stringify({ ok: false, code, message: code === "approval_cancelled_by_suspension"
  ? "The tool did not run because the session or channel suspended; after resume request the action again if needed."
  : `The tool did not run (${code}).` });

/** Requests and unused grants belong to one session's active consumer. Close
 * callbacks record the paired result synchronously before lifecycle termination. */
export function createApprovalService(publish: (request: ApprovalRequest) => void, timeoutMs = 600_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Approval timeout must be positive");
  let consumer = false;
  const pending = new Map<string, Entry>();
  function close(entry: Entry, code: ClosedCode) { if (!entry.closed) entry.close(code); }
  return {
    setConsumer(enabled: boolean) { if (!enabled) this.disconnect(); else consumer = true; },
    disconnect() { consumer = false; for (const entry of [...pending.values()]) close(entry, "approval_disconnected"); },
    respond(id: string, answer: ApprovalAnswer) {
      const entry = pending.get(id);
      if (!entry || entry.closed || entry.granted || (answer !== "allow_once" && answer !== "deny")) return false;
      if (answer === "deny") { close(entry, "approval_denied"); return true; }
      entry.granted = true; entry.clearTimer(); entry.resolve({ allowed: true }); return true;
    },
    /** Register before publishing, so even a synchronous consumer can answer. */
    request(request: ApprovalRequest, signal: AbortSignal, suspension: AbortSignal, record: (content: string) => void) {
      if (!consumer) { const content = skipped("approval_unhandled"); record(content); return { answer: Promise.resolve({ allowed: false as const, content }), consume: () => false, discard: () => {} }; }
      let settle!: (answer: Answer) => void, reject!: (error: unknown) => void;
      const answer = new Promise<Answer>((resolve, fail) => { settle = resolve; reject = fail; });
      let timer: ReturnType<typeof setTimeout>;
      const onSuspend = () => close(entry, "approval_cancelled_by_suspension");
      const onAbort = () => close(entry, signal.reason?.approvalCloseCode === "approval_cancelled_by_stop"
        ? "approval_cancelled_by_stop" : "approval_cancelled_by_interrupt");
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); suspension.removeEventListener("abort", onSuspend); pending.delete(request.requestId); };
      const entry: Entry = { request, granted: false, closed: false, resolve: settle, reject, cleanup, clearTimer: () => clearTimeout(timer),
        close(code) {
          entry.closed = true; cleanup(); const content = skipped(code);
          try { record(content); } catch (error) { entry.recordError = error; reject(error); return content; }
          settle({ allowed: false, content }); return content;
        } };
      pending.set(request.requestId, entry);
      signal.addEventListener("abort", onAbort, { once: true }); suspension.addEventListener("abort", onSuspend, { once: true });
      timer = setTimeout(() => close(entry, "approval_timeout"), timeoutMs);
      if (signal.aborted) onAbort(); else if (suspension.aborted) onSuspend(); else publish(request);
      return { answer, consume() { if (entry.recordError !== undefined) throw entry.recordError; if (entry.closed || !entry.granted) return false; entry.closed = true; cleanup(); return true; },
        discard() { if (!entry.closed) { entry.closed = true; cleanup(); } } };
    },
  };
}

/** Policy is read at the dispatch boundary from items already taken by this
 * turn. The synchronous span after the final signal checks is the linearization
 * point: durable evidence, invocation, started event, then await the promise. */
export async function dispatchWithPolicy(options: {
  decide(): ToolDecision; channel: string; turnId: number; call: ToolCall;
  signal: AbortSignal; suspension: AbortSignal; execute: ExecuteTool; approvals: ReturnType<typeof createApprovalService>;
  recordSkip(content: string): void; mark(): void; started(): void; beforeDispatch?: () => Promise<void>;
}): Promise<{ content: string; dispatched: boolean }> {
  const { call, signal, suspension } = options;
  const rule = options.decide();
  const skip = (code: string) => { const content = skipped(code); options.recordSkip(content); return { content, dispatched: false }; };
  signal.throwIfAborted();
  if (rule === "deny") return skip("policy_denied");
  let request: ReturnType<typeof options.approvals.request> | undefined;
  if (rule === "ask") {
    if (suspension.aborted) return skip("approval_cancelled_by_suspension");
    request = options.approvals.request({ requestId: randomUUID(), channel: options.channel, turnId: String(options.turnId),
      toolCallId: call.id, tool: call.name, arguments: call.arguments }, signal, suspension, options.recordSkip);
    const answer = await request.answer;
    if (!answer.allowed) return { content: answer.content, dispatched: false };
  }
  try { if (options.beforeDispatch) await options.beforeDispatch(); signal.throwIfAborted(); }
  catch (error) { request?.discard(); throw error; }
  if (rule === "ask" && suspension.aborted) {
    // The signal's listener already recorded the one paired cancellation.
    return { content: skipped("approval_cancelled_by_suspension"), dispatched: false };
  }
  if (request && !request.consume()) return { content: "", dispatched: false };
  options.mark();
  let result: Promise<string>;
  try { result = options.execute(call, signal); }
  catch (error) { options.started(); throw error; }
  options.started();
  return { content: await result, dispatched: true };
}
