import type { ProtocolEndpoint } from "../../contracts/protocol.ts";
import { LineDecoder, LineWriter } from "./framing.ts";

/** Serve until EOF, then settle accepted work within a bounded grace period. */
export async function serveProtocolStdio(endpoint: ProtocolEndpoint, input: ReadableStream<Uint8Array>, write: (bytes: Uint8Array) => Promise<void>, graceMs = 5000) {
  if (!Number.isFinite(graceMs) || graceMs <= 0) throw new Error("Shutdown grace must be positive");
  const reader = input.getReader();
  const writer = new LineWriter(write);
  const decoder = new LineDecoder();
  const pending = new Set<Promise<void>>();
  let failure: unknown;
  let stopped = false;
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
    const drain = async () => {
      await Promise.all(pending);
      while (true) {
        if (stopped) return;
        if (failure) throw failure;
        const response = await endpoint.request({ jsonrpc: "2.0", id: -1, method: "session/idle", params: {} });
        if ("error" in response) {
          if (response.error.data.code !== "not_ready") throw new Error(response.error.message);
          break;
        }
        if ((response.result as { idle: boolean }).idle) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await writer.flush();
    };
    await Promise.race([drain(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Stdio shutdown grace expired; work is not persisted")), graceMs);
    })]);
  } finally {
    stopped = true;
    clearTimeout(timer); unsubscribe();
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
