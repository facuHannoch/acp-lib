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

const until = async (predicate: () => boolean, ms = 15_000) => {
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
    expect(fake.sent[0]).toMatchObject({ messageIds: [handle.id], operationKind: "prompt" });
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
    const turnId = fake.startTurn({ chunks: ["the reply"] }, { messageIds: [handle.id] });
    const result = await handle;
    expect(result.status).toBe("completed");
    expect(result.messages.map((message) => message.text)).toEqual(["the reply"]);
    expect(result.operationId).toBe(turnId);
    expect(turnId).not.toBe(handle.id);
    const started = events.find((event) => event.kind === "turn_started")!;
    expect(started).toMatchObject({ turnId, cause: { messageIds: [handle.id] } });
    expect(events.find((event) => event.kind === "turn_completed")!.result.operationId).toBe(turnId);
  }, 20_000);

  test("turn_took: a message folded into a running turn settles with that turn's result", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const first = session.prompt("one");
    await until(() => fake.sent.length === 1);
    const turnId = fake.startTurn({ chunks: ["both answered"], hold }, { messageIds: [first.id] });
    await until(() => fake.prompted.includes(turnId)); // running
    const second = session.prompt({ text: "two", delivery: "steer" });
    await until(() => fake.sent.length === 2);
    fake.foldInto(turnId, { messageIds: [second.id] });
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
    const turnId = fake.startTurn({ chunks: ["A"], hold }, { messageIds: [first.id] });
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
    const running = fake.startTurn({ chunks: ["A"], hold }, { messageIds: [a.id] });
    await until(() => fake.prompted.includes(running));
    const b = session.prompt("b");
    const c = session.prompt("c");
    await until(() => fake.sent.length === 3);
    const waiting = fake.startTurn({ chunks: ["B and C"] }, { messageIds: [b.id] }); // queued behind the running turn
    fake.foldInto(waiting, { messageIds: [c.id] });
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
    const turnId = fake.startTurn({ chunks: ["done"] }, { messageIds: [first.id] });
    await first; // the turn has ended
    const second = session.prompt("two");
    const outcome = track(second);
    await until(() => fake.sent.length === 2);
    fake.foldInto(turnId, { messageIds: [second.id] }); // ended turn
    fake.foldInto("never-reported", { messageIds: [second.id] }); // unknown turn
    // A later valid turn settles its own message; had the ignored reports settled `second`, it would be done by now.
    const third = session.prompt("three");
    await until(() => fake.sent.length === 3);
    fake.startTurn({ chunks: ["third"] }, { messageIds: [third.id] });
    await third;
    expect(outcome.settled).toBe(false);
  }, 20_000);

  test("a failing turn rejects the messages it took, after turn_failed", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session, events } = await sessionWith(fake);
    const handle = session.prompt("will fail");
    const outcome = track(handle);
    await until(() => fake.sent.length === 1);
    fake.startTurn({ fail: new Error("backend failed") }, { messageIds: [handle.id] });
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
    fake.startTurn({ chunks: ["theirs"] }, { messageIds: ["not-mine"] });
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
    fake.startTurn({ chunks: ["ok"] }, { messageIds: [fake.sent[1]!.messageIds[0]!] });
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

// ---------------------------------------------------------------------------------------------
// Owner decisions of 2026-11-15 (spec questions 1–3): the run carries the messages, a cause can hold
// messages and items together, and the wait after acceptance is cancellable.
// ---------------------------------------------------------------------------------------------

