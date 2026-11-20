import { expect, test } from "bun:test";
import { createProtocolServer } from "../src/interfaces/protocol/server.ts";
import { HarnessClient, createInProcessTransport } from "../src/client.ts";
import type { PersistentSession } from "../src/contracts/session.ts";
import type { ProtocolEndpoint, RpcNotification } from "../src/contracts/protocol.ts";

test("summary paging returns earlier whole calls before an oversized call", async () => {
  const call = (id: string, providerRequestId?: string) => ({ callId: id, turnId: "1", channel: "a", messageId: `model:${id}`,
    startedAt: "start", endedAt: "end", outcome: "succeeded", attempts: [{ attemptId: `${id}:0`, ordinal: 0, startedAt: "start", endedAt: "end", outcome: "succeeded", ...(providerRequestId ? { providerRequestId } : {}) }] });
  const modelCalls = [call("1"), call("2", "x".repeat(1_048_576)), call("3")];
  const session = { subscribe() { return () => {}; }, subscribeSession() { return () => {}; }, approvals: { setConsumer() {}, disconnect() {} }, start() {}, snapshot: () => ({ modelCalls }) } as unknown as PersistentSession;
  const server = createProtocolServer(async () => ({ session, close() {} })), client = new HarnessClient(createInProcessTransport(server));
  try {
    await client.initialize(); await client.createSession({ sessionId: "s", participants: [], channels: {} });
    const page = await client.modelCalls(); expect(page.calls.map(item => item.callId)).toEqual(["1"]); expect(page.next).toBe("1");
    expect((await client.modelCalls({ limit: 1 })).calls.map(item => item.callId)).toEqual(["1"]);
    await expect(client.modelCalls({ after: "1" })).rejects.toMatchObject({ code: "transfer_limit" });
    expect((await client.modelCalls({ after: "2" })).calls.map(item => item.callId)).toEqual(["3"]);
  } finally { client.close(); server.dispose(); }
});

function endpointDouble() {
  let notify!: (event: RpcNotification) => void, disconnected = 0, stopped = 0;
  const endpoint = { subscribe(listener: typeof notify) { notify = listener; return () => {}; }, disconnect() { disconnected++; },
    async request(request: { method: string }) { if (request.method === "session/stop") stopped++; return { jsonrpc: "2.0", id: 1, result: {} }; } } as unknown as ProtocolEndpoint;
  const send = (event: object) => notify({ jsonrpc: "2.0", method: "channel/event", params: { channel: "a", event } } as RpcNotification);
  return { endpoint, send, counts: () => ({ disconnected, stopped }) };
}

test("in-process transport bounds synchronous delta bursts and preserves a gap before completion", async () => {
  const source = endpointDouble(), transport = createInProcessTransport(source.endpoint), seen: RpcNotification[] = [];
  transport.subscribe(message => { if ("method" in message) seen.push(message); });
  source.send({ type: "text_delta", turnId: "1", messageId: "m", text: "a".repeat(600_000) });
  source.send({ type: "text_delta", turnId: "1", messageId: "m", text: "b".repeat(600_000) });
  source.send({ type: "text_delta", turnId: "1", messageId: "m", text: "ignored" });
  source.send({ type: "message_completed", turnId: "1", messageId: "m", reference: true });
  for (let i = 0; i < 100 && seen.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(seen.map(value => value.params.event.type)).toEqual(["text_delta", "text_gap", "message_completed"]);
  expect(source.counts()).toEqual({ disconnected: 0, stopped: 0 }); transport.close();
});

test("in-process nondroppable overflow closes the connection and stops the session", async () => {
  const source = endpointDouble(), transport = createInProcessTransport(source.endpoint); let closed: Error | undefined;
  transport.onClose(error => { closed = error; });
  const event = { type: "turn_ended", turnId: "1", outcome: "failed", error: "x".repeat(700_000) };
  source.send(event); source.send(event);
  expect(closed?.message).toContain("queue"); expect(source.counts()).toEqual({ disconnected: 1, stopped: 1 });
  expect(() => transport.send({ jsonrpc: "2.0", id: 1, method: "session/status", params: {} })).toThrow("closed");
});
