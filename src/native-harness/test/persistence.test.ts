import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../src/index.ts";
import { createInProcessHarness } from "../src/testing.ts";
import { HarnessClient, createInProcessTransport } from "../src/client.ts";
import { createProtocolServer } from "../src/interfaces/protocol/server.ts";
import { FrameLimit, loadView, pageMessages } from "../src/interfaces/protocol/load.ts";
import { sessionStatus } from "../src/kernel/channels.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import type { ChannelEvent } from "../src/contracts/events.ts";
import type { CreateParams } from "../src/contracts/protocol.ts";
import type { SessionStorageAdapter } from "../src/contracts/storage.ts";
import { recordWire, spawnHarness } from "./helpers/stdio.ts";
import { lastInput, turnsEnd } from "./helpers/session.ts";

const root = mkdtempSync(join(tmpdir(), "harness-persist-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const setup: CreateParams = { sessionId: "kept", participants: [], channels: {}, config: {
  version: 1, system: "Test system", model: { protocol: "scripted", script: new URL("./fixtures/crash-scenario.json", import.meta.url).pathname }, defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow", tools: {} } } } };
const push = (channel: string, id: string, text: string) => ({ channel, item: { id, kind: "user_message" as const, sender: channel, content: [{ type: "text" as const, text }] } });
function ended(client: HarnessClient, count: number) {
  const events: ChannelEvent[] = [];
  return { events, done: new Promise<void>(resolve => client.onChannelEvent(event => {
    events.push(event);
    if (events.filter(e => e.event.type === "turn_ended").length === count) resolve();
  })) };
}

for (const transport of ["in-process", "stdio"] as const) test(`${transport}: two channels survive a restart, load restores them, and new IDs do not collide`, async () => {
  // One durable location per transport: a home directory of SQLite files, or a
  // memory adapter that outlives the in-process server the way a file would.
  const home = mkdtempSync(join(root, "home-")), effects = join(home, "effects.log");
  const locations = new Map<string, SessionStorageAdapter>();
  const adapter = (id: string) => locations.get(id) ?? locations.set(id, createMemoryStorageAdapter()).get(id)!;
  const open = () => transport === "stdio" ? spawnHarness({ home, effects }) : createInProcessHarness({ adapter, effects });

  const first = open();
  try {
    const init = await first.client.initialize();
    expect(init.description.capabilities).toMatchObject({ acceptance: "durable", persistence: true });
    expect(init.description.capabilities.methods).toContain("session/load");
    await first.client.createSession(setup);
    const log = ended(first.client, 2);
    await Promise.all([first.client.push(push("a", "a1", "alpha question")), first.client.push(push("b", "b1", "beta question"))]);
    await log.done;
  } finally { await first.close(); }

  const second = open();
  try {
    await second.client.initialize();
    await expect(second.client.createSession(setup)).rejects.toMatchObject({ code: "already_exists" });
    await expect(second.client.loadSession({ sessionId: "absent", config: setup.config })).rejects.toMatchObject({ code: "not_found" });
    await expect(second.client.status()).rejects.toMatchObject({ code: "not_ready" });
    const loaded = await second.client.loadSession({ sessionId: "kept", config: setup.config });
    expect(loaded.status).toMatchObject({ sessionId: "kept", lifecycle: "running", execution: "idle",
      channels: [{ channel: "a", pending: [] }, { channel: "b", pending: [] }] });
    expect(loaded.turns).toMatchObject([{ turnId: "1", state: "completed" }, { turnId: "2", state: "completed" }]);
    expect(loaded.turns.map(turn => turn.items).flat().sort()).toEqual(["a1", "b1"]);
    expect(loaded.items.map(item => [item.id, item.milestone, item.kind])).toEqual([["a1", "seen", "participant_message"], ["b1", "seen", "participant_message"]]);
    expect(loaded.messages.map(message => message.parts[0]!.text).sort()).toEqual(["First reply.", "First reply.", "Recording.", "Recording."]);
    expect(await second.client.idle()).toEqual({ idle: true });
    // Deduplication and conflicts survive the restart.
    expect(await second.client.push(push("a", "a1", "alpha question"))).toMatchObject({ duplicate: true, item: { milestone: "seen" } });
    await expect(second.client.push(push("a", "a1", "different"))).rejects.toMatchObject({ code: "item_conflict" });
    await expect(second.client.push(push("b", "a1", "alpha question"))).rejects.toMatchObject({ code: "item_conflict" });

    const log = ended(second.client, 1);
    await second.client.push(push("a", "a2", "follow up"));
    await log.done;
    const started = log.events.find(event => event.event.type === "turn_started")!;
    expect(started.event).toMatchObject({ turnId: "3", items: ["a2"] });
    expect(started.revision).toBeGreaterThan(loaded.status.revision);
    // The script continued from where the first process left it.
    expect(log.events.flatMap(event => event.event.type === "message_completed" ? [event.event.parts[0]!.text] : [])).toEqual(["Second reply."]);
    const messageId = log.events.flatMap(event => event.event.type === "message_completed" ? [event.event.messageId!] : [])[0]!;
    expect(loaded.messages.map(message => message.messageId)).not.toContain(messageId);
    if ("models" in second) {
      // The next inference is built from both restored conversations.
      const request = JSON.stringify(second.models.get("a")!.requests()[0]!.messages);
      expect(request).toContain("alpha question"); expect(request).toContain("beta question"); expect(request).toContain("follow up");
    }

    // Paging stays anchored to the revision of the load it continues.
    const paged = await second.client.loadSession({ sessionId: "kept", config: setup.config, messagesLimit: 2 });
    expect(paged.messages).toHaveLength(2); expect(paged.nextMessage).toBe(paged.messages[1]!.messageId);
    const rest = await second.client.messages({ revision: loaded.status.revision, after: paged.nextMessage! });
    expect([...paged.messages, ...rest.messages]).toEqual(loaded.messages);
    expect(rest.nextMessage).toBeUndefined();
    const all = await second.client.messages({ revision: paged.status.revision, after: "0", limit: 1000 });
    expect(all.messages.at(-1)).toMatchObject({ messageId, turnId: "3" });
    await expect(second.client.messages({ revision: paged.status.revision + 1000, after: "0" })).rejects.toMatchObject({ code: "not_found" });
    await expect(second.client.loadSession({ sessionId: "other", config: setup.config })).rejects.toMatchObject({ code: "already_exists" });
  } finally { await second.close(); }
}, 15000);

test("a load during execution is one snapshot: earlier events precede the response and later events follow it", async () => {
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  const session = createSession({ systemPrompt: "test", configureTurn: () => ({ tools: [], executeTool: async () => "unused",
    model: async messages => { await gate; return { role: "assistant", content: lastInput(messages), calls: [] }; } }) });
  const transport = createInProcessTransport(createProtocolServer(async () => ({ session, close() {} }), { durable: true }));
  const wire = recordWire(transport) as any[];
  const client = new HarnessClient(transport);
  try {
    await client.initialize(); await client.createSession({ ...setup, sessionId: "memory" });
    const log = ended(client, 1);
    await client.push(push("a", "1", "first"));
    while (!wire.some(message => message.params?.event?.type === "turn_started")) await new Promise(resolve => setTimeout(resolve, 1));
    // Commit more work in the same tick the load is answered: it must not overtake the response.
    const loading = client.loadSession({ sessionId: "memory", config: setup.config });
    queueMicrotask(() => { session.agent.send({ channelId: "b", participantId: "bob", text: "racing", itemId: "2" }); release(); });
    const loaded = await loading;
    await log.done;
    await new Promise(resolve => setTimeout(resolve, 5));
    const at = wire.findIndex(message => message.result?.status);
    const revisions = (messages: any[]) => messages.flatMap(message => message.params?.revision === undefined ? [] : [message.params.revision]);
    expect(revisions(wire.slice(0, at)).every(revision => revision <= loaded.status.revision)).toBe(true);
    expect(revisions(wire.slice(at + 1)).length).toBeGreaterThan(2);
    expect(revisions(wire.slice(at + 1)).every(revision => revision > loaded.status.revision)).toBe(true);
    // The view itself is consistent with that revision: the running turn, nothing from later commits.
    expect(loaded.turns).toMatchObject([{ turnId: "1", state: "running", items: ["1"] }]);
    expect(loaded.status).toMatchObject({ execution: "working", channels: [{ channel: "a", activeTurn: { turnId: "1", state: "running" } }] });
    expect(loaded.messages).toEqual([]);
  } finally { release(); client.close(); }
});

test("load views that cannot fit one frame fail whole; message pages respect the frame and the revision", () => {
  const opened = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "big", compatibilityKey: "" } });
  if (!opened.ok) throw new Error(opened.error.message);
  const storage = opened.value, big = "x".repeat(300_000);
  storage.acceptItem({ kind: "participant_message", channelId: "a", senderId: "ana", text: "hi" });
  const turn = storage.beginTurn("a");
  if (!turn.ok || !turn.value) throw new Error("no turn");
  for (let i = 0; i < 5; i++) storage.appendMessage(turn.value.turn.turnId, { role: "assistant", content: `${i}${big}`, calls: [] });
  const view = () => { const read = storage.snapshot(); if (!read.ok) throw new Error(read.error.message); return read.value; };
  const first = loadView(sessionStatus(view(), false), view(), 100);
  // Three 300 KB messages fit beside the fixed part; the rest are paged.
  expect(first.messages.map(message => message.parts[0]!.text[0])).toEqual(["0", "1", "2"]);
  expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThan(1024 * 1024);
  const before = view().revision;
  storage.appendMessage(turn.value.turn.turnId, { role: "assistant", content: "later", calls: [] });
  const rest = pageMessages(view(), before, Number(first.nextMessage), 100);
  expect(rest.messages.map(message => message.parts[0]!.text[0])).toEqual(["3", "4"]);
  expect(rest.nextMessage).toBeUndefined();
  // One record larger than a frame cannot be delivered, but the history before it still can.
  storage.appendMessage(turn.value.turn.turnId, { role: "assistant", content: "y".repeat(1024 * 1024), calls: [] });
  const prefix = pageMessages(view(), view().revision, 0, 100);
  expect(prefix.messages.map(message => message.parts[0]!.text[0])).toEqual(["0", "1", "2"]);
  const middle = pageMessages(view(), view().revision, Number(prefix.nextMessage), 100);
  expect(middle.messages.map(message => message.parts[0]!.text)).toEqual([`3${big}`, `4${big}`, "later"]);
  // The page stops at the last record it could include; it does not skip the oversized one.
  expect(middle.nextMessage).toBe(middle.messages[2]!.messageId);
  expect(() => pageMessages(view(), view().revision, Number(middle.nextMessage), 100)).toThrow(FrameLimit);
  expect(loadView(sessionStatus(view(), false), view(), 100).messages).toEqual(prefix.messages);
  // Unpaged turns and items that outgrow a frame fail the load rather than truncating it.
  for (let i = 0; i < 4; i++) storage.acceptItem({ kind: "participant_message", channelId: "a", senderId: "ana", text: "t", itemId: `${i}${big}` });
  expect(() => loadView(sessionStatus(view(), false), view(), 100)).toThrow("turns and items do not fit");
});