describe("the run carries the messages themselves", () => {
  test("a backend-scheduled controller receives what the user wrote: text, attachments and its own id, in the run", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    const attachment = { data: new Uint8Array([1, 2, 3]).buffer, mimeType: "image/png" };
    const handle = session.prompt({ text: "look at this", attachments: [attachment] });
    await until(() => fake.sent.length === 1);
    const run = fake.sent[0]!;
    expect(run.messageIds).toEqual([handle.id]);
    expect(run.messages).toHaveLength(1);
    expect(run.messages[0]).toMatchObject({ id: handle.id, text: "look at this" });
    expect(run.messages[0]!.attachments).toEqual([attachment]);
    expect(run.messages.map((message) => message.id)).toEqual([...run.messageIds]); // the same messages, in the same order
  }, 20_000);

  test("end to end: the backend answers from the content it was sent, and the prompt resolves with that reply", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    const handle = session.prompt("what is the word?");
    await until(() => fake.sent.length === 1);
    const message = fake.sent[0]!.messages[0]!; // all the backend has is the run
    fake.startTurn({ chunks: [`you asked: ${message.text}`] }, { messageIds: [message.id] });
    const result = await handle;
    expect(result.messages.map((entry) => entry.text)).toEqual(["you asked: what is the word?"]);
  }, 20_000);

  test("queued messages are handed over one at a time, each with its own content", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    let accept!: () => void;
    fake.acceptGate = new Promise<void>((resolve) => { accept = resolve; });
    const { session } = await sessionWith(fake);
    session.prompt("one");
    await until(() => fake.sent.length === 1);
    session.prompt({ text: "two", delivery: "steer" });
    session.prompt({ text: "three", delivery: "steer" });
    accept();
    await until(() => fake.sent.length === 3);
    expect(fake.sent.map((run) => run.messages.map((message) => message.text))).toEqual([["one"], ["two"], ["three"]]);
  }, 20_000);

  test("a session-scheduled combined steer run lists each original message with its content", async () => {
    const fake = new FakeController({ scheduling: "session" });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    fake.sendScript = () => (fake.sent.length === 1 ? { chunks: ["first"], hold } : { chunks: ["combined"] });
    const { session } = await sessionWith(fake);
    session.prompt("one");
    await until(() => fake.sent.length === 1);
    const second = session.prompt({ text: "two", delivery: "steer" });
    const third = session.prompt({ text: "three", delivery: "steer" });
    release();
    await Promise.all([second, third]);
    const combined = fake.sent.find((run) => run.messageIds.length === 2)!;
    expect(combined.messages.map((message) => [message.id, message.text])).toEqual([[second.id, "two"], [third.id, "three"]]);
  }, 20_000);
});

describe("a cause can hold messages and items together", () => {
  test("a turn started by a message that also took a backend item reports both in turn_started", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session, events } = await sessionWith(fake);
    const handle = session.prompt("hello");
    await until(() => fake.sent.length === 1);
    const item = { from: "worker", reply: "done" };
    const turnId = fake.startTurn({ chunks: ["both"] }, { messageIds: [handle.id], items: [item] });
    await handle;
    expect(events.find((event) => event.kind === "turn_started" && event.turnId === turnId)!.cause).toEqual({ messageIds: [handle.id], items: [item] });
  }, 20_000);

  test("turn_took of an item into a messages turn, and of messages into an items turn, extends the cause: neither kind is lost", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session, events } = await sessionWith(fake);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const blocker = session.prompt("blocker");
    await until(() => fake.sent.length === 1);
    const running = fake.startTurn({ chunks: ["A"], hold }, { messageIds: [blocker.id] });
    await until(() => fake.prompted.includes(running));
    // Two turns reported while the first runs: they wait, and the backend folds more into each before they run.
    const one = session.prompt({ text: "one", delivery: "steer" });
    const two = session.prompt({ text: "two", delivery: "steer" });
    await until(() => fake.sent.length === 3);
    const messagesTurn = fake.startTurn({ chunks: ["M"] }, { messageIds: [one.id] });
    const itemsTurn = fake.startTurn({ chunks: ["I"] }, { items: [{ n: 1 }] });
    fake.foldInto(messagesTurn, { items: [{ n: 2 }] });
    fake.foldInto(itemsTurn, { messageIds: [two.id] });
    release();
    const [, , twoResult] = await Promise.all([blocker, one, two]);
    const cause = (turnId: string) => events.find((event) => event.kind === "turn_started" && event.turnId === turnId)!.cause;
    expect(cause(messagesTurn)).toEqual({ messageIds: [one.id], items: [{ n: 2 }] });
    expect(cause(itemsTurn)).toEqual({ messageIds: [two.id], items: [{ n: 1 }] });
    expect(twoResult.operationId).toBe(itemsTurn); // the message taken into the items turn still settles with it
  }, 20_000);
});

