import type { ChannelOutput } from "../../contracts/output.ts";

/** Resolve only after SSE handshake; done rejects if delivery is interrupted. */
export async function subscribeLocal(socketPath: string, channelId: string, onOutput: (output: ChannelOutput) => void) {
  const abort = new AbortController();
  const response = await fetch(`http://localhost/events?channelId=${encodeURIComponent(channelId)}`, {
    unix: socketPath, signal: abort.signal,
  });
  if (!response.ok || !response.body) throw new Error(`Channel subscription HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ready!: () => void;
  let fail!: (error: unknown) => void;
  let connected = false;
  const handshake = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  const done = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error("Channel subscription closed");
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith("event: ready\n")) { connected = true; ready(); continue; }
          const data = frame.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
          if (data) onOutput(JSON.parse(data) as ChannelOutput);
        }
      }
    } catch (error) {
      if (!connected) fail(error);
      if (!abort.signal.aborted) throw error;
    } finally { reader.releaseLock(); }
  })();
  // Install a handler immediately; callers attach theirs after the handshake.
  void done.catch(() => {});
  try { await handshake; } catch (error) { abort.abort(); throw error; }
  return { done, close() { abort.abort(); } };
}
