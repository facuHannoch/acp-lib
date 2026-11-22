import { expect, test } from "bun:test";
import { createSession } from "../src/index.ts";
import { createProtocolServer } from "../src/interfaces/protocol/server.ts";
import { HarnessClient, createInProcessTransport } from "../src/client.ts";
import { bindModelAttempt } from "../src/capabilities/model/attempt.ts";
import type { Model } from "../src/contracts/loop.ts";
import type { ChannelEvent } from "../src/contracts/events.ts";

for (const text of ["final", "stream"] as const) test(`${text} subscription keeps model message IDs and completion before tool dispatch`, async () => {
  const model: Model = async () => { throw new Error("attempt adapter expected"); }; let attempts = 0;
  bindModelAttempt(model, { scripted: false, create: () => async function* () {
    const first = ++attempts === 1; yield { type: "text_delta", text: first ? "working" : "done" };
    yield { type: "response", response: { role: "assistant", content: first ? "working" : "done", stopReason: first ? "tool_calls" : "complete",
      calls: first ? [{ id: "tool", name: "echo", arguments: "{}" }] : [] } };
  } });
  const session = createSession({ systemPrompt: "test", configureTurn: () => ({ model, tools: [], executeTool: async () => "ok" }) });
  const server = createProtocolServer(async () => ({ session, close() {} }), { durable: true }), client = new HarnessClient(createInProcessTransport(server)); const events: ChannelEvent[] = [];
  try {
    client.onChannelEvent(event => events.push(event));
    await client.initialize({ protocolVersion: 1, host: { name: "test", version: "0" }, callbacks: [], subscription: { text, tools: "full" } });
    await client.createSession({ sessionId: "s", participants: [], channels: {} });
    await client.push({ channel: "a", item: { id: "i", kind: "user_message", sender: "u", content: [{ type: "text", text: "hi" }] } });
    for (let i = 0; i < 500 && !events.some(event => event.event.type === "turn_ended"); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const all = events.map(value => value.event), completed = all.filter(event => event.type === "message_completed"), deltas = all.filter(event => event.type === "text_delta");
    expect(completed).toHaveLength(2); expect(all.findIndex(event => event.type === "message_completed")).toBeLessThan(all.findIndex(event => event.type === "tool_call" && event.status === "started"));
    if (text === "stream") { expect(deltas).toHaveLength(2); expect(deltas.map(e => e.messageId)).toEqual(completed.map(e => e.messageId!)); }
    else expect(deltas).toHaveLength(0);
    const loaded = await client.channelMessages({ channel: "a" }); expect(loaded.messages.filter(message => message.actor.kind === "agent").map(message => message.messageId)).toEqual(completed.map(event => event.messageId!));
  } finally { client.close(); server.dispose(); session.stop("done"); }
});

test("a slow streaming reader drops Alice deltas while Bob still commits", async () => {
  const { LiveQueue } = await import("../src/interfaces/protocol/live-queue.ts");
  const model: Model = async () => { throw new Error("attempt adapter expected"); };
  const session = createSession({ systemPrompt: "test", configureTurn: turn => {
    const bound: Model = (...args) => model(...args);
    bindModelAttempt(bound, { scripted: false, create: () => async function* () {
      const text = turn.channelId === "alice" ? "x".repeat(1_200_000) : "bob";
      if (turn.channelId === "alice") { yield { type: "text_delta", text: text.slice(0, 600_000) }; yield { type: "text_delta", text: text.slice(600_000) }; }
      else yield { type: "text_delta", text };
      yield { type: "response", response: { role: "assistant", content: text, calls: [], stopReason: "complete" } };
    } });
    return { model: bound, tools: [], executeTool: async () => "unused" };
  } });
  const server = createProtocolServer(async () => ({ session, close() {} }), { durable: true });
  const client = new HarnessClient(createInProcessTransport(server)); const sent: any[] = []; let release!: () => void, first = true, failure: unknown;
  const queue = new LiveQueue(async item => { sent.push(item); if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); } }, error => { failure = error; });
  try {
    await client.initialize({ protocolVersion: 1, host: { name: "test", version: "0" }, callbacks: [], subscription: { text: "stream", tools: "full" } });
    await client.createSession({ sessionId: "s", participants: [], channels: {} }); const unsubscribe = server.subscribe(value => queue.send(value));
    session.agent.send({ channelId: "alice", participantId: "a", text: "hi" }); session.agent.send({ channelId: "bob", participantId: "b", text: "hi" });
    for (let i = 0; i < 500 && !session.snapshot().turns.some(turn => turn.channelId === "bob" && turn.state.status === "completed"); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(session.snapshot().turns.find(turn => turn.channelId === "bob")?.state.status).toBe("completed"); expect(failure).toBeUndefined();
    release(); await queue.flush(); unsubscribe();
    expect(sent.some(value => value.params?.channel === "alice" && value.params.event.type === "text_gap")).toBe(true);
    expect(session.snapshot().timeline.some(entry => entry.channelId === "bob" && entry.message.role === "assistant" && entry.message.content === "bob")).toBe(true);
  } finally { client.close(); server.dispose(); session.stop("done"); }
});

test("a storage commit failure terminates an already published draft", async () => {
  const { createMemoryStorageAdapter } = await import("../src/state/storage/memory.ts");
  const opened = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "s", compatibilityKey: "k" } });
  if (!opened.ok) throw new Error(opened.error.message); const storage = opened.value;
  storage.commitResponse = () => ({ ok: false, error: { code: "storage_failure", message: "injected" } });
  const model: Model = async () => { throw new Error("unused"); };
  bindModelAttempt(model, { scripted: false, create: () => async function* () {
    yield { type: "text_delta", text: "draft" }; yield { type: "response", response: { role: "assistant", content: "draft", calls: [], stopReason: "complete" } };
  } });
  const session = createSession({ systemPrompt: "test", storage, configureTurn: () => ({ model, tools: [], executeTool: async () => "unused" }) });
  const events: ChannelEvent[] = []; session.subscribe(event => events.push(event)); session.start();
  try {
    session.agent.send({ channelId: "a", participantId: "u", text: "hi" });
    for (let i = 0; i < 500 && !events.some(event => event.event.type === "turn_ended"); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(events.map(event => event.event.type)).toContain("text_incomplete");
    expect(events.some(event => event.event.type === "message_completed")).toBe(false);
  } finally { session.stop("done"); storage.close(); }
});
