import { expect, test } from "bun:test";
import { spawnHarness } from "./helpers/stdio.ts";
import { createInProcessHarness } from "../src/testing.ts";
import { createSession } from "../src/index.ts";
import { HarnessClient, createInProcessTransport } from "../src/client.ts";
import { createProtocolServer } from "../src/interfaces/protocol/server.ts";
import { publishChannelEvent, createChannelOutputs } from "../src/interfaces/protocol/output.ts";
import type { ChannelEvent } from "../src/contracts/events.ts";
import type { CreateParams, ClientTransport } from "../src/contracts/protocol.ts";
import { lastInput } from "./helpers/session.ts";

const setup: CreateParams = { sessionId: "test", participants: [], channels: {}, config: {
  version: 1, system: "Test system", model: { protocol: "scripted", script: new URL("./fixtures/echo-scenario.json", import.meta.url).pathname }, defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow", tools: {} } },
} };
const push = (channel: string, id: string, text = "hello") => ({ channel, item: {
  id, kind: "user_message" as const, sender: channel, content: [{ type: "text" as const, text }],
} });
function collect(client: HarnessClient, count = 1) {
  const events: ChannelEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>(r => { resolve = r; });
  client.onChannelEvent(event => {
    events.push(event);
    if (events.filter(e => e.event.type === "turn_ended").length === count) resolve();
  });
  return { events, done };
}

for (const transport of ["in-process", "stdio"] as const) test(`${transport}: public client drives two independent scripted channels and idempotent pushes`, async () => {
  const harness = transport === "in-process" ? createInProcessHarness() : spawnHarness(); const { client } = harness;
  try {
    const init = await client.initialize();
    expect(init.description.capabilities).toMatchObject({ experimental: true, persistence: transport === "stdio", acceptance: transport === "stdio" ? "durable" : "memory" });
    await client.createSession(setup);
    const log = collect(client, 2);
    const acks = await Promise.all([client.push(push("a", "a1")), client.push(push("b", "b1"))]);
    expect(acks[0]).toEqual({ accepted: true, duplicate: false, item: { id: "a1", channel: "a", kind: "participant_message", sender: "a", milestone: "received", policy: { resolved: "__legacy_allow", inherited: [] } } });
    await log.done;
    expect(await client.idle()).toEqual({ idle: true });
    expect(await client.status()).toMatchObject({ sessionId: "test", lifecycle: "running", execution: "idle",
      channels: [{ channel: "a", pending: [] }, { channel: "b", pending: [] }] });
    for (const channel of ["a", "b"]) {
      const events = log.events.filter(e => e.channel === channel).map(e => e.event);
      expect(events[0]).toMatchObject({ type: "turn_started", items: [`${channel}1`] });
      expect(events.at(-1)).toMatchObject({ type: "turn_ended", outcome: "completed" });
      expect(events.filter(e => e.type === "message_completed")).toHaveLength(2);
      expect(events.filter(e => e.type === "tool_call").map(e => e.status)).toEqual(["started", "completed"]);
      if ("models" in harness) {
        expect(harness.models.get(channel)?.requests()).toHaveLength(2);
        expect(harness.models.get(channel)?.requests()[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: '{"ok":true,"text":"hello"}' });
      }
    }
    const before = log.events.length;
    // A retry is answered from storage with the original item's current state.
    expect(await client.push(push("a", "a1"))).toEqual({ accepted: true, duplicate: true,
      item: { id: "a1", channel: "a", kind: "participant_message", sender: "a", milestone: "seen", turnId: expect.any(String), policy: { resolved: "__legacy_allow", inherited: [] } } });
    expect(log.events).toHaveLength(before);
    await expect(client.push(push("b", "a1"))).rejects.toMatchObject({ code: "item_conflict" });
    const failure = collect(client);
    await client.push(push("a", "a2")); await failure.done;
    expect(failure.events.at(-1)?.event).toMatchObject({ type: "turn_ended", outcome: "failed" });
    expect(failure.events.filter(e => e.event.type === "turn_ended")).toHaveLength(1);
  } finally { await harness.close(); }
}, 5000);

test("notice continuation preserves both completed replies and emits turn_took", async () => {
  let calls = 0;
  const session = createSession({ systemPrompt: "test", configureTurn: () => ({
    tools: [], executeTool: async () => "unused", model: async () => {
      calls++;
      if (calls === 1) session.agent.notify({ channelId: "a", fromChannelId: "b", text: "Greeting" });
      return { role: "assistant", content: calls === 1 ? "Activity report" : "Greeting received", calls: [] };
    },
  }) });
  const outputs = createChannelOutputs(); const delivered: string[] = [];
  outputs.subscribe("a", event => delivered.push(event.text));
  session.subscribe(event => publishChannelEvent(outputs, event));
  const server = createProtocolServer(async () => ({ session, close() {} }));
  const client = new HarnessClient(createInProcessTransport(server));
  try {
    await client.initialize(); await client.createSession(setup);
    const log = collect(client);
    await client.push(push("a", "item")); await log.done;
    expect(delivered).toEqual(["Activity report", "Greeting received"]);
    expect(log.events.map(e => e.event.type)).toEqual(["turn_started", "items_receipt", "message_completed", "turn_took", "items_receipt", "message_completed", "turn_ended"]);
    // Every one of these reports a commit, in commit order.
    const revisions = log.events.map(e => e.revision);
    expect(revisions.every(revision => Number.isSafeInteger(revision))).toBe(true);
    expect(revisions).toEqual([...revisions].sort((x, y) => x! - y!));
    expect(log.events[1]?.event).toMatchObject({ items: ["item"], milestone: "seen" });
    const ids = log.events.map(e => e.event).filter(e => e.type === "message_completed").map(e => e.messageId);
    expect(new Set(ids).size).toBe(2);
  } finally { client.close(); }
}, 5000);

