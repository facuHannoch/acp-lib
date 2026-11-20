import { expect, test } from "bun:test";
import { createSession } from "../src/index.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import type { ChannelEvent } from "../src/contracts/events.ts";
import type { PersistentSession } from "../src/contracts/session.ts";
import { lastInput } from "./helpers/session.ts";

/** Deterministic two-channel rig (decision 0014). The scripted model asks for the
 * `hold` tool whenever the newest input starts with "hold" and answers
 * "ok <input>" otherwise; a held tool returns only when the test releases it, and
 * deliberately ignores its abort signal, like a tool that returns late. */
function rig() {
  const adapter = createMemoryStorageAdapter();
  const holds = new Map<string, () => void>();
  const effects: string[] = [], requests: string[] = [];
  let created = false;
  const open = (key = "k") => {
    const opened = adapter.open({ mode: created ? "open" : "create", identity: { sessionId: "s", compatibilityKey: key } });
    if (!opened.ok) throw new Error(opened.error.message);
    created = true;
    const storage = opened.value;
    const session = createSession({ systemPrompt: "system", storage, configureTurn: turn => {
      let n = 0;
      return { tools: [], model: async messages => {
        const last = messages.at(-1)!, text = lastInput(messages);
        requests.push(`${turn.channelId}#${turn.turnId}:${last.role === "tool" ? "(tool result)" : text}`);
        if (last.role === "tool") return { role: "assistant", content: `finished ${turn.channelId}`, calls: [] };
        if (text.startsWith("hold")) return { role: "assistant", content: null, calls: [{ id: `h${turn.turnId}-${++n}`, name: "hold", arguments: "{}" }] };
        return { role: "assistant", content: `ok ${text}`, calls: [] };
      }, executeTool: async () => {
        effects.push(`start:${turn.channelId}#${turn.turnId}`);
        const key = `${turn.channelId}#${turn.turnId}`;
        await new Promise<void>(resolve => holds.set(key, resolve));
        holds.delete(key);
        effects.push(`done:${turn.channelId}#${turn.turnId}`);
        return "held";
      } };
    } });
    const events: ChannelEvent[] = [];
    session.subscribe(event => events.push(event));
    return { session, events, close() { session.stop("test"); const closed = storage.close(); if (!closed.ok) throw new Error(closed.error.message); } };
  };
  const keys = (channel: string) => [...holds.keys()].filter(key => key.startsWith(`${channel}#`));
  return { open, effects, requests, held: (channel: string) => keys(channel).length > 0,
    /** Release one turn's tool, or every held tool of the channel. */
    release: (channel: string, turnId?: number) => { for (const key of keys(channel)) if (turnId === undefined || key === `${channel}#${turnId}`) holds.get(key)!(); } };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${what}`);
}
const types = (events: ChannelEvent[], channel: string) => events.filter(event => event.channel === channel).map(event => event.event.type);
const send = (session: PersistentSession, channel: string, text: string, itemId?: string) =>
  session.agent.send({ channelId: channel, participantId: "ana", text, ...(itemId ? { itemId } : {}) });
const channel = (session: PersistentSession, id: string) => session.status().channels.find(c => c.channelId === id)!;
const ok = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const refused = (result: { ok: boolean; error?: { code: string } }, code: string) => expect(result.ok ? "ok" : result.error!.code).toBe(code);
const turnOf = (session: PersistentSession, turnId: number) => session.snapshot().turns.find(turn => turn.turnId === turnId)!;

test("Alice suspends while her tool runs; Bob continues; her backlog survives a reopen and is taken once on resume", async () => {
  const r = rig();
  const first = r.open(), { session } = first;
  session.start();
  send(session, "alice", "hold work", "a1");
  await until(() => r.held("alice"), "alice's tool");
  expect(send(session, "alice", "later", "a2")).toMatchObject({ accepted: true, milestone: "received" });

  const suspending = session.channels.suspend("alice");
  expect(channel(session, "alice")).toMatchObject({ lifecycle: "suspending", activeTurn: { turnId: 1, status: "running" }, waitingForResume: true });
  // Closed to new input and notices; a retry of accepted input still answers.
  expect(send(session, "alice", "too late")).toMatchObject({ accepted: false, code: "channel_suspended" });
  expect(session.agent.notify({ channelId: "alice", fromChannelId: "bob", text: "psst" })).toMatchObject({ accepted: false, code: "channel_suspended" });
  expect(send(session, "alice", "later", "a2")).toMatchObject({ accepted: true, duplicate: true, milestone: "received" });
  // Bob is not affected.
  send(session, "bob", "hello bob", "b1");
  await until(() => first.events.some(e => e.channel === "bob" && e.event.type === "turn_ended"), "bob's turn");
  expect(send(session, "bob", "again", "b2")).toMatchObject({ accepted: true });
  await until(() => first.events.filter(e => e.channel === "bob" && e.event.type === "turn_ended").length === 2, "bob's second turn");
  expect(channel(session, "alice").lifecycle).toBe("suspending"); // waits for the tool, does not cancel it
  r.release("alice");
  const done = ok(await suspending);
  expect(done).toMatchObject({ lifecycle: "suspended", activeTurn: { turnId: 1, status: "suspended" }, pendingItemIds: ["a2"], waitingForResume: true });
  expect(types(first.events, "alice")).toEqual(["turn_started", "items_receipt", "tool_call", "channel_state", "tool_call", "turn_suspended", "channel_state"]);
  // Pending work on a suspended channel is visible but is not execution.
  expect(session.status().execution).toBe("idle");
  expect(session.agent.idle()).toBe(true);

  first.close();
  const second = r.open(), again = second.session;
  again.start();
  send(again, "bob", "still here", "b3");
  await until(() => second.events.some(e => e.channel === "bob" && e.event.type === "turn_ended"), "bob after reopen");
  expect(channel(again, "alice")).toMatchObject({ lifecycle: "suspended", activeTurn: { turnId: 1, status: "suspended" }, pendingItemIds: ["a2"] });
  expect(types(second.events, "alice")).toEqual([]); // start() does not wake her
  expect(send(again, "alice", "x")).toMatchObject({ accepted: false, code: "channel_suspended" });

  ok(again.channels.resume("alice"));
  await until(() => second.events.some(e => e.channel === "alice" && e.event.type === "turn_ended"), "alice's resumed turn");
  expect(types(second.events, "alice").slice(0, 3)).toEqual(["channel_state", "turn_resumed", "turn_took"]);
  expect(r.effects.filter(line => line.startsWith("start:alice"))).toEqual(["start:alice#1"]); // the recorded tool did not run again
  expect(turnOf(again, 1)).toMatchObject({ state: { status: "completed" }, itemIds: ["a1", "a2"] });
  expect(again.snapshot().items.find(item => item.itemId === "a2")).toMatchObject({ turnId: 1 });
  expect(r.requests.filter(line => line.endsWith(":later"))).toEqual(["alice#1:later"]); // taken and shown to the model once
  second.session.stop("done");
});

test("interrupting one turn ends it at once; a late tool result and a stale interrupt cannot touch the next turn", async () => {
  const r = rig();
  const { session, events } = r.open();
  session.start();
  send(session, "alice", "hold first", "a1");
  send(session, "bob", "hello bob", "b1");
  await until(() => r.held("alice"), "alice's first tool");
  await until(() => events.some(e => e.channel === "bob" && e.event.type === "turn_ended"), "bob");
  send(session, "alice", "hold second", "a2"); // untaken: stays pending behind the running turn
  refused(session.channels.interrupt("bob", 1, "wrong channel"), "not_found");
  refused(session.channels.interrupt("alice", 99), "not_found");

  const first = ok(session.channels.interrupt("alice", 1, "no longer needed"));
  expect(first).toMatchObject({ interrupted: true, turn: { turnId: 1, state: { status: "interrupted", reason: "no longer needed", uncertainCallIds: ["h1-1"] } } });
  // The pending input starts the next turn without waiting for the old tool.
  await until(() => channel(session, "alice").activeTurn?.turnId === 3 && r.effects.includes("start:alice#3"), "the next turn's tool");
  const interrupted = events.find(e => e.channel === "alice" && e.event.type === "turn_ended")!.event;
  expect(interrupted).toMatchObject({ outcome: "interrupted", error: "no longer needed", uncertainCalls: ["h1-1"] });
  // The old tool returns late: nothing is recorded for turn 1 and turn 3 is unaffected.
  const before = session.snapshot().timeline.length;
  r.release("alice", 1);
  await until(() => r.effects.includes("done:alice#1"), "the old tool to return late");
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(channel(session, "alice").activeTurn).toEqual({ turnId: 3, status: "running" }); // still waiting on its own tool
  r.release("alice", 3);
  await until(() => r.effects.includes("done:alice#3"), "the second tool to finish");
  expect(session.snapshot().timeline.filter(entry => entry.turnId === 1 && entry.message.role === "tool")).toEqual([]);
  expect(turnOf(session, 1).state).toMatchObject({ status: "interrupted", uncertainCallIds: ["h1-1"] });
  expect(session.snapshot().timeline.length).toBeGreaterThanOrEqual(before);
  await until(() => turnOf(session, 3).state.status === "completed", "turn 3 to complete");
  // Retrying the old interrupt leaves later turns alone.
  expect(ok(session.channels.interrupt("alice", 1, "retry"))).toMatchObject({ interrupted: false, turn: { turnId: 1, state: { status: "interrupted" } } });
  expect(turnOf(session, 3).state.status).toBe("completed");
  expect(turnOf(session, 3).itemIds).toEqual(["a2"]);
  session.stop("done");
});

test("a stale interrupt sent while the next turn is running leaves that turn running", async () => {
  const r = rig();
  const { session } = r.open();
  session.start();
  send(session, "alice", "hold one", "a1");
  await until(() => r.held("alice"), "first tool");
  send(session, "alice", "hold two", "a2");
  ok(session.channels.interrupt("alice", 1));
  await until(() => r.effects.includes("start:alice#2"), "the second turn's tool");
  expect(ok(session.channels.interrupt("alice", 1))).toMatchObject({ interrupted: false });
  expect(turnOf(session, 2).state.status).toBe("running");
  expect(channel(session, "alice").activeTurn).toEqual({ turnId: 2, status: "running" });
  r.release("alice");
  await until(() => turnOf(session, 2).state.status === "completed", "turn 2");
  expect(turnOf(session, 1).state).toMatchObject({ status: "interrupted", reason: "interrupted by request" });
  session.stop("done");
});

test("interrupt and checkpoint race during a channel suspension: the first commit wins", async () => {
  // Interrupt first: suspended without a checkpoint, backlog kept, late result fenced.
  const a = rig(), one = a.open();
  one.session.start();
  send(one.session, "alice", "hold it", "a1"); await until(() => a.held("alice"), "tool");
  send(one.session, "alice", "after", "a2");
  const suspending = one.session.channels.suspend("alice");
  expect(ok(one.session.channels.interrupt("alice", 1, "cut"))).toMatchObject({ interrupted: true });
  expect(ok(await suspending)).toMatchObject({ lifecycle: "suspended", pendingItemIds: ["a2"] });
  expect(channel(one.session, "alice").activeTurn).toBeUndefined();
  a.release("alice");
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(turnOf(one.session, 1).state.status).toBe("interrupted");
  expect(one.session.snapshot().timeline.some(entry => entry.turnId === 1 && entry.message.role === "tool")).toBe(false);
  expect(types(one.events, "alice").filter(t => t === "turn_suspended")).toEqual([]);
  ok(one.session.channels.resume("alice")); // the backlog starts a fresh turn
  await until(() => turnOf(one.session, 2)?.state.status === "completed", "the backlog turn");
  one.session.stop("done");

  // Checkpoint first: the interrupt reports it did not interrupt a turn and the checkpoint stays.
  const b = rig(), two = b.open();
  two.session.start();
  send(two.session, "alice", "hold it", "a1"); await until(() => b.held("alice"), "tool");
  const second = two.session.channels.suspend("alice");
  b.release("alice");
  expect(ok(await second)).toMatchObject({ lifecycle: "suspended", activeTurn: { turnId: 1, status: "suspended" } });
  expect(ok(two.session.channels.interrupt("alice", 1, "too late"))).toMatchObject({ interrupted: false, turn: { state: { status: "suspended" } } });
  expect(channel(two.session, "alice").activeTurn).toEqual({ turnId: 1, status: "suspended" });
  two.session.stop("done");
});

test("session suspend and resume keep Alice individually suspended; her resume during session suspension starts nothing", async () => {
  const r = rig(), { session, events } = r.open();
  session.start();
  send(session, "alice", "hold work", "a1"); await until(() => r.held("alice"), "tool");
  send(session, "alice", "queued", "a2");
  const alice = session.channels.suspend("alice"); r.release("alice"); ok(await alice);
  send(session, "bob", "hi", "b1"); await until(() => events.some(e => e.channel === "bob" && e.event.type === "turn_ended"), "bob");

  expect((await session.suspend()).ok).toBe(true);
  expect(session.status()).toMatchObject({ lifecycle: "suspended", execution: "suspended" });
  expect(session.resume().ok).toBe(true);
  expect(session.status().lifecycle).toBe("running");
  expect(channel(session, "alice")).toMatchObject({ lifecycle: "suspended", activeTurn: { turnId: 1, status: "suspended" }, pendingItemIds: ["a2"] });
  expect(types(events, "alice")).not.toContain("turn_resumed");
  expect(session.status().execution).toBe("idle"); // her backlog is not execution

  // Resume her channel while the session is suspended: checkpoint preserved, no work.
  expect((await session.suspend()).ok).toBe(true);
  const resumed = ok(session.channels.resume("alice"));
  expect(resumed).toMatchObject({ lifecycle: "open", activeTurn: { turnId: 1, status: "suspended" }, pendingItemIds: ["a2"], waitingForResume: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(types(events, "alice")).not.toContain("turn_resumed");
  expect(turnOf(session, 1).state.status).toBe("suspended");
  expect(send(session, "alice", "x")).toMatchObject({ accepted: false, code: "not_running" });
  // Session resume continues it, and the pending input is taken once.
  expect(session.resume().ok).toBe(true);
  await until(() => turnOf(session, 1).state.status === "completed", "the resumed turn");
  expect(turnOf(session, 1).itemIds).toEqual(["a1", "a2"]);
  expect(r.effects.filter(line => line.startsWith("start:alice"))).toEqual(["start:alice#1"]);
  session.stop("done");
});

test("withdraw competes with take: a withdrawn input never reaches a model, a taken one names its turn", async () => {
  const r = rig(), { session, events } = r.open();
  session.start();
  send(session, "alice", "hold work", "a1"); await until(() => r.held("alice"), "tool");
  send(session, "alice", "withdraw me", "w"); send(session, "alice", "take me", "t");
  expect(ok(session.channels.withdraw("alice", "w"))).toMatchObject({ outcome: "withdrawn", repeated: false });
  expect(types(events, "alice")).toContain("item_withdrawn");
  expect(ok(session.channels.withdraw("alice", "w"))).toMatchObject({ outcome: "withdrawn", repeated: true });
  expect(send(session, "alice", "withdraw me", "w")).toMatchObject({ accepted: true, duplicate: true, milestone: "withdrawn" });
  expect(channel(session, "alice").pendingItemIds).toEqual(["t"]);
  r.release("alice");
  await until(() => turnOf(session, 1).state.status === "completed", "turn");
  expect(ok(session.channels.withdraw("alice", "t"))).toMatchObject({ outcome: "taken", turnId: 1 });
  expect(r.requests.some(line => line.includes("withdraw me"))).toBe(false);
  expect(session.snapshot().timeline.some(entry => entry.itemId === "w")).toBe(false);
  expect(session.snapshot().turns).toHaveLength(1);
  session.stop("done");
});

test("create, edit, suspend and delete are channel-local; a retired ID stays retired across a reopen", async () => {
  const r = rig(), first = r.open(), { session } = first;
  session.start();
  expect(ok(session.channels.create({ channelId: "carol", displayName: "Carol" }))).toMatchObject({ created: true, channel: { lifecycle: "open", displayName: "Carol" } });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(session.snapshot().turns).toEqual([]); // creating starts no work
  expect(ok(session.channels.edit("carol", "Caroline"))).toMatchObject({ displayName: "Caroline", lifecycle: "open" });
  expect(ok(await session.channels.suspend("carol"))).toMatchObject({ lifecycle: "suspended" }); // idle: at once
  expect(ok(await session.channels.suspend("carol"))).toMatchObject({ lifecycle: "suspended" });
  expect(send(session, "carol", "hi")).toMatchObject({ accepted: false, code: "channel_suspended" });
  ok(session.channels.resume("carol"));
  send(session, "carol", "hello", "c1");
  await until(() => turnOf(session, 1)?.state.status === "completed", "carol's turn");
  send(session, "dave", "hold", "d1"); await until(() => r.held("dave"), "dave's tool");
  send(session, "dave", "queued", "d2");
  refused(session.channels.delete("dave"), "channel_busy");
  r.release("dave"); await until(() => turnOf(session, 2).state.status === "completed", "dave");
  expect(ok(session.channels.delete("carol"))).toMatchObject({ lifecycle: "retired" });
  expect(send(session, "carol", "again")).toMatchObject({ accepted: false, code: "channel_retired" });
  expect(session.agent.notify({ channelId: "carol", fromChannelId: "dave", text: "n" })).toMatchObject({ accepted: false, code: "channel_retired" });
  refused(session.channels.create({ channelId: "carol" }), "channel_retired");
  expect(session.snapshot().timeline.some(entry => entry.channelId === "carol")).toBe(true);
  first.close();
  const second = r.open();
  expect(channel(second.session, "carol").lifecycle).toBe("retired");
  expect(send(second.session, "carol", "once more")).toMatchObject({ accepted: false, code: "channel_retired" });
  second.session.stop("done");
});

test("stop during a channel suspension returns it to open and keeps another channel's committed checkpoint", async () => {
  const r = rig(), first = r.open(), { session } = first;
  session.start();
  send(session, "alice", "hold a", "a1"); send(session, "bob", "hold b", "b1");
  await until(() => r.held("alice") && r.held("bob"), "both tools");
  const alice = session.channels.suspend("alice"); r.release("alice"); ok(await alice);
  const bob = session.channels.suspend("bob");
  expect(channel(session, "bob").lifecycle).toBe("suspending");
  session.stop("stop");
  expect(refusedStopped(await bob)).toBe("stopped");
  expect(channel(session, "alice")).toMatchObject({ lifecycle: "suspended", activeTurn: { turnId: 1, status: "suspended" } });
  expect(channel(session, "bob")).toMatchObject({ lifecycle: "open", unresolvedInterruption: { status: "interrupted" } });
  r.release("bob");
  first.close();
  const second = r.open();
  expect(channel(second.session, "alice")).toMatchObject({ lifecycle: "suspended", activeTurn: { turnId: 1, status: "suspended" } });
  second.session.stop("done");
});
const refusedStopped = (result: { ok: boolean; error?: { code: string } }) => result.ok ? "ok" : result.error!.code;

test("resuming a checkpoint before start() runs only that turn; other channels wait for start()", async () => {
  const r = rig(), first = r.open();
  first.session.start();
  send(first.session, "alice", "hold work", "a1"); await until(() => r.held("alice"), "tool");
  const suspended = first.session.channels.suspend("alice"); r.release("alice"); ok(await suspended);
  first.close();

  const second = r.open(), { session, events } = second;
  // Not started: input is accepted durably and nothing begins.
  expect(send(session, "bob", "bob first", "b1")).toMatchObject({ accepted: true });
  ok(session.channels.resume("alice"));
  await until(() => turnOf(session, 1).state.status === "completed", "alice's attached checkpoint turn");
  expect(send(session, "bob", "bob second", "b2")).toMatchObject({ accepted: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(types(events, "bob")).toEqual([]);
  expect(channel(session, "bob").pendingItemIds).toEqual(["b1", "b2"]);
  expect(session.status().execution).toBe("working"); // bob has pending input on an open channel; idle() is true only because nothing may start before start()
  expect(r.requests.some(line => line.startsWith("bob#"))).toBe(false);

  session.start();
  await until(() => events.some(e => e.channel === "bob" && e.event.type === "turn_ended"), "bob after start");
  expect(turnOf(session, 2)).toMatchObject({ channelId: "bob", itemIds: ["b1", "b2"], state: { status: "completed" } });
  expect(r.requests.filter(line => line.startsWith("bob#"))).toHaveLength(1);
  expect(session.agent.idle()).toBe(true);
  session.stop("done");
});
