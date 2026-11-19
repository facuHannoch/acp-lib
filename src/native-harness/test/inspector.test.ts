import { expect, test } from "bun:test";
import { createInspection } from "../src/interfaces/inspector/state.ts";
import { serveInspector } from "../src/interfaces/inspector/server.ts";
import type { Message } from "../src/contracts/loop.ts";
import { createSession } from "../src/index.ts";
import { observeAgent, observeContext, observeEvents } from "../src/interfaces/inspector/observe.ts";
import { turnsEnd } from "./helpers/session.ts";
import { buildSharedContext } from "../src/capabilities/context/build.ts";

test("live context follows the shared store across channels, including before first inference", async () => {
  const session = createSession({ systemPrompt: "system", configureTurn: () => ({ tools: [], executeTool: async () => "unused",
    model: () => new Promise(() => {}) }) });
  const store = session.store;
  const tools = [{ name: "clock", description: "Time", parameters: {} }];
  const inspection = createInspection("system", tools);
  const unsubscribe = observeContext(store, inspection, entries => buildSharedContext(entries, "system"));
  expect(inspection.snapshot().liveContext.base).toEqual(buildSharedContext([], "system"));
  expect(inspection.snapshot().liveContext.request).toBeNull();
  session.start();
  session.agent.send({ channelId: "a", participantId: "alice", text: "one" });
  session.agent.send({ channelId: "b", participantId: "bob", text: "two" });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(store.snapshot().map(entry => [entry.channelId, entry.turnId, entry.from])).toEqual([["a", 1, "alice"], ["b", 2, "bob"]]);
  const state = inspection.snapshot();
  expect(state.liveContext).toEqual({ systemPrompt: "system", tools, entries: store.snapshot(),
    base: buildSharedContext(store.snapshot(), "system"), request: null });
  expect(state.channels.map((channel) => channel.id)).toEqual(["a", "b"]);
  state.liveContext.entries[0]!.message.content = "changed";
  expect(inspection.snapshot().liveContext.entries[0]?.message.content).toBe('Participant: "alice"\n\none');
  unsubscribe();
});

test("channel activity follows acceptance and committed turn events, including a shared failed turn", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const session = createSession({ systemPrompt: "system", configureTurn: () => ({ tools: [], executeTool: async () => "unused",
    model: async () => { await gate; throw new Error("provider down"); } }) });
  const inspection = createInspection("system");
  observeEvents(session.subscribe, inspection);
  const agent = observeAgent(session.agent, inspection);
  session.start();
  const log = turnsEnd(session);
  agent.send({ channelId: "a", participantId: "alice", text: "one", itemId: "1" });
  agent.send({ channelId: "a", participantId: "alice", text: "one", itemId: "1" });
  expect(inspection.snapshot().channels[0]).toMatchObject({ id: "a", pending: 1, running: false, participants: ["alice"] });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(inspection.snapshot().channels[0]).toMatchObject({ pending: 1, running: true });
  release(); await log.done;
  expect(inspection.snapshot().channels[0]).toMatchObject({ pending: 0, running: false, error: "Error: provider down" });
});

test("inspection snapshots do not alias live history or inference requests", () => {
  const inspection = createInspection("system");
  inspection.accepted("a", "alice");
  inspection.running("a", true);
  const history: Message[] = [{ role: "user", content: "original" }];
  inspection.history("a", history);
  inspection.request("a", JSON.stringify({ messages: history, tools: [] }));
  history[0]!.content = "changed";
  const first = inspection.snapshot();
  expect(first.channels[0]?.messages[0]?.content).toBe("original");
  expect(first.channels[0]?.requests[0]?.body).toEqual({ messages: [{ role: "user", content: "original" }], tools: [] });
  expect(first.liveContext.request).toMatchObject({ channelId: "a", number: 1,
    body: { messages: [{ role: "user", content: "original" }], tools: [] } });
  inspection.request("b", JSON.stringify({ messages: [{ role: "user", content: "new" }] }));
  expect(inspection.snapshot().liveContext.request?.channelId).toBe("b");
  expect(first.liveContext.request?.channelId).toBe("a");
  first.channels[0]!.messages.length = 0;
  expect(inspection.snapshot().channels[0]?.messages.length).toBe(1);
  inspection.running("a", false);
  inspection.finished("a", "failed");
  expect(inspection.snapshot().channels[0]).toMatchObject({ pending: 0, running: false, error: "failed" });
});

test("iteration responses stay paired with their channel and turn", () => {
  const inspection = createInspection("system");
  const body = JSON.stringify({ messages: [], tools: [] });
  inspection.request("a", body, 1);
  inspection.request("b", body, 2);
  const answer = { role: "assistant" as const, content: "B answer", calls: [] };
  inspection.response("b", answer);
  answer.content = "mutated";
  inspection.response("a", { role: "assistant", content: "A tool call", calls: [] });
  inspection.request("a", body, 1);
  inspection.response("a", { role: "assistant", content: "A final", calls: [] });
  const channels = inspection.snapshot().channels;
  expect(channels[0]?.requests.map(r => [r.turnId, r.response?.content])).toEqual([[1, "A tool call"], [1, "A final"]]);
  expect(channels[1]?.requests[0]).toMatchObject({ turnId: 2, response: { content: "B answer" } });
});

test("inspector serves a read-only page, streams changes, and reconnects with current state", async () => {
  const inspection = createInspection("system");
  const server = serveInspector(inspection, 0);
  let cancel = async () => {};
  try {
    const html = await fetch(server.url);
    expect(await html.text()).toContain("Harness context inspector");
    expect((await fetch(new URL("/state", server.url), { method: "POST" })).status).toBe(405);
    const events = await fetch(new URL("/events", server.url));
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    const reader = events.body!.getReader();
    cancel = () => reader.cancel();
    const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toContain('"channels":[]');
    inspection.accepted("a", "<script>untrusted</script>");
    const update = await reader.read();
    expect(new TextDecoder().decode(update.value)).toContain('"id":"a"');
    await reader.cancel();
    const reconnect = await fetch(new URL("/events", server.url));
    const reconnectedReader = reconnect.body!.getReader();
    cancel = () => reconnectedReader.cancel();
    expect(new TextDecoder().decode((await reconnectedReader.read()).value)).toContain('"id":"a"');
    const state = await (await fetch(new URL("/state", server.url))).json();
    expect(state).toEqual(inspection.snapshot());
  } finally {
    await cancel();
    await server.stop(true);
  }
});
