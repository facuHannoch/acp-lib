import { DuplicateJsonField, parseUniqueJson } from "../../util/json.ts";
import type { ProtocolEndpoint, RpcRequest } from "../../contracts/protocol.ts";
import { LineDecoder, LineWriter } from "./framing.ts";
import { LiveQueue } from "./live-queue.ts";

/** Serve until EOF. EOF is stop (decision 0013): admission closes, inference
 * and tools are cancelled, active turns are recorded interrupted and pending
 * input stays pending. Nothing is drained; the grace period only bounds the
 * settling of requests already read and the flush of protocol output. */
export async function serveProtocolStdio(endpoint: ProtocolEndpoint, input: ReadableStream<Uint8Array>, write: (bytes: Uint8Array) => Promise<void>, graceMs = 5000) {
  if (!Number.isFinite(graceMs) || graceMs <= 0) throw new Error("Shutdown grace must be positive");
  const reader = input.getReader();
  const writer = new LineWriter(write);
  const decoder = new LineDecoder();
  const pending = new Set<Promise<void>>();
  let failure: unknown;
  const fail = (error: unknown) => { failure = error; void reader.cancel().catch(() => {}); };
  const queue = new LiveQueue(value => writer.send(value), fail);
  function send(value: unknown) { try { queue.send(value); } catch (error) { fail(error); } }
  // One writer for responses and both notification kinds keeps wire order
  // equal to publication order.
  const unsubscribeChannel = endpoint.subscribe(send), unsubscribeSession = endpoint.subscribeSession?.(send), unsubscribeCallbacks = endpoint.subscribeCallbacks?.(send);
  const unsubscribe = () => { unsubscribeChannel(); unsubscribeSession?.(); unsubscribeCallbacks?.(); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      const chunk = await reader.read();
      if (failure) throw failure;
      if (chunk.done) { decoder.finish(); break; }
      for (const line of decoder.push(chunk.value)) {
        if (failure) throw failure;
        let request;
        try { request = parseUniqueJson(line) as RpcRequest; }
        catch (error) {
          if (error instanceof DuplicateJsonField && error.field.startsWith("params.config.")) {
            const envelope = JSON.parse(line) as { id?: unknown };
            const id = Number.isSafeInteger(envelope.id) ? envelope.id as number : null;
            send({ jsonrpc: "2.0", id, error: { code: -32602, message: error.message, data: { code: "invalid_config" } } });
            continue;
          }
          send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON", data: { code: "parse_error" } } });
          continue;
        }
        // Decision 0021: a line without a method that carries a result or an
        // error answers one of our callback requests. It is matched by ID to an
        // open wait; anything else is dropped there.
        const answer = request as unknown as { method?: unknown; id?: unknown; result?: unknown; error?: unknown };
        if (answer && typeof answer === "object" && answer.method === undefined && Number.isSafeInteger(answer.id) && ("result" in answer || "error" in answer)) {
          endpoint.respond?.(answer as never);
          continue;
        }
        // Dispatch concurrently: one slow request must not block other channels.
        const task = endpoint.request(request).then(send, fail);
        pending.add(task);
        void task.finally(() => pending.delete(task));
      }
    }
    const settle = async () => {
      // Requests read before EOF are still dispatched (above), so a stop issued
      // here follows them. Its interruption events go out with the final flush.
      // A server with no session, or without stop, has nothing to interrupt.
      endpoint.disconnect?.();
      await endpoint.request({ jsonrpc: "2.0", id: -1, method: "session/stop", params: {} });
      await Promise.all(pending);
      if (failure) throw failure;
      await queue.flush();
      await writer.flush();
    };
    await Promise.race([settle(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Stdio shutdown grace expired before requests settled")), graceMs);
    })]);
  } finally {
    // A failed writer or live queue closes this connection just like EOF: stop
    // the session so in-flight work is fenced before releasing the endpoint.
    if (failure) {
      endpoint.disconnect?.();
      await endpoint.request({ jsonrpc: "2.0", id: -1, method: "session/stop", params: {} }).catch(() => {});
    }
    clearTimeout(timer); endpoint.disconnect?.(); unsubscribe();
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