test("a load that cannot be answered opens nothing and reports transfer_limit", async () => {
  const location = createMemoryStorageAdapter();
  const seeded = location.open({ mode: "create", identity: { sessionId: "big", compatibilityKey: "" } });
  if (!seeded.ok) throw new Error(seeded.error.message);
  for (let i = 0; i < 4; i++) seeded.value.acceptItem({ kind: "participant_message", channelId: "a", senderId: "ana", text: "t", itemId: `${i}${"x".repeat(300_000)}` });
  seeded.value.close();
  let ran = 0;
  const server = createProtocolServer(async ({ mode, sessionId }) => {
    const opened = location.open({ mode, identity: { sessionId, compatibilityKey: "" } });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = createSession({ systemPrompt: "test", storage: opened.value, configureTurn: () => ({ tools: [], executeTool: async () => "unused",
      model: async () => { ran++; return { role: "assistant", content: "ran", calls: [] }; } }) });
    return { session, close() { opened.value.close(); } };
  }, { durable: true });
  const client = new HarnessClient(createInProcessTransport(server));
  try {
    await client.initialize();
    await expect(client.loadSession({ sessionId: "big", config: setup.config })).rejects.toMatchObject({ code: "transfer_limit" });
    await new Promise(resolve => setTimeout(resolve, 10));
    // Pending input was not made eligible and ownership was released.
    expect(ran).toBe(0);
    await expect(client.status()).rejects.toMatchObject({ code: "not_ready" });
    expect(location.open({ mode: "open", identity: { sessionId: "big", compatibilityKey: "" } }).ok).toBe(true);
  } finally { client.close(); }
});

