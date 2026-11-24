import { randomUUID } from "node:crypto";
import type { ApprovalAnswer, ApprovalCloseReason, ApprovalRequest, ToolDecision } from "../../contracts/config-permissions.ts";
import type { ToolCall } from "../../contracts/loop.ts";
import type { ToolOutcome } from "../../contracts/tools.ts";

type ClosedCode = ApprovalCloseReason;
type Answer = { allowed: true } | { allowed: false; content: string };
type Entry = { request: ApprovalRequest; granted: boolean; closed: boolean; resolve(answer: Answer): void;
  reject(error: unknown): void; recordError?: unknown; close(code: ClosedCode): string; cleanup(): void; clearTimer(): void };
/** The paired result of a call that was not dispatched. The message tells the
 * model what it can do about it (decision 0021). */
export const skipped = (code: string, detail?: string) => JSON.stringify({ ok: false, code, message: code === "approval_cancelled_by_suspension"
  ? "The tool did not run because the session or channel suspended; after resume request the action again if needed."
  : code === "invalid_arguments" ? `The tool did not run because its arguments are invalid: ${detail ?? "they do not match the tool's schema"}. Correct them and call it again.`
  : code === "tool_unavailable" ? `The tool did not run because it is not available${detail ? ` (${detail})` : ""}. Do not call it again unless it is offered.`
  : `The tool did not run (${code}).` });

/** Requests and unused grants belong to one session's active consumer. Close
 * callbacks record the paired result synchronously before lifecycle termination. */
export function createApprovalService(publish: (request: ApprovalRequest) => void, timeoutMs = 600_000, publishClosed?: (request: ApprovalRequest, reason: ClosedCode | "dispatched") => void) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Approval timeout must be positive");
  let consumer = false;
  const pending = new Map<string, Entry>();
  function close(entry: Entry, code: ClosedCode) { if (!entry.closed) entry.close(code); }
  return {
    setConsumer(enabled: boolean) { if (!enabled) this.disconnect(); else consumer = true; },
    disconnect() { consumer = false; for (const entry of [...pending.values()]) close(entry, "approval_disconnected"); },
    /** Decision 0021: the requests still waiting for an answer. */
    waiting(): ApprovalRequest[] { return [...pending.values()].filter(entry => !entry.closed && !entry.granted).map(entry => entry.request); },
    /** Decision 0021: a tool that became unavailable cannot be approved any more.
     * Closes its open requests with the one paired skipped result. An answer
     * already given is caught by the gate's check after approval. */
    closeTool(tool: string) { for (const entry of [...pending.values()]) if (entry.request.tool === tool && !entry.granted) close(entry, "tool_unavailable"); },
    respond(id: string, answer: ApprovalAnswer) {
      const entry = pending.get(id);
      if (!entry || entry.closed || entry.granted || (answer !== "allow_once" && answer !== "deny")) return false;
      if (answer === "deny") { close(entry, "approval_denied"); return true; }
      entry.granted = true; entry.clearTimer(); entry.resolve({ allowed: true }); return true;
    },
    /** Register before publishing, so even a synchronous consumer can answer. */
    request(request: ApprovalRequest, signal: AbortSignal, suspension: AbortSignal, record: (content: string, code: string) => void) {
      if (!consumer) { const content = skipped("approval_unhandled"); record(content, "approval_unhandled"); return { answer: Promise.resolve({ allowed: false as const, content }), consume: () => false, discard: (_code?: ClosedCode) => false, dispatchClosed: () => {}, dispatchFailed: () => {} }; }
      let settle!: (answer: Answer) => void, reject!: (error: unknown) => void;
      const answer = new Promise<Answer>((resolve, fail) => { settle = resolve; reject = fail; });
      let timer: ReturnType<typeof setTimeout>;
      const onSuspend = () => close(entry, "approval_cancelled_by_suspension");
      const onAbort = () => close(entry, signal.reason?.approvalCloseCode === "approval_cancelled_by_stop"
        ? "approval_cancelled_by_stop" : "approval_cancelled_by_interrupt");
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); suspension.removeEventListener("abort", onSuspend); pending.delete(request.requestId); };
      let announced = false;
      const announceClose = (reason: ClosedCode | "dispatched") => {
        if (announced) { announced = false; publishClosed?.(request, reason); }
      };
      const entry: Entry = { request, granted: false, closed: false, resolve: settle, reject, cleanup, clearTimer: () => clearTimeout(timer),
        close(code) {
          entry.closed = true; cleanup(); const content = skipped(code);
          try { record(content, code); } catch (error) { entry.recordError = error; reject(error); announceClose(code); return content; }
          settle({ allowed: false, content }); announceClose(code); return content;
        } };
      pending.set(request.requestId, entry);
      signal.addEventListener("abort", onAbort, { once: true }); suspension.addEventListener("abort", onSuspend, { once: true });
      timer = setTimeout(() => close(entry, "approval_timeout"), timeoutMs);
      if (signal.aborted) onAbort(); else if (suspension.aborted) onSuspend(); else { announced = true; publish(request); }
      return { answer, consume() { if (entry.recordError !== undefined) throw entry.recordError; if (entry.closed || !entry.granted) return false; entry.closed = true; cleanup(); return true; },
        dispatchClosed() { announceClose("dispatched"); },
        dispatchFailed() { announceClose("approval_cancelled_by_interrupt"); },
        discard(code: ClosedCode = "approval_cancelled_by_interrupt") {
          if (entry.closed) return false;
          entry.closed = true;
          cleanup();
          announceClose(code);
          return true;
        } };
    },
  };
}

