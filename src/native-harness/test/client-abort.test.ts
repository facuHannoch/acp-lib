import { afterEach, expect, spyOn, test } from "bun:test";
import { HarnessClient } from "../src/client.ts";
import type { ClientTransport, RpcRequest } from "../src/contracts/protocol.ts";

const clients: HarnessClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });

function setup(timeoutMs = 5_000) {
  const sent: RpcRequest[] = [];
  let deliver: Parameters<ClientTransport["subscribe"]>[0] | undefined;
  let disconnect: Parameters<ClientTransport["onClose"]>[0] | undefined;
  const wire = {
    sendError: undefined as Error | undefined,
    send(request: RpcRequest) {
      sent.push(request);
      if (wire.sendError) throw wire.sendError;
    },
    subscribe(listener: Parameters<ClientTransport["subscribe"]>[0]) {
      deliver = listener;
      return () => { deliver = undefined; };
    },
    onClose(listener: Parameters<ClientTransport["onClose"]>[0]) {
      disconnect = listener;
      return () => { disconnect = undefined; };
    },
    close() {},
  } satisfies ClientTransport & { sendError?: Error };
  const client = new HarnessClient(wire, timeoutMs);
  clients.push(client);

  const control = new AbortController();
  const add = spyOn(control.signal, "addEventListener");
  const remove = spyOn(control.signal, "removeEventListener");
  return {
    client, control, sent, wire,
    respond(request: RpcRequest, value = { calls: [] }) {
      deliver?.({ jsonrpc: "2.0", id: request.id, result: value });
    },
    disconnect(error: Error) { disconnect?.(error); },
    expectClean(requestCount: number) {
      expect(add.mock.calls).toHaveLength(requestCount);
      expect(remove.mock.calls).toHaveLength(requestCount);
      const removed = new Set(remove.mock.calls.map(([kind, listener]) => {
        expect(kind).toBe("abort");
        return listener;
      }));
      expect(removed).toEqual(new Set(add.mock.calls.map(([, listener]) => listener)));
      expect(removed.size).toBe(requestCount);
      expect((Reflect.get(client, "waiting") as Map<number, unknown>).size).toBe(0);
    },
  };
}

test("client pre-abort sends nothing and registers no waiter", async () => {
  const rig = setup();
  rig.control.abort();
  await expect(rig.client.modelCalls({}, rig.control.signal)).rejects.toMatchObject({ code: "cancelled" });
  expect(rig.sent).toEqual([]);
  rig.expectClean(0);
});

test("client abort ignores a late response and sends no cancel frame", async () => {
  const rig = setup();
  const waiting = rig.client.request("session/model-calls", {}, rig.control.signal).catch(error => error);
  const request = rig.sent[0]!;
  rig.control.abort();
  expect(await waiting).toMatchObject({ code: "cancelled" });
  rig.respond(request);
  expect(rig.sent.map(frame => frame.method)).toEqual(["session/model-calls"]);
  rig.expectClean(1);
  const next = rig.client.modelCalls();
  rig.respond(rig.sent[1]!);
  expect(await next).toEqual({ calls: [] });
});

test("client response before abort settles and removes the listener once", async () => {
  const rig = setup();
  const waiting = rig.client.modelCalls({}, rig.control.signal);
  rig.respond(rig.sent[0]!);
  rig.control.abort();
  expect(await waiting).toEqual({ calls: [] });
  expect(rig.sent).toHaveLength(1);
  rig.expectClean(1);
});

test("client timeout before abort keeps the timeout and removes the listener once", async () => {
  const rig = setup(10);
  const waiting = rig.client.modelCalls({}, rig.control.signal).catch(error => error);
  expect(await waiting).toMatchObject({ code: "timeout" });
  rig.control.abort();
  rig.respond(rig.sent[0]!);
  expect(rig.sent).toHaveLength(1);
  rig.expectClean(1);
});

test("client transport close rejects every waiter and removes their listeners", async () => {
  const rig = setup();
  const waiting = [rig.client.modelCalls({}, rig.control.signal), rig.client.modelCalls({}, rig.control.signal)];
  const settled = Promise.allSettled(waiting);
  rig.disconnect(new Error("fixture transport closed"));
  rig.control.abort();
  const reason = expect.objectContaining({ code: "transport_closed", message: "fixture transport closed" });
  expect(await settled).toEqual([
    { status: "rejected", reason }, { status: "rejected", reason },
  ]);
  await expect(rig.client.modelCalls({}, rig.control.signal)).rejects.toMatchObject({ code: "transport_closed" });
  expect(rig.sent).toHaveLength(2);
  rig.expectClean(2);
});

test("client send failure removes the waiter and ignores the late response and abort", async () => {
  const rig = setup();
  const failure = new Error("fixture send failed");
  rig.wire.sendError = failure;
  await expect(rig.client.modelCalls({}, rig.control.signal)).rejects.toBe(failure);
  rig.respond(rig.sent[0]!);
  rig.control.abort();
  expect(rig.sent).toHaveLength(1);
  rig.expectClean(1);
});

test("client releases all listeners shared by concurrent requests", async () => {
  const rig = setup();
  const count = 64;
  const settled = Promise.allSettled(Array.from({ length: count }, () => rig.client.modelCalls({}, rig.control.signal)));
  for (const request of rig.sent.slice(0, count / 2)) rig.respond(request);
  rig.control.abort();
  for (const request of rig.sent.slice(count / 2)) rig.respond(request);
  const results = await settled;
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(count / 2);
  expect(results.filter(result => result.status === "rejected")).toEqual(
    Array.from({ length: count / 2 }, () => ({ status: "rejected", reason: expect.objectContaining({ code: "cancelled" }) })),
  );
  expect(rig.sent.map(request => request.method)).toEqual(Array(count).fill("session/model-calls"));
  rig.expectClean(count);
});
