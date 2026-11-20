import { expect, test } from "bun:test";
import { LiveQueue } from "../src/interfaces/protocol/live-queue.ts";
const message = (event: object) => ({ jsonrpc: "2.0", method: "channel/event", params: { channel: "a", event } });
test("a slow consumer drops deltas with one gap and keeps completion in order", async () => {
  const sent: any[] = []; let release!: () => void, first = true;
  const queue = new LiveQueue(async value => { sent.push(value); if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); } }, () => {}, 800);
  queue.send(message({ type: "text_delta", turnId: "1", messageId: "m", text: "a".repeat(200) }));
  queue.send(message({ type: "text_delta", turnId: "1", messageId: "m", text: "b".repeat(200) }));
  queue.send(message({ type: "text_delta", turnId: "1", messageId: "m", text: "c".repeat(300) }));
  queue.send(message({ type: "text_delta", turnId: "1", messageId: "m", text: "d" }));
  release(); await queue.flush();
  queue.send(message({ type: "message_completed", turnId: "1", messageId: "m", reference: true })); await queue.flush();
  expect(sent.map(item => item.params.event.type)).toEqual(["text_delta", "text_delta", "text_gap", "message_completed"]);
  expect(sent.filter(item => item.params.event.type === "text_gap")).toHaveLength(1);
});
test("a fully blocked queue refuses nondroppable events", () => {
  const queue = new LiveQueue(() => new Promise<void>(() => {}), () => {}, 350);
  queue.send(message({ type: "text_delta", turnId: "1", messageId: "m", text: "a".repeat(200) }));
  expect(() => queue.send(message({ type: "turn_ended", turnId: "2", outcome: "completed", error: "b".repeat(200) }))).toThrow("queue");
});

test("a nondroppable overflow fails stdio and stops the session", async () => {
  const { serveProtocolStdio } = await import("../src/interfaces/protocol/stdio-server.ts");
  let publish!: (value: any) => void, stopped = false;
  const endpoint = { subscribe(listener: (value: any) => void) { publish = listener; return () => {}; },
    request: async (request: { method: string }) => { if (request.method === "session/stop") stopped = true; return { jsonrpc: "2.0" as const, id: 1, result: {} }; },
    disconnect() {} };
  const input = new ReadableStream<Uint8Array>({ start() {} });
  const running = serveProtocolStdio(endpoint, input, () => new Promise<void>(() => {}));
  const large = message({ type: "turn_ended", turnId: "1", outcome: "failed", error: "x".repeat(700_000) });
  publish(large); publish(large);
  await expect(running).rejects.toThrow("queue"); expect(stopped).toBe(true);
});
