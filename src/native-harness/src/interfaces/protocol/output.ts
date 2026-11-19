import type { ChannelOutput, ChannelOutputs } from "../../contracts/output.ts";
import type { ChannelEvent } from "../../contracts/events.ts";

/** Development clients consume completed messages, never a second final return. */
export function publishChannelEvent(outputs: ChannelOutputs, { channel, event }: ChannelEvent) {
  if (event.type === "message_completed") outputs.publish({ channelId: channel, turnId: Number(event.turnId),
    type: "reply", text: event.parts.map(part => part.text).join("") });
  if (event.type === "turn_ended" && event.outcome !== "completed") outputs.publish({ channelId: channel,
    turnId: Number(event.turnId), type: "error", text: event.error ?? `Turn ${event.outcome}` });
}

export function createChannelOutputs(): ChannelOutputs {
  const listeners = new Map<string, Set<(output: ChannelOutput) => void>>();
  return {
    publish(output) {
      for (const listener of listeners.get(output.channelId) ?? []) {
        // A disconnected client cannot turn a successfully completed turn into
        // an execution failure or prevent delivery to another connected client.
        try { listener(structuredClone(output)); } catch { /* Subscriber owns cleanup. */ }
      }
    },
    subscribe(channelId, listener) {
      let group = listeners.get(channelId);
      if (!group) { group = new Set(); listeners.set(channelId, group); }
      group.add(listener);
      return () => {
        group.delete(listener);
        if (!group.size) listeners.delete(channelId);
      };
    },
  };
}

export function outputStream(outputs: ChannelOutputs, channelId: string): Response {
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => { unsubscribe(); clearInterval(heartbeat); };
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: string) => {
        if ((controller.desiredSize ?? 0) <= 0) {
          cleanup(); controller.close(); return;
        }
        controller.enqueue(encoder.encode(frame));
      };
      unsubscribe = outputs.subscribe(channelId, output => send(`data: ${JSON.stringify(output)}\n\n`));
      // Handshake proves the subscription exists before the client sends work.
      controller.enqueue(encoder.encode('event: ready\ndata: {}\n\n'));
      // Keep idle Unix HTTP connections alive through runtime/client timeouts.
      // SSE comments are ignored by the client and do not produce chat output.
      heartbeat = setInterval(() => send(": keepalive\n\n"), 5000);
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 64 });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
  } });
}