test("acceptance does not await inference; idle includes pending work and values cross a copy boundary", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const session = createSession({ systemPrompt: "test", configureTurn: () => ({ tools: [], executeTool: async () => "unused",
    model: async messages => { await gate; return { role: "assistant", content: lastInput(messages), calls: [] }; },
  }) });
  const client = new HarnessClient(createInProcessTransport(createProtocolServer(async () => ({ session, close() {} }))));
  try {
    await client.initialize(); await client.createSession(setup);
    // The second message arrives while the first inference is in flight and joins that turn.
    const log = collect(client, 1);
    const input = push("a", "1");
    const accepted = client.push(input); input.item.content[0]!.text = "mutated";
    await accepted; await client.push(push("a", "2"));
    expect(await client.idle()).toEqual({ idle: false });
    release(); await log.done;
    expect(log.events.map(e => e.event).filter(e => e.type === "message_completed").map(e => e.parts![0]?.text)).toEqual(["hello", "hello"]);
    expect(log.events.map(e => e.event).flatMap(e => e.type === "turn_started" || e.type === "turn_took" ? [e.items] : [])).toEqual([["1"], ["2"]]);
    expect(await client.idle()).toEqual({ idle: true });
  } finally { release(); client.close(); }
}, 5000);

for (const transport of ["in-process", "stdio"] as const) test(`${transport}: protocol rejects lifecycle misuse, unsupported methods/options and mismatched versions`, async () => {
  const harness = transport === "in-process" ? createInProcessHarness() : spawnHarness();
  try {
    await expect(harness.client.idle()).rejects.toMatchObject({ code: "not_ready" });
    await expect(harness.client.initialize({ protocolVersion: 2, host: { name: "test", version: "0" }, callbacks: [], subscription: { text: "final", tools: "none" } })).rejects.toMatchObject({ code: "version_mismatch" });
    await harness.client.initialize();
    await expect(harness.client.push(push("a", "1"))).rejects.toMatchObject({ code: "not_ready" });
    const invalid = structuredClone(setup) as any; invalid.config.policies = {};
    await expect(harness.client.createSession(invalid)).rejects.toMatchObject({ code: "invalid_config" });
    await harness.client.createSession(setup);
    await expect(harness.client.createSession(setup)).rejects.toMatchObject({ code: "already_exists" });
    await expect(harness.client.request("session/load" as any, {})).rejects.toMatchObject({ code: transport === "stdio" ? "invalid_params" : "method_not_found" });
    if ("server" in harness) expect(await harness.server.request(null as any)).toMatchObject({ error: { code: -32600, data: { code: "invalid_request" } } });
    await expect(harness.client.push({ ...push("a", "1"), item: { ...push("a", "1").item, delivery: "steer" } } as any)).rejects.toMatchObject({ code: "invalid_params" });
  } finally { await harness.close(); }
});

for (const transport of ["in-process", "stdio"] as const) test(`${transport}: subscription tool summaries omit payloads and none omits tool events`, async () => {
  for (const tools of ["summary", "none"] as const) {
    const harness = transport === "in-process" ? createInProcessHarness() : spawnHarness();
    try {
      await harness.client.initialize({ protocolVersion: 1, host: { name: "test", version: "0" }, callbacks: [], subscription: { text: "final", tools } });
      await harness.client.createSession(setup);
      const log = collect(harness.client);
      await harness.client.push(push("a", "1")); await log.done;
      const calls = log.events.map(e => e.event).filter(e => e.type === "tool_call");
      expect(calls).toHaveLength(tools === "none" ? 0 : 2);
      for (const call of calls) { expect(call.input).toBeUndefined(); expect(call.output).toBeUndefined(); }
      expect(log.events.filter(e => e.event.type === "message_completed")).toHaveLength(2);
    } finally { await harness.close(); }
  }
});

test("client bounds request waits and rejects pending work on close", async () => {
  const transport: ClientTransport = { send() {}, subscribe: () => () => {}, onClose: () => () => {}, close() {} };
  const client = new HarnessClient(transport, 5);
  await expect(client.idle()).rejects.toMatchObject({ code: "timeout" });
  const pending = client.idle(); client.close();
  await expect(pending).rejects.toMatchObject({ code: "closed" });
  await expect(client.idle()).rejects.toMatchObject({ code: "closed" });
});
