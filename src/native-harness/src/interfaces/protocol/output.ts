import type { ChannelOutput, ChannelOutputs } from "../../contracts/output.ts";
import type { TurnRunner } from "../../contracts/agent.ts";

export function deliverTurnOutput(run: TurnRunner, outputs: ChannelOutputs): TurnRunner {
  return async (input, mailbox) => {
    try {
      const text = await run(input, mailbox);
      outputs.publish({ channelId: input.channelId, turnId: input.turnId, type: "reply", text });
      return text;
    } catch (error) {
      outputs.publish({ channelId: input.channelId, turnId: input.turnId, type: "error", text: String(error) });
      throw error;
    }
  };
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
