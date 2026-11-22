import type { StorageSnapshot } from "../../contracts/storage.ts";
import type { FunctionCall, FunctionExecutor, ResultReference, ToolLimits, ToolOutcome, ToolRegistration } from "../../contracts/tools.ts";

/** Adjustable defaults (BUSINESS_RULES.md, tools and callbacks). */
export const TOOL_LIMITS: Readonly<ToolLimits> = { inlineBytes: 16_384, previewBytes: 1_024, readBytes: 16_384 };

/** The wait for a callback ended for a reason that says nothing about its
 * effect on the host: the connection is gone. The call stays dispatched with
 * no result, so recovery reports it uncertain and nothing repeats it. */
export class CallbackLost extends Error {
  constructor(message: string) { super(message); this.name = "CallbackLost"; }
}
/** A typed failure from the handler or the host: `{ code, message }`. */
export class CallbackFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CallbackFailure"; }
}

type Settled = { content: string; outcome: ToolOutcome };
const bytes = (text: string) => new TextEncoder().encode(text).length;
const failure = (status: "failed" | "interrupted", code: string, message: string, extra: Record<string, unknown> = {}): Settled =>
  ({ content: JSON.stringify({ ok: false, code, message, ...extra }), outcome: { status, code } });
const validReference = (value: unknown): value is ResultReference => {
  const reference = value as ResultReference;
  return !!reference && typeof reference === "object" && typeof reference.resultId === "string" && reference.resultId.trim().length > 0
    && Number.isSafeInteger(reference.bytes) && reference.bytes >= 0 && (reference.retention === "temporary" || reference.retention === "durable")
    && (reference.expiresAt === undefined || typeof reference.expiresAt === "string");
};

/** Run one authorized catalog call through the executor (decision 0021). The
 * caller has already recorded dispatch evidence. Resolves with the paired
 * result and its outcome whenever the turn can go on: success, a typed
 * failure, or the tool's deadline. Rejects when the turn cannot: it was
 * interrupted, or the connection carrying the callback is gone. */
export async function runFunction(options: {
  executor: FunctionExecutor; request: FunctionCall; registration: ToolRegistration;
  defaultDeadlineMs?: number; limits: ToolLimits; signal: AbortSignal;
}): Promise<Settled> {
  const { executor, request, registration, limits, signal } = options;
  const deadline = registration.deadlineMs ?? options.defaultDeadlineMs;
  // The executor's own signal: aborted by the turn's interruption or by the
  // deadline. Either way the host is asked to stop and a late answer is ignored.
  const wait = new AbortController();
  // The wait itself ends on interruption, whether or not the executor reacts.
  let stop!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { stop = reject; });
  stopped.catch(() => undefined);
  const interrupted = () => { wait.abort(signal.reason); stop(signal.reason); };
  signal.addEventListener("abort", interrupted, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined, expired = false;
  const timedOut = deadline === undefined ? undefined : new Promise<"deadline">(resolve => {
    // An executor that honours the abort rejects its wait at once; `expired`
    // tells that rejection apart from a failure of the call.
    timer = setTimeout(() => { expired = true; wait.abort(new Error("tool deadline")); resolve("deadline"); }, deadline);
  });
  const timeout = () => failure("interrupted", "tool_timeout", `The tool did not answer within ${deadline} ms and was asked to stop. Whether it took effect is unknown; it was not retried.`, { effect: "unknown" });
  try {
    signal.throwIfAborted();
    const answering = executor.call(request, wait.signal);
    // Observed here so a rejection after the deadline is never unhandled.
    answering.catch(() => undefined);
    const answer = await Promise.race(timedOut ? [answering, timedOut, stopped] : [answering, stopped]);
    signal.throwIfAborted();
    if (answer === "deadline") return timeout();
    if (answer && typeof answer === "object" && "reference" in answer && answer.reference !== undefined) {
      if (!validReference(answer.reference) || typeof answer.preview !== "string")
        return failure("failed", "invalid_result", "The tool returned a malformed result reference.");
      const preview = bytes(answer.preview) > limits.previewBytes ? new TextDecoder().decode(new TextEncoder().encode(answer.preview).subarray(0, limits.previewBytes)) : answer.preview;
      return { content: JSON.stringify({ ok: true, preview, result_id: answer.reference.resultId, bytes: answer.reference.bytes,
        ...(answer.reference.expiresAt ? { expires_at: answer.reference.expiresAt } : {}),
        note: "The full result is stored. Read it in parts with read_tool_result and this result_id." }),
        outcome: { status: "succeeded", reference: structuredClone(answer.reference) } };
    }
    const content = JSON.stringify({ ok: true, output: (answer as { output?: unknown })?.output ?? null });
    // A producer stores what does not fit and sends a reference. Bytes that
    // arrive inline anyway cannot be kept or shown in full.
    if (bytes(content) > limits.inlineBytes) return failure("failed", "result_too_large", `The tool's result exceeds ${limits.inlineBytes} bytes and was not stored by its producer.`);
    return { content, outcome: { status: "succeeded" } };
  } catch (error) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Turn interrupted");
    if (expired) return timeout();
    if (error instanceof CallbackFailure) return failure("failed", error.code, error.message);
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", interrupted);
  }
}