test("a message racing turn completion reaches exactly one turn at every interleaving", async () => {
  // Sweep the moment a second message is accepted across the whole life of a
  // turn that infers, runs a tool and infers again: before, between and after
  // each await, including the ticks around the finish decision.
  for (let delay = 0; delay < 40; delay++) {
    let inferences = 0;
    const session = createSession({ systemPrompt: "test", configureTurn: turn => ({ tools: [],
      executeTool: async () => { await null; await null; return "result"; },
      model: async messages => {
        inferences++;
        await null; await null;
        return turn.turnId === 1 && !messages.some(message => message.role === "tool")
          ? { role: "assistant", content: null, calls: [{ id: "t", name: "tool", arguments: "{}" }] }
          : { role: "assistant", content: `answered ${lastInput(messages)}`, calls: [] };
      } }) });
    session.start();
    session.agent.send({ channelId: "a", participantId: "ana", text: "first", itemId: "first" });
    for (let tick = 0; tick < delay; tick++) await null;
    expect(session.agent.send({ channelId: "a", participantId: "ana", text: "second", itemId: "second" })).toMatchObject({ accepted: true, duplicate: false });
    while (!session.agent.idle()) await new Promise(resolve => setTimeout(resolve, 0));
    const view = session.snapshot();
    // Every turn completed, each item is linked to one turn and has one timeline entry.
    expect(view.turns.every(turn => turn.state.status === "completed")).toBe(true);
    expect(view.turns.flatMap(turn => turn.itemIds).sort()).toEqual(["first", "second"]);
    expect(view.timeline.filter(entry => entry.itemId === "second")).toHaveLength(1);
    const second = view.items.find(item => item.itemId === "second")!;
    expect(second.milestone).toBe("seen");
    // It was answered by the turn that took it: an inference ran after its entry.
    const answer = view.timeline.findLast(entry => entry.turnId === second.turnId && entry.message.role === "assistant")!;
    expect(answer.seq).toBeGreaterThan(second.entrySeq!);
    expect(answer.message.content).toBe("answered second");
    // Joined the first turn or started a second one, never both; no inference went unrecorded.
    expect([1, 2]).toContain(view.turns.length);
    expect(inferences).toBe(view.timeline.filter(entry => entry.message.role === "assistant").length);
  }
});