describe("the wait after acceptance is cancellable (stop, withdraw, interrupt) and has no time limit", () => {
  test("withdraw: a message the backend accepted and no turn has taken resolves as cancelled, and a turn that names it later is ignored", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session, events } = await sessionWith(fake);
    const handle = session.prompt("changed my mind");
    await until(() => fake.sent.length === 1);
    expect(handle.withdraw()).toBe(true);
    const result = await handle;
    expect(result.status).toBe("cancelled");
    expect(result.metering).toBeNull();
    expect(handle.withdraw()).toBe(false); // already gone
    // The backend, not told, later names it: unknown id, ignored: the turn runs, nothing settles twice, nothing throws.
    fake.startTurn({ chunks: ["late"] }, { messageIds: [handle.id] });
    await until(() => events.some((event) => event.kind === "turn_completed"));
    expect(events.filter((event) => event.kind === "turn_failed")).toHaveLength(0);
  }, 20_000);

  test("interrupt with clearQueue drops the waiting messages as cancelled, like queued ones; a plain interrupt does not", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    const waiting = session.prompt("waits for a turn");
    const outcome = track(waiting);
    await until(() => fake.sent.length === 1);
    session.interrupt();
    await Bun.sleep(0);
    expect(outcome.settled).toBe(false); // a plain interrupt leaves it waiting
    session.interrupt({ clearQueue: true });
    expect((await waiting).status).toBe("cancelled");
  }, 20_000);

  test("it has no time limit: a message waiting behind a long turn is not failed by waiting", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const first = session.prompt("one");
    await until(() => fake.sent.length === 1);
    const running = fake.startTurn({ chunks: ["long"], hold }, { messageIds: [first.id] });
    await until(() => fake.prompted.includes(running));
    const later = session.prompt({ text: "accepted while the long turn runs", delivery: "steer" });
    const outcome = track(later);
    await until(() => fake.sent.length === 2);
    await Bun.sleep(150); // waits through a stretch of time without being failed or cancelled
    expect(outcome.settled).toBe(false);
    release();
    await first;
    fake.startTurn({ chunks: ["next turn"] }, { messageIds: [later.id] }); // taken by the next turn
    expect((await later).status).toBe("completed");
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------
// Review of f886637: only an accepted, unclaimed message may be withdrawn or dropped locally. A message in flight
// (send not resolved) or taken by a turn (its cause or a turn_took names it) is not, and its turn settles it.
// ---------------------------------------------------------------------------------------------

describe("withdraw and clearQueue touch only accepted, unclaimed messages", () => {
  /** A running backend turn holding the session's queue, and a release for it. */
  async function runningTurn(fake: FakeController, session: Awaited<ReturnType<typeof sessionWith>>["session"], claims: string[], text = "A") {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const turnId = fake.startTurn({ chunks: [text], hold }, { messageIds: claims });
    await until(() => fake.prompted.includes(turnId));
    return { turnId, release };
  }

  test("taken by a running turn's initial cause: withdraw is refused, clearQueue keeps it, and the turn settles it", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    const handle = session.prompt("taken at once");
    await until(() => fake.sent.length === 1);
    const { turnId, release } = await runningTurn(fake, session, [handle.id]);
    expect(handle.withdraw()).toBe(false);
    // The interrupt cancels the running turn and drops accepted, unclaimed messages: this one is taken, so its turn settles it.
    session.interrupt({ clearQueue: true });
    const result = await handle;
    expect(result.operationId).toBe(turnId); // settled by its (interrupted) turn...
    expect(result.metering).not.toBeNull(); // ...which ran: it was not dropped as a never-sent message
    release();
  }, 20_000);

  test("taken by a running turn through turn_took: the same", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    const first = session.prompt("one");
    await until(() => fake.sent.length === 1);
    const { turnId, release } = await runningTurn(fake, session, [first.id]);
    const second = session.prompt({ text: "two", delivery: "steer" });
    await until(() => fake.sent.length === 2);
    fake.foldInto(turnId, { messageIds: [second.id] });
    expect(second.withdraw()).toBe(false);
    session.interrupt({ clearQueue: true });
    const [, secondResult] = await Promise.all([first, second]);
    expect(secondResult.operationId).toBe(turnId); // settled by the turn that took it, not dropped
    expect(secondResult.metering).not.toBeNull();
    release();
  }, 20_000);

  test("taken by a turn still queued behind a running one, by its initial cause and by turn_took: neither can be cancelled, both settle with that turn", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session, events } = await sessionWith(fake);
    const blocker = session.prompt("blocker");
    await until(() => fake.sent.length === 1);
    const { release } = await runningTurn(fake, session, [blocker.id], "blocker");
    const byCause = session.prompt({ text: "by cause", delivery: "steer" });
    const byTook = session.prompt({ text: "by took", delivery: "steer" });
    await until(() => fake.sent.length === 3);
    const queued = fake.startTurn({ chunks: ["queued turn"] }, { messageIds: [byCause.id] }); // waits behind the running turn
    fake.foldInto(queued, { messageIds: [byTook.id] });
    expect(byCause.withdraw()).toBe(false);
    expect(byTook.withdraw()).toBe(false);
    session.interrupt({ clearQueue: true }); // the queued backend turn stays, so do the messages it took
    release();
    const [, one, two] = await Promise.all([blocker, byCause, byTook]);
    expect([one.status, two.status]).toEqual(["completed", "completed"]);
    expect([one.operationId, two.operationId]).toEqual([queued, queued]);
    expect(events.filter((event) => event.kind === "turn_failed")).toHaveLength(0);
  }, 20_000);

  test("while send is in flight it cannot be withdrawn or cleared; once accepted and unclaimed it can", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    let accept!: () => void;
    fake.acceptGate = new Promise<void>((resolve) => { accept = resolve; });
    const { session } = await sessionWith(fake);
    const handle = session.prompt("in flight");
    const outcome = track(handle);
    await until(() => fake.sent.length === 1); // handed over, not yet accepted
    expect(handle.withdraw()).toBe(false);
    session.interrupt({ clearQueue: true });
    await Bun.sleep(0);
    expect(outcome.settled).toBe(false); // still in flight: not cancelled
    accept();
    await until(() => fake.accepted === 1); // send resolved
    await until(() => handle.withdraw()); // accepted and unclaimed: now it can be withdrawn (a bounded wait for the session to note it)
    expect((await handle).status).toBe("cancelled");
  }, 20_000);

  test("a turn that claims a message before send has resolved keeps it: it is taken, not waiting, once accepted", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    let accept!: () => void;
    fake.acceptGate = new Promise<void>((resolve) => { accept = resolve; });
    const { session } = await sessionWith(fake);
    const handle = session.prompt("claimed early");
    await until(() => fake.sent.length === 1);
    const turnId = fake.startTurn({ chunks: ["early"] }, { messageIds: [handle.id] }); // names it while send is in flight
    accept();
    await until(() => fake.accepted === 1);
    expect(handle.withdraw()).toBe(false); // taken, not accepted-unclaimed
    const result = await handle;
    expect(result.status).toBe("completed");
    expect(result.operationId).toBe(turnId);
  }, 20_000);

  test("stop still ends every wait, taken ones included: nothing is left unsettled", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session } = await sessionWith(fake);
    const handle = session.prompt("taken, then stop");
    await until(() => fake.sent.length === 1);
    await runningTurn(fake, session, [handle.id]);
    await session.stop();
    const result = await Promise.race([handle.then((value) => value, (error) => error), Bun.sleep(5000).then(() => "hung")]);
    expect(result).not.toBe("hung");
  }, 20_000);
});