/** Where a result ID was produced, from the references recorded with tool
 * results. Only IDs the harness itself recorded resolve: a path or a made-up
 * ID finds nothing. */
export function locateResult(view: StorageSnapshot, resultId: string): { channel: string; turnId: number; callId: string; reference: ResultReference } | undefined {
  for (const entry of view.timeline) {
    if (entry.message.role !== "tool" || entry.message.outcome?.reference?.resultId !== resultId) continue;
    return { channel: entry.channelId, turnId: entry.turnId, callId: entry.message.callId, reference: entry.message.outcome.reference };
  }
  return undefined;
}

/** The scoped reader (decision 0021). The requesting channel comes from the
 * harness, never from the arguments: only the channel that produced a result
 * can read it, whatever it has seen in shared history. */
export async function readResult(options: {
  executor: FunctionExecutor | undefined; view: StorageSnapshot; channel: string; arguments: string; limits: ToolLimits; signal: AbortSignal; now?: () => number;
}): Promise<Settled> {
  let args: { result_id?: unknown; offset?: unknown; length?: unknown };
  try { args = JSON.parse(options.arguments); } catch { return failure("failed", "invalid_arguments", "read_tool_result needs a JSON object."); }
  if (typeof args?.result_id !== "string" || !args.result_id) return failure("failed", "invalid_arguments", "read_tool_result needs result_id.");
  const offset = args.offset === undefined ? 0 : args.offset, length = args.length === undefined ? options.limits.readBytes : args.length;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(length) || (length as number) < 1)
    return failure("failed", "invalid_arguments", "offset must be a nonnegative integer and length a positive integer.");
  const found = locateResult(options.view, args.result_id);
  if (!found) return failure("failed", "result_not_found", "No stored result has this result_id. Use an ID returned by a tool in this conversation.");
  if (found.channel !== options.channel) return failure("failed", "result_forbidden", "That result belongs to another conversation and cannot be read here.");
  if (found.reference.expiresAt !== undefined && Date.parse(found.reference.expiresAt) <= (options.now ?? Date.now)())
    return failure("failed", "result_expired", "That result was temporary and has expired. The original tool call keeps its recorded outcome.");
  if (!options.executor) return failure("failed", "result_unavailable", "The process that holds that result is not connected.");
  try {
    const page = await options.executor.read({ resultId: args.result_id, invocationId: `${found.turnId}:${found.callId}`, channel: options.channel,
      offset: offset as number, length: Math.min(length as number, options.limits.readBytes) }, options.signal);
    options.signal.throwIfAborted();
    const text = String(page.text ?? "");
    return { content: JSON.stringify({ ok: true, text, total_bytes: page.totalBytes, eof: page.eof === true,
      ...(page.eof === true ? {} : { next_offset: (offset as number) + bytes(text) }) }), outcome: { status: "succeeded" } };
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Turn interrupted");
    if (error instanceof CallbackFailure) return failure("failed", error.code, error.message);
    throw error;
  }
}