test("both outcomes of the race occur across the sweep, and events name the turn that took each item", async () => {
  const shapes = new Set<string>();
  for (let delay = 0; delay < 40; delay++) {
    const session = createSession({ systemPrompt: "test", configureTurn: () => ({ tools: [], executeTool: async () => "unused",
      model: async messages => { await null; await null; return { role: "assistant", content: lastInput(messages), calls: [] }; } }) });
    session.start();
    const taken = new Map<string, string>();
    session.subscribe(({ event }) => {
      if (event.type !== "turn_started" && event.type !== "turn_took") return;
      for (const item of event.items) { expect(taken.has(item)).toBe(false); taken.set(item, event.turnId); }
    });
    session.agent.send({ channelId: "a", participantId: "ana", text: "first", itemId: "first" });
    for (let tick = 0; tick < delay; tick++) await null;
    session.agent.send({ channelId: "a", participantId: "ana", text: "second", itemId: "second" });
    while (!session.agent.idle()) await new Promise(resolve => setTimeout(resolve, 0));
    const view = session.snapshot();
    expect(taken.get("second")).toBe(String(view.items.find(item => item.itemId === "second")!.turnId));
    shapes.add(view.turns.length === 1 ? (view.timeline.filter(entry => entry.message.role === "assistant").length === 1 ? "same take" : "steered") : "next turn");
  }
  expect([...shapes].sort()).toEqual(["next turn", "same take", "steered"]);
});
