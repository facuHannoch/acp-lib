import { expect, test } from "bun:test";
import { createProtocolServer } from "../src/interfaces/protocol/server.ts";
import { HarnessClient, createInProcessTransport } from "../src/client.ts";
import type { PersistentSession } from "../src/contracts/session.ts";
import type { ChannelEvent, EventSink } from "../src/contracts/events.ts";

test("final subscription filters ephemeral text and keeps committed and lifecycle events", async () => {
  let publish!: EventSink;
  const session = { subscribe(listener: EventSink) { publish = listener; return () => {}; }, subscribeSession() { return () => {}; },
    approvals: { setConsumer() {}, disconnect() {} }, start() {} } as unknown as PersistentSession;
  const server = createProtocolServer(async () => ({ session, close() {} }));
  const client = new HarnessClient(createInProcessTransport(server)); const received: ChannelEvent[] = [];
  try {
    await client.initialize(); await client.createSession({ sessionId: "s", participants: [], channels: {} });
    client.onChannelEvent(event => received.push(event));
    const events: ChannelEvent[] = [
      { channel: "a", event: { type: "text_delta", turnId: "1", messageId: "m", text: "partial" } },
      { channel: "a", event: { type: "text_gap", turnId: "1", messageId: "m" } },
      { channel: "a", event: { type: "text_incomplete", turnId: "1", messageId: "m", reason: "failed" } },
      { channel: "a", revision: 1, event: { type: "items_receipt", turnId: "1", items: ["x"], milestone: "seen" } },
      { channel: "a", revision: 2, event: { type: "message_completed", turnId: "1", messageId: "m", parts: [{ type: "text", text: "done" }] } },
      { channel: "a", event: { type: "tool_call", turnId: "1", id: "tool", name: "echo", status: "started" } },
      { channel: "a", revision: 3, event: { type: "turn_ended", turnId: "1", outcome: "completed" } },
    ];
    events.forEach(publish);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(received.map(event => event.event.type)).toEqual(["items_receipt", "message_completed", "tool_call", "turn_ended"]);
    expect(received[1]?.event).toMatchObject({ messageId: "m", parts: [{ text: "done" }] });
  } finally { client.close(); server.dispose(); }
});
