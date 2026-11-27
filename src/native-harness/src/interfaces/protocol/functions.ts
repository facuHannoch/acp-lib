import type { RpcCallbackCancel, RpcCallbackRequest, RpcCallbackResponse } from "../../contracts/protocol.ts";
import { WORKER_APPROVAL_READ, type ReadWorkerApprovals, type WorkerApprovalView } from "../../contracts/worker-approvals.ts";
import type { PersistentSession } from "../../contracts/session.ts";
import type { FunctionExecutor, FunctionResult, ResultPage } from "../../contracts/tools.ts";
import { CallbackFailure, CallbackLost } from "../../capabilities/tools/runtime/functions.ts";
import { MAX_FRAME_BYTES } from "./framing.ts";

/** A refused tool request, with a stable protocol code. */
export class ToolFault extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Requests from the harness to the host over one connection (decision 0021).
 * Each wait is keyed by its own request ID, so answers to concurrent callbacks
 * cannot be confused. A wait is closed by its answer, by cancellation or by
 * the connection going away; an answer for a closed wait is ignored. */
export function createCallbackBridge(emit: (message: RpcCallbackRequest | RpcCallbackCancel) => void) {
  let nextId = 0, connected = true;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  function ask<T>(method: RpcCallbackRequest["method"], params: any, signal: AbortSignal, cancel?: () => void): Promise<T> {
    if (!connected) return Promise.reject(new CallbackLost("The host connection is closed"));
    if (signal.aborted) return Promise.reject(signal.reason);
    const id = ++nextId, message = { jsonrpc: "2.0" as const, id, method, params } as RpcCallbackRequest;
    // Nothing was sent, so this is a known failure and not an uncertain call.
    if (new TextEncoder().encode(JSON.stringify(message)).length > MAX_FRAME_BYTES - 1024)
      return Promise.reject(new CallbackFailure("request_too_large", "The call's arguments do not fit one protocol frame"));
    return new Promise<T>((resolve, reject) => {
      const close = () => { waiting.delete(id); signal.removeEventListener("abort", aborted); };
      const aborted = () => { close(); try { cancel?.(); } catch { /* The connection may be gone. */ } reject(signal.reason); };
      waiting.set(id, { resolve: value => { close(); resolve(value as T); }, reject: error => { close(); reject(error); } });
      signal.addEventListener("abort", aborted, { once: true });
      try { emit(message); } catch (error) { close(); reject(new CallbackLost(String(error))); }
    });
  }
  const executor: FunctionExecutor = {
    call: (request, signal) => ask<FunctionResult>("functions/call", request, signal, () => emit({ jsonrpc: "2.0", method: "functions/cancel",
      params: { invocationId: request.invocationId, reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "cancelled") } })),
    read: (request, signal) => ask<ResultPage>("results/read", request, signal),
  };
  const readWorkerApprovals: ReadWorkerApprovals = (query, signal) =>
    ask<readonly WorkerApprovalView[]>(WORKER_APPROVAL_READ, query, signal);
  return {
    executor, readWorkerApprovals,
    /** The host's answer. Unknown, repeated and late IDs are ignored. */
    respond(response: RpcCallbackResponse) {
      const wait = response && Number.isSafeInteger(response.id) ? waiting.get(response.id) : undefined;
      if (!wait) return;
      if ("error" in response && response.error) wait.reject(new CallbackFailure(
        typeof response.error.data?.code === "string" && response.error.data.code ? response.error.data.code : "handler_failed", String(response.error.message ?? "The handler failed")));
      else wait.resolve((response as { result: unknown }).result);
    },
    /** The connection is gone: every open wait ends without an outcome. */
    disconnect() {
      connected = false;
      for (const wait of [...waiting.values()]) wait.reject(new CallbackLost("The host connection closed before the call was answered"));
    },
    outstanding: () => waiting.size,
  };
}

const TOOL_METHODS = ["session/tools", "tool/revoke", "tool/restore", "tool/enable", "tool/remove", "session/tool-invocation", "session/tool-invocations"];
export const toolMethods = (): string[] => [...TOOL_METHODS];
export const isToolMethod = (method: string) => TOOL_METHODS.includes(method);

/** The catalog and invocation methods. A session without a catalog has no
 * tools to list or change and no consumer invocations beyond its records. */
export function toolRequest(session: PersistentSession, method: string, p: Record<string, any>): unknown {
  const only = (names: string[]) => { for (const key of Object.keys(p)) if (!names.includes(key)) throw new ToolFault("invalid_params", `Unsupported field: ${key}`); };
  const word = (value: unknown) => { if (typeof value !== "string" || !value.trim()) throw new ToolFault("invalid_params", "Expected a nonempty string"); return value; };
  const tools = session.tools;
  if (method === "session/tools") { only([]); return { tools: tools?.list() ?? [] }; }
  if (!tools) throw new ToolFault("not_found", "This session has no tool catalog");
  if (method === "session/tool-invocation") {
    only(["invocationId"]);
    const invocation = tools.invocation(word(p.invocationId));
    if (!invocation) throw new ToolFault("not_found", "Unknown invocation");
    return { invocation };
  }
  if (method === "session/tool-invocations") {
    only(["turn"]);
    const raw = word(p.turn), turn = Number(raw);
    if (!Number.isSafeInteger(turn) || turn < 1 || String(turn) !== raw) throw new ToolFault("invalid_params", "Expected a turn ID");
    return { invocations: tools.invocations(turn) };
  }
  only(["name"]);
  const name = word(p.name);
  const result = method === "tool/revoke" ? tools.revoke(name) : method === "tool/restore" ? tools.restore(name) : method === "tool/enable" ? tools.enable(name) : tools.remove(name);
  if (!result.ok) throw new ToolFault(result.error.code, result.error.message);
  return { tool: result.value };
}
