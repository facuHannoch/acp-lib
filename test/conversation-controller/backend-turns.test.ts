/**
 * Turns the backend starts on its own (controller-interface spec, How a turn runs after the refactor;
 * Brief B2 step 5a), against the core-only fake controller: the turn joins the operation queue, runs in
 * order through `runTurn` without the ACP content phase (no user record, the session's own recording
 * handlers), is supervised and metered, and completes after finalization.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "../../src/agent.ts";
import { AgentSession } from "../../src/agent-session.ts";
import type { ConversationController } from "../../src/conversation-controller/index.ts";
import { FakeController, type FakeScript } from "./fake-controller.ts";

const ECHO = resolve(import.meta.dir, "../fixtures/echo-prompt-agent.ts");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean().catch(() => undefined);
});

type Seen = { kind: string; [key: string]: any };

/** A session whose live controller is the fake (the session reads its controller through its private field). */
async function sessionWith(fake: FakeController, options: { managed?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "acp-backend-turns-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const transcriptPath = join(directory, "transcript.jsonl");
  const session = await AgentSession.create({
    adapter: { command: ["bun", ECHO] },
    adapterId: "fixture",
    agentSessionId: `backend-turns-${Math.random().toString(36).slice(2)}`,
    cwd: directory,
    metering: { pricing: false },
    ...(options.managed ? { persistence: { root: directory }, creationId: "backend-turns-creation" } : { transcriptPath }),
  });
  cleanups.push(() => session.stop());
  const internals = session as unknown as { controller: ConversationController; bindController(controller: ConversationController): void };
  const real = internals.controller;
  internals.controller = fake;
  internals.bindController(fake);
  cleanups.push(() => real.stop());
  const events: Seen[] = [];
  session.subscribe(({ event }) => { events.push(event as Seen); });
  const transcript = async () => (await readFile(options.managed ? session.transcriptPath! : transcriptPath, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
  return { session, events, transcript };
}

const until = async (predicate: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition timed out");
    await Bun.sleep(5);
  }
};
const kinds = (events: Seen[], turnId?: string) =>
  events.filter((event) => event.kind.startsWith("turn_") && (turnId === undefined || event.turnId === turnId)).map((event) => `${event.kind}:${event.turnId}`);

describe("a turn the backend starts on its own", () => {
  test("on an idle conversation it runs: turn_started with its cause, metering once, completion with its result", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { events } = await sessionWith(fake);
    const cause = { kind: "items" as const, items: [{ from: "worker" }] };
    const id = fake.startTurn({ chunks: ["done ", "it"], text: "done it" }, cause);
    await until(() => events.some((event) => event.kind === "turn_completed"));
    expect(kinds(events)).toEqual([`turn_started:${id}`, `turn_completed:${id}`]);
    expect(events.find((event) => event.kind === "turn_started")).toMatchObject({ turnId: id, cause });
    const completed = events.find((event) => event.kind === "turn_completed")!;
    expect(completed.result.status).toBe("completed");
    expect(completed.result.messages.map((message: { text: string }) => message.text)).toEqual(["done it"]);
    expect(completed.result.metering.operationId).toBe(id);
    expect(events.filter((event) => event.kind === "metering_recorded").map((event) => event.record.operationId)).toEqual([id]);
    expect(fake.prompted).toEqual([id]);
    expect(fake.held).toEqual([]);
    expect(fake.abandoned).toEqual([]);
  }, 20_000);

  test("it writes no user record: the detached transcript has only the assistant line", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { events, transcript } = await sessionWith(fake);
    fake.startTurn({ chunks: ["reply"] });
    await until(() => events.some((event) => event.kind === "turn_completed"));
    const lines = await transcript();
    expect(lines.filter((line) => line.t === "msg").map((line) => line.role)).toEqual(["assistant"]);
  }, 20_000);

  test("managed mode: its operation is recorded with the assistant message and no user message", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { events, transcript } = await sessionWith(fake, { managed: true });
    const id = fake.startTurn({ chunks: ["managed reply"] });
    await until(() => events.some((event) => event.kind === "turn_completed"));
    const lines = (await transcript()).filter((line) => line.operationId === id);
    expect(lines.some((line) => line.t === "message" && line.role === "user")).toBe(false);
    expect(lines.some((line) => line.t === "message" && line.role === "assistant" && line.status === "completed")).toBe(true);
    expect(lines.some((line) => line.t === "metering_reference")).toBe(true);
    expect(lines.some((line) => line.t === "operation" && line.event !== "started")).toBe(true);
  }, 20_000);

  test("reported while a prompt runs, it waits: its turn_started comes only after that turn completes, its output after that", async () => {
    const fake = new FakeController({ scheduling: "session" });
    const { session, events } = await sessionWith(fake);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    fake.sendScript = () => ({ chunks: ["first"], hold });
    const prompt = session.prompt("one");
    await until(() => events.some((event) => event.kind === "turn_started"));
    const id = fake.startTurn({ chunks: ["backend"] });
    await until(() => fake.prompted.length === 1); // the prompt's turn is in flight, held by its script
    expect(fake.held).toEqual([id]); // reported, output held, not yet prepared
    expect(kinds(events)).toHaveLength(1); // only the prompt's turn_started so far
    release();
    const result = await prompt;
    await until(() => events.some((event) => event.kind === "turn_completed" && event.turnId === id));
    const order = kinds(events);
    expect(order).toEqual([`turn_started:${result.operationId}`, `turn_completed:${result.operationId}`, `turn_started:${id}`, `turn_completed:${id}`]);
    expect(fake.prompted).toEqual([result.operationId, id]);
    expect(fake.held).toEqual([]);
  }, 20_000);

  test("two backend turns run in the order reported, one at a time", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { events } = await sessionWith(fake);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const first = fake.startTurn({ chunks: ["a"], hold });
    const second = fake.startTurn({ chunks: ["b"] });
    await until(() => fake.prompted.length === 1);
    expect(fake.prompted).toEqual([first]); // the second hasn't been prepared; the ordering below proves it waited
    release();
    await until(() => events.filter((event) => event.kind === "turn_completed").length === 2);
    expect(kinds(events)).toEqual([`turn_started:${first}`, `turn_completed:${first}`, `turn_started:${second}`, `turn_completed:${second}`]);
  }, 20_000);

  test("a failing backend turn is abandoned, emits turn_failed, is metered once, and the conversation goes on", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session, events } = await sessionWith(fake);
    const id = fake.startTurn({ fail: new Error("backend exploded") });
    await until(() => events.some((event) => event.kind === "turn_failed"));
    expect(kinds(events)).toEqual([`turn_started:${id}`, `turn_failed:${id}`]);
    expect(events.find((event) => event.kind === "turn_failed")!.error).toContain("backend exploded");
    expect(events.filter((event) => event.kind === "metering_recorded").map((event) => event.record.operationId)).toEqual([id]);
    expect(session.state.operation).toBeNull();
    const next = fake.startTurn({ chunks: ["still works"] });
    await until(() => events.some((event) => event.kind === "turn_completed" && event.turnId === next));
  }, 20_000);

  test("the conversation stopping while a turn waits: it is abandoned, never started, nothing is left held", async () => {
    const fake = new FakeController({ scheduling: "session" });
    const { session, events } = await sessionWith(fake);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    fake.sendScript = () => ({ chunks: ["first"], hold });
    const prompt = session.prompt("one").catch((error) => error);
    await until(() => events.some((event) => event.kind === "turn_started"));
    const id = fake.startTurn({ chunks: ["never runs"] });
    const stopping = session.stop();
    release();
    await prompt;
    await stopping;
    expect(events.some((event) => event.turnId === id)).toBe(false);
    expect(fake.abandoned.map((entry) => entry.turnId)).toContain(id);
    expect(fake.prompted).not.toContain(id);
    expect(fake.held).toEqual([]);
  }, 20_000);

  test("a turn reported after the conversation stopped is abandoned at once", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const { session, events } = await sessionWith(fake);
    await session.stop();
    const id = fake.startTurn({ chunks: ["late"] });
    expect(fake.abandoned.map((entry) => entry.turnId)).toEqual([id]);
    expect(fake.held).toEqual([]);
    expect(events.some((event) => event.turnId === id)).toBe(false);
  }, 20_000);

  test("interrupt with clearQueue drops queued messages but not a turn the backend already started", async () => {
    const fake = new FakeController({ scheduling: "session" });
    const { session, events } = await sessionWith(fake);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    fake.sendScript = () => ({ chunks: ["first"], hold });
    const prompt = session.prompt("one").catch((error) => error);
    await until(() => events.some((event) => event.kind === "turn_started"));
    const queuedMessage = session.prompt({ text: "two", delivery: "queue" }).catch((error) => error);
    const id = fake.startTurn({ chunks: ["kept"] });
    session.interrupt({ clearQueue: true });
    release();
    await prompt;
    const dropped = await queuedMessage;
    expect(dropped.status).toBe("cancelled"); // the queued message was dropped with a cancelled result
    await until(() => events.some((event) => event.kind === "turn_completed" && event.turnId === id));
    expect(fake.prompted).toContain(id);
  }, 20_000);
});

