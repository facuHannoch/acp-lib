import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createSession } from "../src/index.ts";
import { sendLocal, serveLocal } from "../src/interfaces/protocol/local.ts";
import { ask, lastInput, turnsEnd } from "./helpers/session.ts";

test("channels run concurrently; a message for a busy channel joins its turn at the next inference", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  const session = createSession({ systemPrompt: "test", configureTurn: () => ({ tools: [], executeTool: async () => "unused",
    model: async messages => {
      const text = lastInput(messages); started.push(text);
      if (text === "hold") await gate;
      return { role: "assistant", content: text, calls: [] };
    } }) });
  session.start();
  const log = turnsEnd(session, 2);
  const first = session.agent.send({ channelId: "a", participantId: "alice", text: "hold", itemId: "hold" });
  while (!started.length) await new Promise(resolve => setTimeout(resolve, 1));
  const second = session.agent.send({ channelId: "a", participantId: "bob", text: "next", itemId: "next" });
  // Acceptance is immediate and says nothing about a reply.
  expect(first).toEqual({ accepted: true, itemId: "hold", duplicate: false, milestone: "received" });
  expect(second).toMatchObject({ accepted: true, milestone: "received" });
  try {
    expect(await ask(session, { channelId: "b", participantId: "bob", text: "independent" })).toBe("independent");
    expect(started).toEqual(["hold", "independent"]);
    expect(session.agent.idle()).toBe(false);
  } finally { release(); }
  const events = await log.done;
  expect(started).toEqual(["hold", "independent", "next"]);
  // Both inputs for channel a share one turn and one outcome.
  const a = events.filter(e => e.channel === "a").map(e => e.event);
  expect(a.map(e => e.type)).toEqual(["turn_started", "items_receipt", "message_completed", "turn_took", "items_receipt", "message_completed", "turn_ended"]);
  expect(a[0]).toMatchObject({ items: ["hold"] }); expect(a[3]).toMatchObject({ items: ["next"] });
  expect(new Set(a.map(e => e.turnId)).size).toBe(1);
  expect(session.snapshot().turns.find(turn => turn.channelId === "a")).toMatchObject({ itemIds: ["hold", "next"], state: { status: "completed" } });
  expect(session.store.snapshot().filter((e) => e.channelId === "a").map((e) => e.message.content?.split("\n\n").at(-1))).toEqual(["hold", "hold", "next", "next"]);
  expect(session.agent.idle()).toBe(true);
  // A retry after completion reports where the original ended up.
  expect(session.agent.send({ channelId: "a", participantId: "alice", text: "hold", itemId: "hold" })).toMatchObject({ duplicate: true, milestone: "seen", turnId: 1 });
  expect(session.agent.send({ channelId: "a", participantId: "alice", text: "changed", itemId: "hold" })).toMatchObject({ accepted: false, code: "item_conflict" });
});

test("a failed turn ends by itself: its channel and other channels keep working", async () => {
  let calls = 0;
  const session = createSession({ systemPrompt: "test", configureTurn: turn => ({ tools: [], executeTool: async () => "unused",
    model: async () => {
      if (turn.channelId === "a" && ++calls === 1) throw new Error("model failed");
      return { role: "assistant", content: "ok", calls: [] };
    } }) });
  session.start();
  await expect(ask(session, { channelId: "a", participantId: "alice", text: "first" })).rejects.toThrow("model failed");
  expect(session.status().channels[0]).toMatchObject({ channelId: "a", unresolvedInterruption: { turnId: 1, status: "failed" } });
  expect(await ask(session, { channelId: "a", participantId: "alice", text: "second" })).toBe("ok");
  expect(await ask(session, { channelId: "b", participantId: "bob", text: "hello" })).toBe("ok");
  expect(session.snapshot().turns.map(turn => turn.state.status)).toEqual(["failed", "completed", "completed"]);
  // A provider failure is not evidence of delivery.
  expect(session.snapshot().items.map(item => item.milestone)).toEqual(["taken", "seen", "seen"]);
  expect(session.status()).toMatchObject({ execution: "idle" });
  expect(session.status().channels[0]!.unresolvedInterruption).toBeUndefined();
});

test("nothing executes before start, and invalid input is refused without a record", async () => {
  const session = createSession({ systemPrompt: "test", configureTurn: () => ({ tools: [], executeTool: async () => "unused",
    model: async () => ({ role: "assistant", content: "ran", calls: [] }) }) });
  expect(session.agent.send({ channelId: "a", participantId: "alice", text: " " })).toMatchObject({ accepted: false, code: "invalid_input" });
  expect(session.agent.notify({ channelId: "a", fromChannelId: "b", text: "hi" })).toMatchObject({ accepted: false, code: "not_found" });
  expect(session.agent.send({ channelId: "a", participantId: "alice", text: "wait", itemId: "w" })).toMatchObject({ accepted: true });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(session.status()).toMatchObject({ execution: "working", channels: [{ channelId: "a", pendingItemIds: ["w"] }] });
  expect(session.store.snapshot()).toEqual([]);
  const log = turnsEnd(session);
  session.start(); session.start();
  await log.done;
  expect(session.snapshot().turns).toHaveLength(1);
});

test("Unix HTTP clients reconnect to channel state and malformed input is rejected", async () => {
  const directory = await mkdtemp("/tmp/harness-test-");
  const socket = `${directory}/agent.sock`;
  const session = createSession({ systemPrompt: "test", configureTurn: turn => ({ tools: [], executeTool: async () => "unused",
    model: async () => ({ role: "assistant", calls: [], content: session.store.snapshot()
      .filter((e) => e.channelId === turn.channelId && e.message.role === "user")
      .map((e) => `${e.from}:${e.message.content?.split("\n\n")[1]}`).join("|") }) }) });
  session.start();
  const server = serveLocal(session, socket);
  try {
    expect(await sendLocal(socket, { channelId: "a", participantId: "alice", text: "one" })).toBe("alice:one");
    expect(await sendLocal(socket, { channelId: "a", participantId: "bob", text: "two" })).toBe("alice:one|bob:two");
    expect(await sendLocal(socket, { channelId: "b", participantId: "bob", text: "three" })).toBe("bob:three");
    const invalid = await fetch("http://localhost/messages", { unix: socket, method: "POST", body: "{}" });
    expect(invalid.status).toBe(400);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("local requests whose inputs share a turn all resolve with that turn's reply; a failed turn reports its error", async () => {
  const directory = await mkdtemp("/tmp/harness-test-");
  const socket = `${directory}/agent.sock`;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const session = createSession({ systemPrompt: "test", configureTurn: () => ({ tools: [], executeTool: async () => "unused",
    model: async messages => {
      const text = lastInput(messages);
      if (text === "fail") throw new Error("provider down");
      if (++calls === 1) await gate;
      return { role: "assistant", content: `reply to ${text}`, calls: [] };
    } }) });
  session.start();
  const server = serveLocal(session, socket);
  try {
    const first = sendLocal(socket, { channelId: "a", participantId: "alice", text: "one" });
    while (!session.snapshot().turns.length) await new Promise(resolve => setTimeout(resolve, 5));
    const second = sendLocal(socket, { channelId: "a", participantId: "bob", text: "two" });
    while (session.snapshot().items.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
    release();
    expect(await Promise.all([first, second])).toEqual(["reply to two", "reply to two"]);
    expect(session.snapshot().turns).toHaveLength(1);
    await expect(sendLocal(socket, { channelId: "a", participantId: "alice", text: "fail" })).rejects.toThrow("provider down");
    expect(await sendLocal(socket, { channelId: "a", participantId: "alice", text: "again" })).toBe("reply to again");
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
