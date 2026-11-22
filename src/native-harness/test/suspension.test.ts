import { inspectOperatorView } from "./helpers/operator-view.ts";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../src/index.ts";
import { createInProcessHarness } from "../src/testing.ts";
import type { HarnessClient } from "../src/client.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import type { ChannelEvent, SessionEvent } from "../src/contracts/events.ts";
import type { CreateParams, ProtocolConfig } from "../src/contracts/protocol.ts";
import type { SessionStorageAdapter } from "../src/contracts/storage.ts";
import { spawnHarness } from "./helpers/stdio.ts";
import { lastInput } from "./helpers/session.ts";

const root = mkdtempSync(join(tmpdir(), "harness-suspend-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const config: ProtocolConfig = { version: 1, system: "Test system", model: { protocol: "scripted", script: new URL("./fixtures/hold-scenario.jsonl", import.meta.url).pathname }, defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow", tools: {} } } };
const setup: CreateParams = { sessionId: "paused", participants: [], channels: {}, config };
const push = (channel: string, id: string, text: string) => ({ channel, item: { id, kind: "user_message" as const, sender: channel, content: [{ type: "text" as const, text }] } });
const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${what}`);
}
function watch(client: HarnessClient) {
  const channel: ChannelEvent[] = [], session: SessionEvent[] = [], order: string[] = [];
  client.onChannelEvent(event => { channel.push(event); order.push(`${event.channel}:${event.event.type}`); });
  client.onSessionEvent(event => { session.push(event); order.push(`session:${event.lifecycle}`); });
  return { channel, session, order, types: (id: string) => channel.filter(event => event.channel === id).map(event => event.event.type) };
}
/** A durable place for one test: SQLite files for stdio, a lasting memory adapter in-process. */
function place(transport: "in-process" | "stdio") {
  const home = mkdtempSync(join(root, "home-")), effects = join(home, "effects.log");
  const locations = new Map<string, SessionStorageAdapter>();
  const adapter = (id: string) => locations.get(id) ?? locations.set(id, createMemoryStorageAdapter()).get(id)!;
  return { effects, at: { home, effects }, release: (key = "k") => writeFileSync(`${effects}.release-${key}`, ""),
    open: () => transport === "stdio" ? spawnHarness({ home, effects }) : createInProcessHarness({ adapter, effects }) };
}

for (const transport of ["in-process", "stdio"] as const) test(`${transport}: channel controls persist and expose independent state`, async () => {
  const { effects, release, open } = place(transport);
  const first = open();
  try {
    const init = await first.client.initialize();
    expect(init.description.capabilities.methods).toContain("channel/interrupt");
    await first.client.createSession(setup);
    const seen = watch(first.client);
    expect(await first.client.createChannel({ channel: "idle", displayName: "Idle" })).toMatchObject({ created: true, channel: { lifecycle: "open", displayName: "Idle" } });
    expect(await first.client.editChannel({ channel: "idle", displayName: "Renamed" })).toMatchObject({ channel: { displayName: "Renamed" } });
    expect(await first.client.deleteChannel({ channel: "idle" })).toMatchObject({ channel: { lifecycle: "retired" } });
    await expect(first.client.createChannel({ channel: "idle" })).rejects.toMatchObject({ code: "channel_retired" });
    await first.client.push(push("a", "a1", "start"));
    await until(() => lines(effects).includes("start:k"), "alice tool");
    await first.client.push(push("a", "withdraw", "remove"));
    await first.client.push(push("a", "a2", "pending"));
    expect(await first.client.withdrawItem({ channel: "a", item: "withdraw" })).toMatchObject({ outcome: "withdrawn", item: { milestone: "withdrawn" } });
    const suspended = first.client.suspendChannel({ channel: "a" });
    await until(async () => (await first.client.status()).channels.find(c => c.channel === "a")?.lifecycle === "suspending", "channel suspension");
    await expect(first.client.push(push("a", "late", "late"))).rejects.toMatchObject({ code: "channel_suspended" });
    await expect(first.client.deleteChannel({ channel: "a" })).rejects.toMatchObject({ code: "channel_busy" });
    await first.client.push(push("b", "b1", "bob"));
    await until(() => lines(effects).filter(line => line === "start:k").length === 2, "bob tool");
    await first.client.interruptTurn({ channel: "b", turn: "2" });
    await first.client.push(push("b", "b2", "bob continues"));
    await until(() => seen.channel.some(e => e.channel === "b" && e.event.type === "turn_ended" && e.event.outcome === "completed"), "bob completes while alice suspends");
    release();
    expect(await suspended).toMatchObject({ channel: { lifecycle: "suspended", waitingForResume: true, pending: ["a2"] } });
    expect(seen.types("a")).toContain("item_withdrawn");
  } finally { await first.close(); }
  const second = open();
  try {
    await second.client.initialize();
    const loaded = await inspectOperatorView(second.client, { sessionId: "paused", config });
    expect(loaded.status.channels).toEqual(expect.arrayContaining([expect.objectContaining({ channel: "a", lifecycle: "suspended", waitingForResume: true }), expect.objectContaining({ channel: "idle", lifecycle: "retired" })]));
    expect(await second.client.push(push("a", "withdraw", "remove"))).toMatchObject({ duplicate: true, item: { milestone: "withdrawn" } });
    expect(await second.client.interruptTurn({ channel: "a", turn: "1" })).toMatchObject({ interrupted: false, turn: { state: "suspended" } });
    const seen = watch(second.client);
    await second.client.resumeChannel({ channel: "a" });
    await until(() => seen.types("a").includes("turn_ended"), "resumed turn");
    const after = await inspectOperatorView(second.client, { sessionId: "paused", config });
    expect(after.turns[0]).toMatchObject({ state: "completed", items: ["a1", "a2"] });
    expect(lines(effects).filter(line => line === "start:k")).toHaveLength(2);
    expect(await second.client.withdrawItem({ channel: "a", item: "a2" })).toMatchObject({ outcome: "taken", item: { turnId: "1" } });
    await expect(second.client.push(push("idle", "new", "no"))).rejects.toMatchObject({ code: "channel_retired" });
  } finally { await second.close(); }
}, 20000);

for (const transport of ["in-process", "stdio"] as const) test(`${transport}: targeted interruption leaves a later turn alone`, async () => {
  const { effects, release, open } = place(transport), harness = open();
  try {
    await harness.client.initialize(); await harness.client.createSession(setup);
    const seen = watch(harness.client);
    await harness.client.push(push("a", "a1", "first"));
    await until(() => lines(effects).includes("start:k"), "first tool");
    await harness.client.push(push("a", "a2", "second"));
    expect(await harness.client.interruptTurn({ channel: "a", turn: "1" })).toMatchObject({ interrupted: true, turn: { state: "interrupted", uncertainCalls: ["hold-1"] } });
    await until(() => seen.channel.some(e => e.event.type === "turn_started" && e.event.turnId === "2"), "second turn");
    expect(await harness.client.interruptTurn({ channel: "a", turn: "1" })).toMatchObject({ interrupted: false });
    release();
    await until(() => seen.channel.some(e => e.event.type === "turn_ended" && e.event.turnId === "2"), "second turn completion");
    const loaded = await inspectOperatorView(harness.client, { sessionId: "paused", config });
    expect(loaded.turns).toMatchObject([{ turnId: "1", state: "interrupted" }, { turnId: "2", state: "completed", items: ["a2"] }]);
  } finally { await harness.close(); }
}, 20000);

for (const transport of ["in-process", "stdio"] as const) test(`${transport}: two active channels suspend at their iteration boundary, stay paused across reopen, and resume without repeating work`, async () => {
  const { effects, release, open } = place(transport);
  const first = open();
  try {
    const init = await first.client.initialize();
    expect(init.description.capabilities.methods).toEqual(expect.arrayContaining(["session/suspend", "session/resume", "session/stop"]));
    await first.client.createSession(setup);
    const seen = watch(first.client);
    await Promise.all([first.client.push(push("a", "a1", "start a")), first.client.push(push("b", "b1", "start b"))]);
    await until(() => lines(effects).filter(line => line === "start:k").length === 2, "both tools to start");
    // Accepted while its channel's tool is running, before suspension begins.
    expect(await first.client.push(push("a", "a2", "steer a"))).toMatchObject({ duplicate: false, item: { milestone: "received" } });

    let suspended = false;
    const suspending = first.client.suspend().then(status => { suspended = true; return status; });
    await until(async () => (await first.client.status()).lifecycle === "suspending", "suspension to begin");
    // New external work is refused; a retry of accepted work is still answered.
    await expect(first.client.push(push("b", "b2", "too late"))).rejects.toMatchObject({ code: "not_running" });
    expect(await first.client.push(push("a", "a2", "steer a"))).toMatchObject({ duplicate: true, item: { milestone: "received" } });
    expect(await first.client.status()).toMatchObject({ execution: "suspending", channels: [
      { channel: "a", activeTurn: { turnId: "1", state: "running" }, pending: ["a2"] }, { channel: "b", activeTurn: { turnId: "2", state: "running" }, pending: [] }] });
    await new Promise(resolve => setTimeout(resolve, 30));
    // Suspension waits for the running tools; it does not cancel them.
    expect(suspended).toBe(false);
    release();
    const status = await suspending;
    expect(status).toMatchObject({ lifecycle: "suspended", execution: "suspended", channels: [
      { channel: "a", activeTurn: { turnId: "1", state: "suspended" }, pending: ["a2"] }, { channel: "b", activeTurn: { turnId: "2", state: "suspended" }, pending: [] }] });
    expect(lines(effects).sort()).toEqual(["done:k", "done:k", "start:k", "start:k"]);
    await until(() => seen.session.length === 2, "lifecycle events");
    // Each iteration finished its tool, then checkpointed instead of inferring or taking input.
    for (const channel of ["a", "b"]) expect(seen.types(channel)).toEqual(["turn_started", "items_receipt", "items_receipt", "message_completed", "tool_call", "tool_call", "turn_suspended"]);
    expect(seen.session.map(event => event.lifecycle)).toEqual(["suspending", "suspended"]);
    expect(seen.order.at(-1)).toBe("session:suspended");
    expect(seen.session[1]!.revision).toBe(status.revision);
    // Repeating the request is harmless; a suspended session still refuses work and reports idle.
    expect(await first.client.suspend()).toMatchObject({ lifecycle: "suspended", revision: status.revision });
    await expect(first.client.push(push("b", "b2", "too late"))).rejects.toMatchObject({ code: "not_running" });
    expect(await first.client.idle()).toEqual({ idle: true });
  } finally { await first.close(); }

  const second = open();
  try {
    await second.client.initialize();
    const seen = watch(second.client);
    const loaded = await inspectOperatorView(second.client, { sessionId: "paused", config });
    expect(loaded.status).toMatchObject({ lifecycle: "suspended", execution: "suspended" });
    expect(loaded.turns).toMatchObject([{ turnId: "1", state: "suspended", items: ["a1"] }, { turnId: "2", state: "suspended", items: ["b1"] }]);
    expect(loaded.items.map(item => [item.id, item.milestone])).toEqual([["a1", "seen"], ["b1", "seen"], ["a2", "received"]]);
    // Opening is not resuming: nothing runs, nothing is published, work is still refused.
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(seen.order).toEqual([]);
    expect(await second.client.status()).toMatchObject({ lifecycle: "suspended", revision: loaded.status.revision });
    await expect(second.client.push(push("b", "b2", "still paused"))).rejects.toMatchObject({ code: "not_running" });

    const resumed = await second.client.resume();
    expect(resumed.lifecycle).toBe("running");
    await until(() => seen.channel.filter(event => event.event.type === "turn_ended").length === 2, "resumed turns to end");
    // The resumed turn on a takes the pending item before its first inference; b infers directly.
    expect(seen.types("a")).toEqual(["turn_resumed", "turn_took", "items_receipt", "items_receipt", "message_completed", "turn_ended"]);
    expect(seen.types("b")).toEqual(["turn_resumed", "message_completed", "turn_ended"]);
    expect(seen.order[0]).toBe("session:running");
    expect(seen.channel.find(event => event.event.type === "turn_took")!.event).toMatchObject({ turnId: "1", items: ["a2"] });
    expect(seen.channel.flatMap(event => event.event.type === "message_completed" ? [event.event.parts![0]!.text] : [])).toEqual(["Finished.", "Finished."]);
    expect(seen.channel.filter(event => event.event.type === "tool_call")).toEqual([]);
    // The completed calls ran once across both processes.
    expect(lines(effects).sort()).toEqual(["done:k", "done:k", "start:k", "start:k"]);
    const after = await inspectOperatorView(second.client, { sessionId: "paused", config });
    expect(after.turns).toMatchObject([{ turnId: "1", state: "completed", items: ["a1", "a2"] }, { turnId: "2", state: "completed", items: ["b1"] }]);
    expect(after.items.map(item => [item.id, item.milestone, item.turnId])).toEqual([["a1", "seen", "1"], ["b1", "seen", "2"], ["a2", "seen", "1"]]);
    expect(after.status).toMatchObject({ lifecycle: "running", execution: "idle" });
    // Resuming a running session changes nothing, and new work runs again.
    expect(await second.client.resume()).toMatchObject({ lifecycle: "running" });
    await second.client.push(push("b", "b2", "after resume"));
    await until(() => seen.channel.filter(event => event.event.type === "turn_ended").length === 3, "fresh turn");
    expect(seen.channel.at(-1)).toMatchObject({ channel: "b", event: { turnId: "3", outcome: "completed" } });
  } finally { await second.close(); }
}, 20000);

for (const transport of ["in-process", "stdio"] as const) test(`${transport}: a checkpoint from another configuration can be inspected but not resumed, and is left untouched`, async () => {
  const { release, open } = place(transport);
  const first = open();
  try {
    await first.client.initialize(); await first.client.createSession(setup);
    await first.client.push(push("a", "a1", "start"));
    await until(async () => (await first.client.status()).channels[0]?.activeTurn !== undefined, "turn to start");
    await first.client.push(push("a", "a2", "pending"));
    const suspending = first.client.suspend();
    // Release the tool only once suspension has begun, so the turn checkpoints instead of finishing.
    await until(async () => (await first.client.status()).lifecycle === "suspending", "suspension to begin");
    release(); await suspending;
  } finally { await first.close(); }

  const changed = open();
  let before;
  try {
    await changed.client.initialize();
    const seen = watch(changed.client);
    // A different system prompt is a different configuration: readable, not resumable.
    before = await inspectOperatorView(changed.client, { sessionId: "paused", config: { ...config, system: "Another system" } });
    expect(before.status).toMatchObject({ lifecycle: "suspended" });
    expect(before.turns).toMatchObject([{ turnId: "1", state: "suspended" }]);
    await expect(changed.client.resume()).rejects.toMatchObject({ code: "incompatible" });
    expect(await inspectOperatorView(changed.client, { sessionId: "paused", config: { ...config, system: "Another system" } })).toEqual(before);
    expect(seen.order).toEqual([]);
  } finally { await changed.close(); }

  const original = open();
  try {
    await original.client.initialize();
    const seen = watch(original.client);
    expect(await inspectOperatorView(original.client, { sessionId: "paused", config })).toEqual(before);
    await original.client.resume();
    await until(() => seen.channel.some(event => event.event.type === "turn_ended"), "resumed turn");
    expect(seen.channel.at(-1)!.event).toMatchObject({ turnId: "1", outcome: "completed" });
  } finally { await original.close(); }
}, 20000);

for (const transport of ["in-process", "stdio"] as const) test(`${transport}: stop cancels a running tool at once, reports the turn interrupted and keeps pending input`, async () => {
  const { effects, release, open } = place(transport);
  const first = open();
  try {
    await first.client.initialize(); await first.client.createSession(setup);
    const seen = watch(first.client);
    await first.client.push(push("a", "a1", "start"));
    await until(() => lines(effects).includes("start:k"), "tool to start");
    await first.client.push(push("a", "a2", "pending"));
    // Stop answers without waiting for the tool, which is still unreleased.
    const stopped = await first.client.stop();
    expect(stopped).toMatchObject({ lifecycle: "running", execution: "stopped",
      channels: [{ channel: "a", pending: ["a2"], unresolved: { turnId: "1", state: "interrupted", uncertainCalls: ["hold-1"] } }] });
    expect(stopped.channels[0]!.activeTurn).toBeUndefined();
    await until(() => seen.channel.some(event => event.event.type === "turn_ended"), "interruption event");
    expect(seen.channel.at(-1)).toMatchObject({ revision: stopped.revision, event: { turnId: "1", outcome: "interrupted", uncertainCalls: ["hold-1"] } });
    const published = seen.channel.length;
    // Releasing the tool afterwards cannot advance the stopped turn or start anything.
    release();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(lines(effects)).toEqual(["start:k"]);
    expect(seen.channel).toHaveLength(published);
    expect((await first.client.status()).revision).toBe(stopped.revision);
    await expect(first.client.push(push("a", "a3", "after stop"))).rejects.toMatchObject({ code: "stopped" });
    await expect(first.client.suspend()).rejects.toMatchObject({ code: "stopped" });
    await expect(first.client.resume()).rejects.toMatchObject({ code: "stopped" });
    expect(await first.client.stop()).toMatchObject({ execution: "stopped", revision: stopped.revision });
  } finally { await first.close(); }

  // The next owner finds the turn interrupted and runs only the input that was never taken.
  const second = open();
  try {
    await second.client.initialize();
    const seen = watch(second.client);
    const loaded = await inspectOperatorView(second.client, { sessionId: "paused", config });
    expect(loaded.turns.slice(0, 1)).toMatchObject([{ turnId: "1", state: "interrupted", items: ["a1"], uncertainCalls: ["hold-1"] }]);
    await until(() => seen.channel.some(event => event.event.type === "turn_ended"), "pending input to run");
    expect(seen.channel[0]!.event).toMatchObject({ type: "turn_started", turnId: "2", items: ["a2"] });
    expect(seen.channel.at(-1)!.event).toMatchObject({ turnId: "2", outcome: "completed" });
    expect(seen.channel.filter(event => event.event.type === "tool_call")).toEqual([]);
  } finally { await second.close(); }
}, 20000);

test("stop during suspension interrupts turns already checkpointed, and suspension reports stopped", async () => {
  let releaseTool!: () => void, releaseFast!: () => void;
  const tool = new Promise<void>(resolve => { releaseTool = resolve; }), fast = new Promise<void>(resolve => { releaseFast = resolve; });
  const session = createSession({ systemPrompt: "test", configureTurn: turn => ({ tools: [],
    executeTool: async () => { await (turn.channelId === "slow" ? tool : fast); return "result"; },
    model: async messages => messages.some(message => message.role === "tool")
      ? { role: "assistant", content: "done", calls: [] } : { role: "assistant", content: null, calls: [{ id: `call-${turn.channelId}`, name: "tool", arguments: "{}" }] } }) });
  const lifecycle: string[] = [], ended: ChannelEvent[] = [];
  session.subscribeSession(event => lifecycle.push(event.lifecycle));
  session.subscribe(event => { if (event.event.type === "turn_ended") ended.push(event); });
  session.start();
  session.agent.send({ channelId: "fast", participantId: "ana", text: "go" });
  session.agent.send({ channelId: "slow", participantId: "ana", text: "go" });
  await until(() => session.snapshot().timeline.filter(entry => entry.message.role === "assistant").length === 2, "both tools to start");
  const suspending = session.suspend();
  releaseFast();
  await until(() => session.snapshot().turns[0]!.state.status === "suspended", "fast turn checkpoint");
  expect(session.suspend()).toBe(suspending);
  const status = session.stop("operator stop");
  expect(await suspending).toEqual({ ok: false, error: { code: "stopped", message: expect.any(String) } });
  expect(status).toMatchObject({ lifecycle: "running", execution: "stopped" });
  // Both the checkpointed turn and the running one are interrupted; only the running call is uncertain.
  expect(session.snapshot().turns.map(turn => turn.state)).toEqual([
    { status: "interrupted", reason: "operator stop", uncertainCallIds: [] }, { status: "interrupted", reason: "operator stop", uncertainCallIds: ["call-slow"] }]);
  expect(ended.map(event => [event.channel, event.event.type === "turn_ended" && event.event.outcome])).toEqual([["fast", "interrupted"], ["slow", "interrupted"]]);
  expect(lifecycle).toEqual(["suspending", "running"]);
  // A tool that ignores cancellation returns late: its result is refused and nothing restarts.
  const revision = session.snapshot().revision;
  releaseTool();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(session.snapshot().revision).toBe(revision);
  expect(session.snapshot().timeline.filter(entry => entry.message.role === "tool")).toHaveLength(1);
  expect(await session.suspend()).toMatchObject({ ok: false, error: { code: "stopped" } });
  expect(session.resume()).toMatchObject({ ok: false, error: { code: "stopped" } });
  expect(session.agent.send({ channelId: "fast", participantId: "ana", text: "more" })).toMatchObject({ accepted: false, code: "stopped" });
});

test("suspension during inference finishes the iteration: tool-free answers complete, tool requests run and checkpoint", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const executed: string[] = [], inferences: string[] = [];
  const session = createSession({ systemPrompt: "test", configureTurn: turn => ({ tools: [],
    executeTool: async call => { executed.push(call.id); return "result"; },
    model: async messages => {
      inferences.push(turn.channelId);
      if (!messages.some(message => message.role === "tool")) await gate;
      return turn.channelId === "tools" && !messages.some(message => message.role === "tool")
        ? { role: "assistant", content: null, calls: [{ id: "one", name: "tool", arguments: "{}" }, { id: "two", name: "tool", arguments: "{}" }] }
        : { role: "assistant", content: `answer for ${turn.channelId}`, calls: [] };
    } }) });
  session.start();
  session.agent.send({ channelId: "plain", participantId: "ana", text: "question" });
  session.agent.send({ channelId: "tools", participantId: "ana", text: "work" });
  await until(() => inferences.length === 2, "both inferences in flight");
  const suspending = session.suspend();
  expect(session.agent.send({ channelId: "plain", participantId: "ana", text: "late" })).toMatchObject({ accepted: false, code: "not_running" });
  release();
  expect(await suspending).toMatchObject({ ok: true, status: { lifecycle: "suspended" } });
  // The naturally finished turn completed; the other ran both requested tools and stopped before inferring.
  expect(session.snapshot().turns.map(turn => turn.state.status)).toEqual(["completed", "suspended"]);
  expect(executed).toEqual(["one", "two"]);
  expect(inferences).toEqual(["plain", "tools"]);
  expect(session.resume()).toMatchObject({ ok: true, status: { lifecycle: "running" } });
  await until(() => session.agent.idle(), "resumed turn");
  expect(session.snapshot().turns.map(turn => turn.state.status)).toEqual(["completed", "completed"]);
  // One more inference for the resumed turn, no tool repeated, and the completed turn untouched.
  expect(inferences).toEqual(["plain", "tools", "tools"]);
  expect(executed).toEqual(["one", "two"]);
  expect(session.snapshot().timeline.filter(entry => entry.channelId === "plain").map(entry => entry.message.role)).toEqual(["user", "assistant"]);
});

test("a notice accepted while its target is idle or checkpointing waits for resume and starts no inference during suspension", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const inferences: string[] = [];
  const session = createSession({ systemPrompt: "test", configureTurn: (turn, notify) => ({ tools: [],
    executeTool: async () => {
      await gate;
      // Finishing work may still notify other channels after suspension began.
      return JSON.stringify([notify({ channelId: "idle", fromChannelId: turn.channelId, text: "for the idle channel" }),
        notify({ channelId: "busy", fromChannelId: turn.channelId, text: "for the checkpointing channel" })].map(result => result.accepted));
    },
    model: async messages => {
      inferences.push(`${turn.channelId}:${lastInput(messages)}`);
      return turn.channelId === "busy" && !messages.some(message => message.role === "tool")
        ? { role: "assistant", content: null, calls: [{ id: "notify", name: "tool", arguments: "{}" }] }
        : { role: "assistant", content: "ok", calls: [] };
    } }) });
  session.start();
  session.agent.send({ channelId: "idle", participantId: "ana", text: "hello" });
  await until(() => session.agent.idle(), "idle channel to finish");
  session.agent.send({ channelId: "busy", participantId: "ana", text: "work" });
  await until(() => inferences.length === 2, "busy inference");
  const suspending = session.suspend();
  release();
  expect(await suspending).toMatchObject({ ok: true });
  const paused = session.snapshot();
  expect(paused.timeline.findLast(entry => entry.message.role === "tool")!.message.content).toBe("[true,true]");
  expect(paused.items.filter(item => item.kind === "channel_notice").map(item => [item.channelId, item.milestone])).toEqual([["idle", "received"], ["busy", "received"]]);
  expect(paused.turns.map(turn => [turn.channelId, turn.state.status])).toEqual([["idle", "completed"], ["busy", "suspended"]]);
  expect(inferences).toHaveLength(2);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(inferences).toHaveLength(2);
  expect(session.resume()).toMatchObject({ ok: true });
  await until(() => session.agent.idle(), "resume to settle");
  const view = session.snapshot();
  // The idle channel's notice started one new turn; the busy channel's joined its resumed turn.
  expect(view.turns.map(turn => [turn.channelId, turn.state.status, turn.itemIds.length])).toEqual([["idle", "completed", 1], ["busy", "completed", 2], ["idle", "completed", 1]]);
  expect(view.items.every(item => item.milestone === "seen")).toBe(true);
  expect(inferences.slice(2).sort()).toEqual(["busy:for the checkpointing channel", "idle:for the idle channel"]);
});

test("a process killed after checkpointing but before suspension commits reopens with those turns interrupted", async () => {
  const { release, open, at } = place("stdio");
  const doomed = spawnHarness({ ...at, fault: "checkpointTurn:1" });
  await doomed.client.initialize(); await doomed.client.createSession(setup);
  await doomed.client.push(push("a", "a1", "start"));
  await until(async () => (await doomed.client.status()).channels[0]?.activeTurn !== undefined, "turn to start");
  await doomed.client.push(push("a", "a2", "pending"));
  const suspending = doomed.client.suspend().catch(error => error);
  await until(async () => (await doomed.client.status()).lifecycle === "suspending", "suspension to begin");
  release();
  expect(await doomed.child.exited).not.toBe(0);
  expect(await suspending).toMatchObject({ code: "transport_closed" });
  doomed.client.close();
  const next = open();
  try {
    await next.client.initialize();
    const seen = watch(next.client);
    const loaded = await inspectOperatorView(next.client, { sessionId: "paused", config });
    // The checkpoint was durable, the suspension was not: this is interruption, not a paused session.
    expect(loaded.status).toMatchObject({ lifecycle: "running" });
    expect(loaded.turns.slice(0, 1)).toMatchObject([{ turnId: "1", state: "interrupted", items: ["a1"], uncertainCalls: [] }]);
    await until(() => seen.channel.some(event => event.event.type === "turn_ended"), "pending input to run");
    expect(seen.channel[0]!.event).toMatchObject({ type: "turn_started", turnId: "2", items: ["a2"] });
  } finally { await next.close(); }
}, 20000);

test("stdio: closing stdin stops the session at once; the next process finds the turn interrupted and the input pending", async () => {
  const { effects, open } = place("stdio");
  const first = open() as ReturnType<typeof spawnHarness>;
  await first.client.initialize(); await first.client.createSession(setup);
  await first.client.push(push("a", "a1", "start"));
  await until(() => lines(effects).includes("start:k"), "tool to start");
  await first.client.push(push("a", "a2", "pending"));
  const closing = Date.now();
  // The tool is never released: a drain would run into the five-second grace and exit nonzero.
  await first.close();
  expect(Date.now() - closing).toBeLessThan(2000);
  // The interruption was committed and published before the process exited.
  const last = (await first.stdout).trim().split("\n").map(line => JSON.parse(line)).findLast(message => message.method === "channel/event");
  expect(last.params.event).toMatchObject({ type: "turn_ended", turnId: "1", outcome: "interrupted", uncertainCalls: ["hold-1"] });
  const second = open();
  try {
    await second.client.initialize();
    const seen = watch(second.client);
    const loaded = await inspectOperatorView(second.client, { sessionId: "paused", config });
    expect(loaded.turns.slice(0, 1)).toMatchObject([{ turnId: "1", state: "interrupted", reason: "Stopped by the host", uncertainCalls: ["hold-1"] }]);
    await until(() => seen.channel.some(event => event.event.type === "turn_ended"), "pending input to run");
    expect(seen.channel[0]!.event).toMatchObject({ type: "turn_started", turnId: "2", items: ["a2"] });
    expect(lines(effects)).toEqual(["start:k"]);
  } finally { await second.close(); }
}, 20000);