/** Policy is read before authorization from items already taken by this
 * turn. The synchronous span after the final signal checks is the linearization
 * point: durable evidence, invocation, started event, then await the promise. */
export async function dispatchWithPolicy(options: {
  decide(): ToolDecision; channel: string; turnId: number; call: ToolCall;
  signal: AbortSignal; suspension: AbortSignal; approvals: ReturnType<typeof createApprovalService>;
  /** May resolve with an outcome to record beside the result (decision 0021). */
  execute: import("../../contracts/loop.ts").ExecuteTurnTool;
  recordSkip(content: string, code: string): void; mark(): void; started(): void; beforeDispatch?: () => Promise<void>;
  /** Decision 0021: a reason this call cannot be dispatched (not offered, not
   * available, invalid arguments), or undefined. Read before authorization
   * and again at the dispatch boundary. Policy denial retains precedence. */
  refuse?(): { code: string; detail?: string } | undefined;
}): Promise<{ content: string; dispatched: boolean; outcome?: ToolOutcome; usage?: import("../../contracts/web.ts").WebResultUsage }> {
  const { call, signal, suspension } = options;
  const skip = (code: string, detail?: string) => { const content = skipped(code, detail); options.recordSkip(content, code); return { content, dispatched: false }; };
  signal.throwIfAborted();
  const refused = options.refuse?.();
  const rule = options.decide();
  if (rule === "deny") return skip("policy_denied");
  if (refused) return skip(refused.code, refused.detail);
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
  // Revocation or removal before dispatch prevents execution even after an
  // approval was given: the grant is discarded and the one paired result says why.
  const late = options.refuse?.();
  if (late) {
    if (request && !request.discard("tool_unavailable")) return { content: "", dispatched: false };
    return skip(late.code, late.detail);
  }
  const currentRule = options.decide();
  if (currentRule === "deny") {
    if (request && !request.discard("tool_unavailable")) return { content: "", dispatched: false };
    return skip("policy_denied");
  }
  // A rule that became ask cannot reuse an earlier allow without a grant.
  if (rule === "allow" && currentRule === "ask") return dispatchWithPolicy(options);
  if (request && !request.consume()) return { content: "", dispatched: false };
  try { options.mark(); } catch (error) { request?.dispatchFailed(); throw error; }
  let result: ReturnType<typeof options.execute>;
  try { result = options.execute(call, signal); }
  catch (error) { options.started(); request?.dispatchClosed(); throw error; }
  options.started();
  request?.dispatchClosed();
  const settled = await result;
  return typeof settled === "string" ? { content: settled, dispatched: true } : { content: settled.content, dispatched: true, outcome: settled.outcome, ...(settled.usage ? { usage: settled.usage } : {}) };
}