describe("lifecycle across a handoff and in an Agent-owned conversation", () => {
  test("a handoff queued ahead of a reported turn replaces the controller: the turn is abandoned on the controller that reported it, not run on the new one", async () => {
    const fake = new FakeController({ scheduling: "session" });
    const { session, events } = await sessionWith(fake);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    fake.sendScript = () => ({ chunks: ["first"], hold });
    const prompt = session.prompt("one");
    await until(() => events.some((event) => event.kind === "turn_started"));
    const handoff = session.handoff({ continuation: { kind: "none" } }); // queued behind the running prompt
    const id = fake.startTurn({ chunks: ["held for the old controller"] }); // reported after the handoff was queued
    expect(fake.held).toContain(id); // its output is held on the controller that reported it
    release();
    await prompt;
    await handoff;
    await until(() => fake.abandoned.length > 0); // the turn's queue item runs right after the handoff
    const live = (session as unknown as { controller: ConversationController }).controller;
    expect(live).not.toBe(fake); // the handoff replaced the controller
    expect(fake.abandoned.map((entry) => entry.turnId)).toEqual([id]);
    expect(String(fake.abandoned[0]!.reason)).toContain("replaced");
    expect(fake.held).toEqual([]); // nothing stays held on the old controller
    expect(fake.prompted).not.toContain(id);
    expect(events.some((event) => event.turnId === id)).toBe(false); // it never started
    // The conversation goes on, on the new controller.
    expect((await session.prompt("after the handoff")).status).toBe("completed");
  }, 30_000);

  test("Agent-owned: assistant and metering are persisted, no user record is written, and completion follows afterPrompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-backend-turns-owned-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { fixture: { command: ["bun", ECHO] } },
      defaultAdapterId: "fixture",
      capture: { message: "content", error: "raw" },
      checkpointing: { enabled: false },
      conversationDefaults: { metering: { pricing: false }, cwd: directory },
    });
    cleanups.push(() => agent.close());
    const timeline: string[] = [];
    agent.events.subscribe((notification) => {
      const record = notification.event.record as unknown as { kind: string; recordId: string };
      timeline.push(`record:${record.recordId}`);
    });
    const conversation = await agent.conversations.create();
    const fake = new FakeController({ scheduling: "backend" });
    const internals = conversation as unknown as { controller: ConversationController; bindController(controller: ConversationController): void; ownerLifecycle: { afterPrompt: (input: any) => Promise<unknown> } };
    const real = internals.controller;
    internals.controller = fake;
    internals.bindController(fake);
    cleanups.push(() => real.stop());
    const afterPrompt = internals.ownerLifecycle.afterPrompt.bind(internals.ownerLifecycle);
    internals.ownerLifecycle.afterPrompt = async (input: { operationId: string }) => {
      const result = await afterPrompt(input);
      timeline.push(`afterPrompt:${input.operationId}`);
      return result;
    };
    conversation.subscribe(({ event }) => { if (event.kind.startsWith("turn_")) timeline.push(`${event.kind}:${(event as { turnId: string }).turnId}`); });
    const id = fake.startTurn({ chunks: ["owned reply"] });
    await until(() => timeline.includes(`turn_completed:${id}`));
    const records = (await agent.persistence.records.list(conversation.id, { limit: 1000 })).records as unknown as Array<Record<string, any>>;
    const mine = records.filter((record) => record.operationId === id);
    expect(mine.some((record) => record.role === "user" || String(record.recordId).endsWith(":user"))).toBe(false);
    const finalAssistant = mine.find((record) => record.recordId === `${id}:assistant:1`);
    expect(finalAssistant?.content).toBe("owned reply");
    expect(finalAssistant?.status).toBe("completed");
    expect(mine.filter((record) => record.kind === "metering").map((record) => record.recordId)).toEqual([`${id}:metering`]);
    // Completion comes after the final assistant record, the metering record and afterPrompt.
    const at = (entry: string) => timeline.indexOf(entry);
    // Each event must be present before its position means anything (-1 would make an ordering check pass).
    for (const entry of [`turn_started:${id}`, `record:${id}:assistant:1`, `record:${id}:metering`, `afterPrompt:${id}`, `turn_completed:${id}`]) {
      expect({ entry, present: at(entry) >= 0 }).toEqual({ entry, present: true });
    }
    expect(at(`turn_completed:${id}`)).toBeGreaterThan(at(`record:${id}:assistant:1`));
    expect(at(`turn_completed:${id}`)).toBeGreaterThan(at(`record:${id}:metering`));
    expect(at(`turn_completed:${id}`)).toBeGreaterThan(at(`afterPrompt:${id}`));
    expect(at(`turn_started:${id}`)).toBeLessThan(at(`record:${id}:assistant:1`));
  }, 30_000);
});

describe("the fake controller itself", () => {
  test("holds a started turn's output until its prompt(): preparing starts nothing", () => {
    const fake = new FakeController({ scheduling: "backend" });
    const chunks: string[] = [];
    const id = fake.startTurn({ chunks: ["x"] });
    expect(fake.held).toEqual([id]);
    const prepared = fake.prepareTurn(id, { handlers: { onChunk: (text) => chunks.push(text) } });
    expect(chunks).toEqual([]);
    expect(fake.prompted).toEqual([]);
    expect(prepared.turnId).toBe(id);
    expect(fake.held).toEqual([]); // prepared: no longer held
  });

  test("abandonTurn is idempotent and a no-op for a turn that already ran", async () => {
    const fake = new FakeController({ scheduling: "backend" });
    const id = fake.startTurn({ chunks: ["x"] });
    fake.abandonTurn(id, "no");
    fake.abandonTurn(id, "again");
    expect(fake.abandoned).toHaveLength(1);
    const ran = fake.startTurn({ chunks: ["y"] });
    await fake.prepareTurn(ran, { handlers: {} }).prompt();
    fake.abandonTurn(ran, "too late");
    expect(fake.abandoned).toHaveLength(1);
  });
});
