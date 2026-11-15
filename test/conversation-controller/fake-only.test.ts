/**
 * Conformance cases only the core-only fake can run (controller-interface spec, Brief B2 step 6): per-turn
 * supervision and the attachment barrier, a held turn replayed after the backend finished it, late output after a
 * forced stop, options known before start. (A turn the backend starts on its own, its failure, the conversation
 * stopping and the controller being replaced while it waits, and `turn_took` are in `backend-turns.test.ts` and
 * `backend-scheduled.test.ts`.)
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "../../src/agent.ts";
import { AgentSession } from "../../src/agent-session.ts";
import type { ConversationController } from "../../src/conversation-controller/index.ts";
import { FakeController } from "./fake-controller.ts";

const ECHO = resolve(import.meta.dir, "../fixtures/echo-prompt-agent.ts");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean().catch(() => undefined);
});

type Seen = { kind: string; [key: string]: any };

async function sessionWith(fake: FakeController, options: { stale?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "acp-fake-only-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const session = await AgentSession.create({
    adapter: { command: ["bun", ECHO] },
    adapterId: "fixture",
    agentSessionId: `fake-only-${Math.random().toString(36).slice(2)}`,
    cwd: directory,
    metering: { pricing: false },
    ...(options.stale ? { operationLifecycle: { turns: { firstOutputMs: 30, nextOutputMs: 30 } } } : {}),
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

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("the attachment barrier", () => {
  test("a turn that signals a pending permission the instant prompt() is called is supervised from it: stage and stall timer are right", async () => {
    const fake = new FakeController({ scheduling: "session" });
    const { session, events } = await sessionWith(fake, { stale: true });
    // Silent for 250 ms with a 30 ms stall limit: it would stall, but a permission is pending from the first instant.
    fake.queueScript({ chunks: ["answered"], hold: delay(250), signals: [{ kind: "permission_started", sessionId: "fake-session" }] });
    const result = await session.prompt("needs permission");
    expect(result.status).toBe("completed");
    expect(events.some((event) => event.kind === "operation_stage_changed" && event.activity.stage === "awaiting_permission")).toBe(true);
  }, 20_000);

  test("without that signal the same silence stalls (so the signal above is what kept the turn alive)", async () => {
    const fake = new FakeController({ scheduling: "session" });
    const { session } = await sessionWith(fake, { stale: true });
    fake.queueScript({ chunks: ["too late"], hold: new Promise<void>(() => undefined) });
    const error = await session.prompt("silent").catch((caught) => caught);
    expect(error.code).toBe("stalled");
  }, 20_000);

  test("a held turn whose replay begins with such a boundary has it seen too", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { events } = await sessionWith(fake, { stale: true });
    fake.startTurn({ chunks: ["held and replayed"], hold: delay(250), signals: [{ kind: "permission_started", sessionId: "fake-session" }] });
    await until(() => events.some((event) => event.kind === "turn_completed"));
    expect(events.some((event) => event.kind === "operation_stage_changed" && event.activity.stage === "awaiting_permission")).toBe(true);
    expect(events.some((event) => event.kind === "turn_failed")).toBe(false);
  }, 20_000);
});

describe("per-turn supervision", () => {
  test("a turn the backend already finished (held output, replayed, not live) does not stall, however slow its replay", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { events } = await sessionWith(fake, { stale: true });
    // The replay takes 250 ms with nothing signalled and a 30 ms stall limit: live, it would stall.
    const id = fake.startTurn({ chunks: ["finished earlier"], hold: delay(250), ended: true });
    await until(() => events.some((event) => event.kind === "turn_completed" || event.kind === "turn_failed"));
    expect(events.find((event) => event.kind === "turn_completed")).toMatchObject({ turnId: id });
  }, 20_000);

  test("a turn that replays, then becomes live, then goes silent stalls: its deadline is not lost, and the queue is not stuck", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { events } = await sessionWith(fake, { stale: true });
    const startedAt = Date.now();
    const id = fake.startTurn({ chunks: ["replayed"], ended: true, goLive: delay(150), hold: new Promise<void>(() => undefined) });
    await until(() => events.some((event) => event.kind === "turn_failed"));
    const failedAfter = Date.now() - startedAt;
    expect(events.find((event) => event.kind === "turn_failed")).toMatchObject({ turnId: id });
    expect(String(events.find((event) => event.kind === "turn_failed")!.error)).toContain("stalled");
    expect(failedAfter).toBeGreaterThanOrEqual(120); // not stalled while it replayed (a 30 ms limit)...
    expect(failedAfter).toBeLessThan(2000); // ...and stalled soon after it became live: bounded
    const next = fake.startTurn({ chunks: ["queue still moves"] });
    await until(() => events.some((event) => event.kind === "turn_completed" && event.turnId === next));
  }, 20_000);

  test("the same slow turn, live, does stall (the stall check applies from the point a turn is live)", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { events } = await sessionWith(fake, { stale: true });
    const id = fake.startTurn({ chunks: ["running"], hold: new Promise<void>(() => undefined) });
    await until(() => events.some((event) => event.kind === "turn_failed"));
    expect(events.find((event) => event.kind === "turn_failed")).toMatchObject({ turnId: id });
  }, 20_000);

  test("signals and cancels reach only their own prepared turn; forceStop rejects every open one", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const b = fake.startTurn({ chunks: ["B"], hold: new Promise<void>(() => undefined), signals: [{ kind: "update", sessionId: "fake-session" }] });
    const c = fake.startTurn({ chunks: ["C"], hold: delay(30), signals: [{ kind: "request", sessionId: "fake-session" }] });
    const preparedB = fake.prepareTurn(b, { handlers: {} });
    const preparedC = fake.prepareTurn(c, { handlers: {} });
    const seenB: string[] = [];
    const seenC: string[] = [];
    preparedB.subscribeOutput((output) => seenB.push(output.kind));
    preparedC.subscribeOutput((output) => seenC.push(output.kind));
    const runningB = preparedB.prompt().then(() => "settled", () => "rejected");
    const runningC = preparedC.prompt();
    expect(seenB).toEqual(["update"]); // B sees only its own signal
    expect(seenC).toEqual(["request"]); // and C its own, never B's
    preparedB.cancel(); // cancelling B leaves C running
    expect((await runningC).status).toBe("completed");
    expect(await runningB).toBe("settled");
    // forceStop rejects every open prepared turn.
    const d = fake.prepareTurn(fake.startTurn({ chunks: ["D"], hold: new Promise<void>(() => undefined) }), { handlers: {} });
    const e = fake.prepareTurn(fake.startTurn({ chunks: ["E"], hold: new Promise<void>(() => undefined) }), { handlers: {} });
    const outcomes = [d.prompt().then(() => "settled", () => "rejected"), e.prompt().then(() => "settled", () => "rejected")];
    await fake.forceStop();
    expect(await Promise.all(outcomes)).toEqual(["rejected", "rejected"]);
  });
});

describe("late output after a forced stop", () => {
  test("is dropped: it is not recorded on the next turn", async () => {
    const fake = new FakeController({ scheduling: "session" });
    const { session, events } = await sessionWith(fake);
    fake.queueScript({ chunks: ["first"], hold: new Promise<void>(() => undefined) });
    const first = session.prompt("one");
    const outcome = first.then(() => "settled", () => "rejected");
    await until(() => session.state.operation !== null);
    await fake.forceStop();
    expect(await outcome).toBe("rejected");
    const firstTurn = events.find((event) => event.kind === "turn_started")!.turnId as string;
    fake.deliverLate(firstTurn, "LATE OUTPUT"); // the old turn's handlers, after the fact
    const second = await session.prompt("two");
    expect(second.status).toBe("completed");
    expect(second.messages.map((message) => message.text).join(" ")).not.toContain("LATE");
    expect(second.text).not.toContain("LATE");
  }, 20_000);
});

describe("options known before start", () => {
  test("a controller with options at once reports them through the controller and the session, before any start", async () => {
    const options = new Map([["model", { configId: "model", type: "select" as const, currentValue: "fast" }]]);
    const fake = new FakeController({ scheduling: "backend", configOptions: options as ConversationController["configOptions"] });
    expect(fake.configOptions.get("model")?.currentValue).toBe("fast");
    const { session } = await sessionWith(fake);
    expect(session.configOptions.get("model")?.currentValue).toBe("fast");
  }, 20_000);
});
