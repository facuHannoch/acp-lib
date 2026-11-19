import type { ProtocolEndpoint } from "../../contracts/protocol.ts";
import { LineDecoder, LineWriter } from "./framing.ts";

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
  function send(value: unknown) {
    try { void writer.send(value).catch(fail); } catch (error) { fail(error); }
  }
  // One writer for responses and both notification kinds keeps wire order
  // equal to publication order.
  const unsubscribeChannel = endpoint.subscribe(send), unsubscribeSession = endpoint.subscribeSession?.(send);
  const unsubscribe = () => { unsubscribeChannel(); unsubscribeSession?.(); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      const chunk = await reader.read();
      if (failure) throw failure;
      if (chunk.done) { decoder.finish(); break; }
      for (const line of decoder.push(chunk.value)) {
        if (failure) throw failure;
        let request;
        try { request = JSON.parse(line); }
        catch {
          send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON", data: { code: "parse_error" } } });
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
      await endpoint.request({ jsonrpc: "2.0", id: -1, method: "session/stop", params: {} });
      await Promise.all(pending);
      if (failure) throw failure;
      await writer.flush();
    };
    await Promise.race([settle(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Stdio shutdown grace expired before requests settled")), graceMs);
    })]);
  } finally {
    clearTimeout(timer); unsubscribe();
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
