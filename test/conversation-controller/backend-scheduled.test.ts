/**
 * A backend-scheduled controller (controller-interface spec, The interface: `send`, `turn_took`; Brief B2
 * step 5b), against the core-only fake: the session hands each message over with `send` (no turn id, no
 * combining, no cancel-to-steer), the queue operation ends when `send` resolves, and the message's promise
 * settles with the turn that takes it (named by its cause, extended by `turn_took`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession } from "../../src/agent-session.ts";
import type { ConversationController } from "../../src/conversation-controller/index.ts";
import { FakeController } from "./fake-controller.ts";

const ECHO = resolve(import.meta.dir, "../fixtures/echo-prompt-agent.ts");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean().catch(() => undefined);
});

type Seen = { kind: string; [key: string]: any };

async function sessionWith(fake: FakeController) {
  const directory = await mkdtemp(join(tmpdir(), "acp-backend-scheduled-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const session = await AgentSession.create({
    adapter: { command: ["bun", ECHO] },
    adapterId: "fixture",
    agentSessionId: `backend-scheduled-${Math.random().toString(36).slice(2)}`,
    cwd: directory,
    metering: { pricing: false },
  });
  cleanups.push(() => session.stop());
  const internals = session as unknown as { controller: ConversationController; bindController(controller: ConversationController): void };
  const real = internals.controller;
  internals.controller = fake;
  internals.bindController(fake);
  cleanups.push(() => real.stop());
  const events: Seen[] = [];
  session.subscribe(({ event }) => { events.push(event as Seen); });
  return { session, events };
}

const until = async (predicate: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition timed out");
    await Bun.sleep(5);
  }
};

/** Tracks whether a promise has settled, without awaiting it. */
const track = <T>(promise: Promise<T>) => {
  const state = { settled: false, value: undefined as T | undefined, error: undefined as unknown };
  promise.then((value) => { state.settled = true; state.value = value; }, (error) => { state.settled = true; state.error = error; });
  return state;
};

describe("sending to a backend-scheduled controller", () => {
  test("a run carries the message id and kind but no turn id; the controller is told it's backend-scheduled", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    expect(session.conversationCapabilities.nativeSteering).toBe(true);
    const handle = session.prompt("hello");
    await until(() => fake.sent.length === 1);
    expect(fake.sent[0]).toEqual({ messageIds: [handle.id], operationKind: "prompt" });
    expect("turnId" in fake.sent[0]!).toBe(false);
  }, 20_000);

  test("the queue operation ends at acceptance: the next message is sent before any turn exists", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session, events } = await sessionWith(fake);
    const first = session.prompt("one");
    const second = session.prompt({ text: "two", delivery: "queue" });
    await until(() => fake.sent.length === 2);
    expect(fake.sent.map((run) => run.messageIds)).toEqual([[first.id], [second.id]]);
    expect(events.some((event) => event.kind === "turn_started")).toBe(false); // no turn yet: the backend decides when
    expect(session.state.operation).toBeNull(); // nothing runs in the session's queue while the messages wait
  }, 20_000);

  test("queued steer messages are never combined, and nothing cancels to steer", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    let accept!: () => void;
    fake.acceptGate = new Promise<void>((resolve) => { accept = resolve; });
    const { session } = await sessionWith(fake);
    const first = session.prompt("one");
    await until(() => fake.sent.length === 1); // the first is being accepted; the next two queue behind it
    const second = session.prompt({ text: "two", delivery: "steer" });
    const third = session.prompt({ text: "three", delivery: "steer" });
    accept();
    await until(() => fake.sent.length === 3);
    expect(fake.sent.map((run) => run.messageIds)).toEqual([[first.id], [second.id], [third.id]]); // one run each, in order
  }, 20_000);

  test("a message settles with the turn that takes it: its finalized result, the backend's own turn id", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session, events } = await sessionWith(fake);
    const handle = session.prompt("hello");
    const outcome = track(handle);
    await until(() => fake.sent.length === 1);
    expect(outcome.settled).toBe(false); // accepted, but no turn has taken it yet
    const turnId = fake.startTurn({ chunks: ["the reply"] }, { kind: "messages", messageIds: [handle.id] });
    const result = await handle;
    expect(result.status).toBe("completed");
    expect(result.messages.map((message) => message.text)).toEqual(["the reply"]);
    expect(result.operationId).toBe(turnId);
    expect(turnId).not.toBe(handle.id);
    const started = events.find((event) => event.kind === "turn_started")!;
    expect(started).toMatchObject({ turnId, cause: { kind: "messages", messageIds: [handle.id] } });
    expect(events.find((event) => event.kind === "turn_completed")!.result.operationId).toBe(turnId);
  }, 20_000);

  test("turn_took: a message folded into a running turn settles with that turn's result", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const first = session.prompt("one");
    await until(() => fake.sent.length === 1);
    const turnId = fake.startTurn({ chunks: ["both answered"], hold }, { kind: "messages", messageIds: [first.id] });
    await until(() => fake.prompted.includes(turnId)); // running
    const second = session.prompt({ text: "two", delivery: "steer" });
    await until(() => fake.sent.length === 2);
    fake.foldInto(turnId, { kind: "messages", messageIds: [second.id] });
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.operationId).toBe(turnId);
    expect(two.operationId).toBe(turnId);
    expect(two.messages.map((message) => message.text)).toEqual(["both answered"]);
  }, 20_000);

  test("a queue-delivery message sent while a backend turn runs waits behind it (only steer goes in at once)", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const first = session.prompt("one");
    await until(() => fake.sent.length === 1);
    const turnId = fake.startTurn({ chunks: ["A"], hold }, { kind: "messages", messageIds: [first.id] });
    await until(() => fake.prompted.includes(turnId));
    const queued = session.prompt({ text: "later", delivery: "queue" });
    const sentWhileRunning = fake.sent.length;
    release();
    await first;
    await until(() => fake.sent.length === 2); // sent once the running turn has ended
    expect(sentWhileRunning).toBe(1);
    expect(fake.sent[1]!.messageIds).toEqual([queued.id]);
  }, 20_000);

  test("turn_took before the turn runs (while it waits behind other work) also counts", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const a = session.prompt("a");
    await until(() => fake.sent.length === 1);
    const running = fake.startTurn({ chunks: ["A"], hold }, { kind: "messages", messageIds: [a.id] });
    await until(() => fake.prompted.includes(running));
    const b = session.prompt("b");
    const c = session.prompt("c");
    await until(() => fake.sent.length === 3);
    const waiting = fake.startTurn({ chunks: ["B and C"] }, { kind: "messages", messageIds: [b.id] }); // queued behind the running turn
    fake.foldInto(waiting, { kind: "messages", messageIds: [c.id] });
    release();
    const [, two, three] = await Promise.all([a, b, c]);
    expect(two.operationId).toBe(waiting);
    expect(three.operationId).toBe(waiting);
  }, 20_000);

  test("turn_took for a turn the session doesn't know, or that has ended, is ignored and settles nothing", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    const first = session.prompt("one");
    await until(() => fake.sent.length === 1);
    const turnId = fake.startTurn({ chunks: ["done"] }, { kind: "messages", messageIds: [first.id] });
    await first; // the turn has ended
    const second = session.prompt("two");
    const outcome = track(second);
    await until(() => fake.sent.length === 2);
    fake.foldInto(turnId, { kind: "messages", messageIds: [second.id] }); // ended turn
    fake.foldInto("never-reported", { kind: "messages", messageIds: [second.id] }); // unknown turn
    // A later valid turn settles its own message; had the ignored reports settled `second`, it would be done by now.
    const third = session.prompt("three");
    await until(() => fake.sent.length === 3);
    fake.startTurn({ chunks: ["third"] }, { kind: "messages", messageIds: [third.id] });
    await third;
    expect(outcome.settled).toBe(false);
  }, 20_000);

  test("a failing turn rejects the messages it took, after turn_failed", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session, events } = await sessionWith(fake);
    const handle = session.prompt("will fail");
    const outcome = track(handle);
    await until(() => fake.sent.length === 1);
    fake.startTurn({ fail: new Error("backend failed") }, { kind: "messages", messageIds: [handle.id] });
    await until(() => outcome.settled);
    expect(String(outcome.error)).toContain("backend failed");
    expect(events.some((event) => event.kind === "turn_failed")).toBe(true);
  }, 20_000);

  test("a cause naming an id the session never sent is recorded but not trusted: nothing else settles", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session, events } = await sessionWith(fake);
    const mine = session.prompt("mine");
    const outcome = track(mine);
    await until(() => fake.sent.length === 1);
    fake.startTurn({ chunks: ["theirs"] }, { kind: "messages", messageIds: ["not-mine"] });
    await until(() => events.some((event) => event.kind === "turn_completed"));
    expect(outcome.settled).toBe(false); // the turn ran, but it did not take my message
  }, 20_000);

  test("a message the backend refuses rejects with that error and the queue goes on", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    fake.rejectNextSend = new Error("backend refused");
    await expect(session.prompt("refused")).rejects.toThrow("backend refused");
    const next = session.prompt("accepted");
    await until(() => fake.sent.length === 2);
    fake.startTurn({ chunks: ["ok"] }, { kind: "messages", messageIds: [fake.sent[1]!.messageIds[0]!] });
    expect((await next).status).toBe("completed");
  }, 20_000);

  test("stop while messages wait for their turn: they resolve as cancelled and stop doesn't hang", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    const handle = session.prompt("never taken");
    await until(() => fake.sent.length === 1);
    await session.stop();
    const result = await handle;
    expect(result.status).toBe("cancelled");
    expect(result.metering).toBeNull(); // nothing ran
  }, 20_000);
});

describe("a session-scheduled controller is unchanged", () => {
  test("steer messages are still combined into one run, with a turn id", async () => {
    const fake = new FakeController({ scheduling: "session" });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    fake.sendScript = (run) => (run.messageIds.length === 1 && fake.sent.length === 1 ? { chunks: ["first"], hold } : { chunks: ["combined"] });
    const { session } = await sessionWith(fake);
    const first = session.prompt("one");
    await until(() => fake.sent.length === 1);
    const second = session.prompt({ text: "two", delivery: "steer" });
    const third = session.prompt({ text: "three", delivery: "steer" });
    release();
    await Promise.all([first, second, third]);
    expect(fake.sent[0]!.turnId).toBe(first.id);
    expect(fake.sent.some((run) => run.messageIds.length === 2 && run.messageIds[0] === second.id && run.messageIds[1] === third.id)).toBe(true);
  }, 20_000);
});
