/**
 * The turn path through `send`, `prepareTurn` and `abandonTurn` (controller-interface spec,
 * Brief A2 step 4): the cause of a combined steer run, a turn released when it never reaches the
 * provider, completion only after finalization, the queue waiting for finalization, invalid runs,
 * and the readiness boundary right after `prompt()` behaving as before the refactor.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "../../src/agent.ts";
import { AgentSession } from "../../src/agent-session.ts";
import type { AgentSessionNotification } from "../../src/agent-conversation-contracts.ts";
import type { AgentConversationOwnerLifecycle } from "../../src/agent-conversation-owner.ts";
import { HarnessController } from "../../src/controller.ts";
import type { TurnEvent } from "../../src/conversation-controller/contracts.ts";
import { checkTurnRun, turnRunOf, type RunMessageState } from "../../src/conversation-turns/index.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures");
const STEER = join(FIXTURES, "steer-agent.ts");
const LIFECYCLE = join(FIXTURES, "lifecycle-agent.ts");
const CONFIG = join(FIXTURES, "config-agent.ts");
const ECHO = join(FIXTURES, "echo-prompt-agent.ts");
const SEQUENTIAL = "Read a.txt, then b.txt, then c.txt, each with its own tool call, one at a time. Then tell me the three words in order.";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean().catch(() => undefined);
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acp-turn-path-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function agentConversation(fixture: string, env: Record<string, string> = {}) {
  const directory = await tempDir();
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
    adapters: { fixture: { command: ["bun", fixture], cancelGraceMs: 80 } },
    defaultAdapterId: "fixture",
    checkpointing: { enabled: false },
    conversationDefaults: { metering: { pricing: false }, env, cwd: directory, permissions: { default: "allow" } },
  });
  cleanups.push(() => agent.close());
  const conversation = await agent.conversations.create();
  const events: AgentSessionNotification["event"][] = [];
  conversation.subscribe(({ event }) => events.push(event));
  return { agent, conversation, events, directory };
}

/** The Agent-owned conversation's lifecycle, to wrap `afterPrompt` (a private field). */
function lifecycleOf(conversation: AgentSession): AgentConversationOwnerLifecycle {
  const lifecycle = (conversation as unknown as { ownerLifecycle?: AgentConversationOwnerLifecycle }).ownerLifecycle;
  if (!lifecycle) throw new Error("not an Agent-owned conversation");
  return lifecycle;
}

const ofKind = (events: readonly { kind: string }[], kind: string) => events.filter((event) => event.kind === kind) as any[];
const KINDS = new Set(["turn_started", "turn_completed", "turn_failed", "provider_reconnected"]);

/** Waits for `promise`, failing after `ms` (every wait in these tests is bounded). */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A detached conversation on the echo fixture. */
async function detachedConversation() {
  const directory = await tempDir();
  const conversation = await AgentSession.create({
    adapter: { command: ["bun", ECHO] },
    adapterId: "fixture",
    agentSessionId: "turn-path-detached",
    cwd: directory,
  });
  cleanups.push(() => conversation.stop());
  const events: AgentSessionNotification["event"][] = [];
  conversation.subscribe(({ event }) => events.push(event));
  return { conversation, events };
}

describe("the turn path through send", () => {
  test("beforeDispatch awaits the durable prompt and runs before prepareTurn", async () => {
    const { agent, conversation } = await agentConversation(ECHO);
    const prepare = spyOn(conversation.connection, "prepareTurn");
    const persisted = spyOn(lifecycleOf(conversation), "beforePrompt");
    const hook = async (operationId: string) => {
      expect(persisted).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
      const { records } = await agent.persistence.records.list(conversation.id);
      expect(records).toContainEqual(expect.objectContaining({ operationId, kind: "message", role: "user" }));
    };
    const handle = conversation.prompt({ text: "persist then dispatch", beforeDispatch: hook });
    expect(await handle).toMatchObject({ operationId: handle.id, status: "completed" });
    expect(prepare.mock.calls.map(([id]) => id)).toEqual([handle.id]);
  }, 20_000);

  test("a rejected beforeDispatch abandons the turn and rejects with the hook error", async () => {
    const { conversation, events } = await agentConversation(ECHO);
    const prepare = spyOn(conversation.connection, "prepareTurn");
    const abandon = spyOn(conversation.connection, "abandonTurn");
    const error = new Error("hook failed");
    const handle = conversation.prompt({ text: "do not dispatch", async beforeDispatch() { throw error; } });
    await expect(handle).rejects.toBe(error);
    expect(prepare).not.toHaveBeenCalled();
    expect(abandon.mock.calls).toEqual([[handle.id, error]]);
    expect(events.filter((event) => event.kind.startsWith("turn_")).map((event) => event.kind)).toEqual(["turn_started", "turn_failed"]);
    await expect(conversation.prompt("queue continues")).resolves.toMatchObject({ status: "completed" });
  }, 20_000);

  test("combined steer awaits hooks in message order and one rejection fails the whole run", async () => {
    const { conversation, events } = await agentConversation(STEER);
    const prepare = spyOn(conversation.connection, "prepareTurn");
    const abandon = spyOn(conversation.connection, "abandonTurn");
    const failed = spyOn(lifecycleOf(conversation), "promptFailed");
    const error = new Error("second hook failed");
    const order: string[] = [];
    const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    let messages: ReturnType<AgentSession["prompt"]>[] = [];
    let outcomes: Promise<unknown[]> | undefined;
    const first = conversation.prompt(SEQUENTIAL, {
      onActivity(event) {
        if (event.kind !== "tool" || messages.length > 0) return;
        const a = conversation.prompt({ text: "First steer.", delivery: "steer", async beforeDispatch(id) {
          order.push(`first:${id}`);
          enter();
          await gate;
        } });
        const b = conversation.prompt({ text: "Second steer.", delivery: "steer", async beforeDispatch(id) {
          order.push(`second:${id}`);
          throw error;
        } });
        messages = [a, b];
        outcomes = Promise.all(messages.map((message) => message.catch((reason: unknown) => reason)));
      },
    });
    try {
      await within(entered, 10_000, "the first steer hook");
      expect(order).toEqual([`first:${messages[0]!.id}`]);
      expect(prepare.mock.calls.map(([id]) => id)).toEqual([first.id]);
    } finally {
      release();
    }
    await first;
    expect(await outcomes).toEqual([error, error]);
    expect(order).toEqual([`first:${messages[0]!.id}`, `second:${messages[1]!.id}`]);
    expect(prepare.mock.calls.map(([id]) => id)).toEqual([first.id]);
    expect(abandon.mock.calls).toContainEqual([messages[0]!.id, error]);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      operationId: messages[0]!.id, messageIds: messages.map(({ id }) => id), error,
    }));
    expect(ofKind(events, "turn_failed").map((event) => event.turnId)).toEqual([messages[0]!.id]);
  }, 20_000);

  test("a combined steer run's cause lists both message ids; record ids stay keyed by the turn", async () => {
    const { agent, conversation, events } = await agentConversation(STEER);
    const completed = spyOn(lifecycleOf(conversation), "afterPrompt");
    const hookIds: string[] = [];
    const beforeDispatch = async (messageId: string) => { hookIds.push(messageId); };
    let a!: ReturnType<AgentSession["prompt"]>;
    let b!: ReturnType<AgentSession["prompt"]>;
    let fired = false;
    const first = conversation.prompt(SEQUENTIAL, {
      onActivity: (event) => {
        if (event.kind !== "tool" || fired) return;
        fired = true;
        a = conversation.prompt({ text: "Also include the length of each word in your final answer.", delivery: "steer", beforeDispatch });
        b = conversation.prompt({ text: "No, actually, only report the length of the longest word.", delivery: "steer", beforeDispatch });
      },
    });
    await first;
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(hookIds).toEqual([a.id, b.id]);
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ operationId: ra.operationId, messageIds: hookIds }));

    const started = ofKind(events, "turn_started");
    expect(started).toEqual([
      { kind: "turn_started", turnId: first.id, cause: { messageIds: [first.id] } },
      { kind: "turn_started", turnId: a.id, cause: { messageIds: [a.id, b.id] } },
    ]);
    const users = (await agent.persistence.records.list(conversation.id, { limit: 1000 })).records
      .filter((record) => record.kind === "message" && record.role === "user")
      .map((record) => record.recordId);
    expect(users).toEqual([`${first.id}:user`, `${a.id}:user`, `${a.id}:user:2`]);
  }, 20_000);

  test("a provider-connection failure calls abandonTurn, emits turn_failed and rejects the prompt", async () => {
    const directory = await tempDir();
    const flag = join(directory, "fail-load");
    const { conversation, events } = await agentConversation(LIFECYCLE, {
      LIFECYCLE_STATE: join(directory, "sessions.json"),
      LIFECYCLE_FAIL_LOAD_FILE: flag,
    });
    await conversation.prompt("hello");
    await writeFile(flag, "1");
    await conversation.connection.forceStop();
    const abandon = spyOn(conversation.connection, "abandonTurn");
    const prepare = spyOn(conversation.connection, "prepareTurn");

    const failing = conversation.prompt("the provider cannot be reattached");
    const error = await failing.then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(abandon.mock.calls.map(([turnId]) => turnId)).toEqual([failing.id]);
    expect(prepare).not.toHaveBeenCalled();
    const turnEvents = events.filter((event) => event.kind.startsWith("turn_") && (event as any).turnId === failing.id);
    expect(turnEvents.map((event) => event.kind)).toEqual(["turn_started", "turn_failed"]);
  }, 20_000);

  test("a finalization failure after the provider finished emits turn_failed, not turn_completed", async () => {
    const { conversation, events } = await agentConversation(ECHO);
    const lifecycle = lifecycleOf(conversation);
    const afterPrompt = lifecycle.afterPrompt.bind(lifecycle);
    let providerFinished = false;
    lifecycle.afterPrompt = async () => {
      providerFinished = true;
      throw new Error("simulated finalization failure");
    };
    cleanups.push(async () => { lifecycle.afterPrompt = afterPrompt; });

    const handle = conversation.prompt("finish, then fail to record");
    const error = await handle.then(() => null, (reason: unknown) => reason);
    expect(providerFinished).toBe(true);
    expect(String(error)).toContain("simulated finalization failure");
    expect(ofKind(events, "turn_completed")).toEqual([]);
    expect(ofKind(events, "turn_failed").map((event) => event.turnId)).toEqual([handle.id]);
  }, 20_000);

  test("a config change queued behind a turn starts only after that turn's finalization", async () => {
    const { conversation, events } = await agentConversation(CONFIG);
    const order: string[] = [];
    conversation.subscribe(({ event }) => {
      if (event.kind === "turn_completed" || event.kind === "configuration_started") order.push(event.kind);
    });
    const lifecycle = lifecycleOf(conversation);
    const afterPrompt = lifecycle.afterPrompt.bind(lifecycle);
    // The test holds the turn's finalization open until it releases it.
    let release!: () => void;
    const finalizationGate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const finalizing = new Promise<void>((resolve) => { entered = resolve; });
    lifecycle.afterPrompt = async (input) => {
      order.push("afterPrompt:start");
      entered();
      await finalizationGate;
      const committed = await afterPrompt(input);
      order.push("afterPrompt:end");
      return committed;
    };
    cleanups.push(async () => { lifecycle.afterPrompt = afterPrompt; });

    const turn = conversation.prompt("a turn with a held finalization");
    // Observed from the start, so a failing assertion below cannot leave either rejection unhandled.
    const turnSettled = turn.then(() => null, (error: unknown) => error);
    let configuredSettled: Promise<unknown> = Promise.resolve(null);
    try {
      await within(finalizing, 5_000, "the turn's afterPrompt");
      const configured = conversation.setConfig("model", "beta");
      configuredSettled = configured.then(() => null, (error: unknown) => error);
      // While the finalization is held, the config change is queued behind the turn's operation,
      // not running: the queue has not moved past the turn.
      expect(conversation.state.phase).toBe("prompting");
      expect(conversation.state.queuedOperationCount).toBe(1);
      expect(order).toEqual(["afterPrompt:start"]);
    } finally {
      // Released on every path, so a failure above ends the test instead of holding the turn
      // (and the Agent's close) open.
      release();
    }
    expect(await within(turnSettled, 5_000, "the turn")).toBeNull();
    expect(await within(configuredSettled, 5_000, "the config change")).toBeNull();
    expect(order).toEqual(["afterPrompt:start", "afterPrompt:end", "turn_completed", "configuration_started"]);
    expect(ofKind(events, "configuration_completed")).toHaveLength(1);
  }, 20_000);

  test("a force stop right after prompt() fails the turn without reconnecting, as before", async () => {
    const { conversation, events } = await detachedConversation();
    const handle = conversation.prompt("hello");
    const settled = handle.then(() => null, (reason: unknown) => reason);
    await conversation.connection.forceStop();
    const error = await settled;
    expect((error as Error | null)?.name).toBe("AgentSessionOperationError");
    expect(events.map((event) => event.kind).filter((kind) => KINDS.has(kind))).toEqual(["turn_started", "turn_failed"]);
  }, 20_000);

  test("a stop from a turn_started listener fails the turn as before", async () => {
    const { conversation, events } = await detachedConversation();
    let stopped: Promise<void> | null = null;
    conversation.subscribe(({ event }) => {
      if (event.kind === "turn_started" && !stopped) stopped = conversation.stop();
    });
    const error = await conversation.prompt("hello").then(() => null, (reason: unknown) => reason);
    await stopped;
    expect((error as Error | null)?.name).toBe("AgentSessionOperationError");
    expect(events.map((event) => event.kind).filter((kind) => KINDS.has(kind))).toEqual(["turn_started", "turn_failed"]);
  }, 20_000);

  test("a run naming a message the session does not know is refused at dispatch, before send", async () => {
    const { conversation, events } = await detachedConversation();
    const steering = (conversation as unknown as { steering: { prepareRun: (...args: any[]) => any } }).steering;
    const prepareRun = steering.prepareRun.bind(steering);
    let inject = true;
    steering.prepareRun = (...args: any[]) => {
      const run = prepareRun(...args);
      if (!inject) return run;
      inject = false;
      // A bad combined run: its own message, then one no queued message owns.
      return { ...run, parts: [{ id: run.turnId, text: run.text }, { id: "not-a-session-message", text: "x" }] };
    };
    const send = spyOn(conversation.connection, "send");

    const refused = conversation.prompt("hello");
    const error = await refused.then(() => null, (reason: unknown) => reason);
    expect(String(error)).toContain("not-a-session-message, which the session does not know");
    expect(send).not.toHaveBeenCalled();
    expect(events.map((event) => event.kind).filter((kind) => KINDS.has(kind))).toEqual(["turn_failed"]);

    // The refused message is settled and released; the next prompt runs normally.
    const next = await conversation.prompt("again");
    expect(next.status).toBe("completed");
    expect(send.mock.calls.map(([run]) => run.messageIds)).toEqual([[next.operationId]]);
  }, 20_000);

  test("a run that takes a message still waiting in the queue is refused at dispatch; that message runs once, in its own turn", async () => {
    const { conversation, events } = await detachedConversation();
    const steering = (conversation as unknown as { steering: { prepareRun: (...args: any[]) => any } }).steering;
    const prepareRun = steering.prepareRun.bind(steering);
    let a!: ReturnType<AgentSession["prompt"]>;
    let b!: ReturnType<AgentSession["prompt"]>;
    steering.prepareRun = (...args: any[]) => {
      const run = prepareRun(...args);
      if (run.turnId !== a?.id) return run;
      // A bad run for A: A, then B, which is still waiting in the queue.
      return { ...run, parts: [{ id: run.turnId, text: run.text }, { id: b.id, text: "b" }] };
    };
    const send = spyOn(conversation.connection, "send");

    // `turn_started` is emitted synchronously inside `prompt()`, so subscribe first.
    const firstStarted = new Promise<void>((resolve) => {
      conversation.subscribe(({ event }) => { if (event.kind === "turn_started") resolve(); });
    });
    const first = conversation.prompt("SLOW_TURN first");
    await within(firstStarted, 5_000, "the first turn");
    a = conversation.prompt({ text: "a", delivery: "queue" });
    b = conversation.prompt({ text: "b", delivery: "queue" });
    const [firstResult, aError, bResult] = await within(Promise.all([
      first,
      a.then(() => null, (error: unknown) => error),
      b,
    ]), 10_000, "the three prompts");

    expect(firstResult.status).toBe("completed");
    expect(String(aError)).toContain(`${b.id}, which is still queued`);
    expect(bResult.status).toBe("completed");
    // B ran once, in its own turn; A's bad run never reached the controller.
    expect(send.mock.calls.map(([run]) => run.messageIds)).toEqual([[first.id], [b.id]]);
    const started = events.filter((event) => event.kind === "turn_started") as any[];
    expect(started.map((event) => event.cause.messageIds)).toEqual([[first.id], [b.id]]);
    expect(events.filter((event) => event.kind === "turn_failed").map((event: any) => event.turnId)).toEqual([a.id]);
  }, 20_000);

  test("a send rejected after the controller reported the turn fails it: abandoned, no completion", async () => {
    const { conversation, events } = await detachedConversation();
    const controller = conversation.connection;
    const send = controller.send.bind(controller);
    let reject = true;
    controller.send = (run) => {
      const accepted = send(run); // the real synchronous report
      if (!reject) return accepted;
      reject = false;
      return accepted.then(() => Promise.reject(new Error("acceptance rejected")));
    };
    const abandon = spyOn(controller, "abandonTurn");
    const prepare = spyOn(controller, "prepareTurn");

    const refused = conversation.prompt("hello");
    const error = await within(refused.then(() => null, (reason: unknown) => reason), 5_000, "the refused prompt");
    expect(String(error)).toContain("acceptance rejected");
    expect(prepare).not.toHaveBeenCalled();
    expect(abandon.mock.calls.map(([turnId]) => turnId)).toEqual([refused.id]);
    const kinds = events.map((event) => event.kind).filter((kind) => KINDS.has(kind));
    expect(kinds).toEqual(["turn_started", "turn_failed"]);

    // Nothing is left behind: the next prompt runs normally.
    expect((await conversation.prompt("again")).status).toBe("completed");
  }, 20_000);
});

describe("a rejected acceptance while the provider reconnects", () => {
  test("fails the turn at once; the reconnect in flight is waited for, not repeated; stop and cleanup finish", async () => {
    const directory = await tempDir();
    const hold = join(directory, "release-load");
    const conversation = await AgentSession.create({
      adapter: { command: ["bun", LIFECYCLE], cancelGraceMs: 50 },
      adapterId: "fixture",
      agentSessionId: "turn-path-held-reconnect",
      cwd: directory,
      // The reconnect's session/load is held until the test creates `hold`.
      env: { LIFECYCLE_STATE: join(directory, "sessions.json"), LIFECYCLE_HOLD_CONTROL: "session/load", LIFECYCLE_HOLD_FILE: hold },
    });
    let stopped = false;
    cleanups.push(async () => {
      await writeFile(hold, "release").catch(() => undefined); // never leave the load held
      if (!stopped) await conversation.stop();
    });
    const events: AgentSessionNotification["event"][] = [];
    conversation.subscribe(({ event }) => events.push(event));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    cleanups.push(async () => { process.off("unhandledRejection", onUnhandled); });

    await conversation.prompt("hello");
    await conversation.connection.forceStop(); // the next turn reconnects (session/load, held)
    const controller = conversation.connection;
    const send = controller.send.bind(controller);
    let reject = true;
    controller.send = (run) => {
      const accepted = send(run); // the real synchronous report
      if (!reject) return accepted;
      reject = false;
      return accepted.then(() => Promise.reject(new Error("acceptance rejected")));
    };
    const abandon = spyOn(controller, "abandonTurn");
    const reconnect = spyOn(controller, "reconnect");

    const refused = conversation.prompt("refused while reconnecting");
    const queued = conversation.prompt({ text: "queued behind it", delivery: "queue" });
    const queuedSettled = queued.then((result) => result, (error: unknown) => error);

    // The rejection is acted on while the reconnect is still held.
    const error = await within(refused.then(() => null, (reason: unknown) => reason), 2_000, "the refused prompt");
    expect(String(error)).toContain("acceptance rejected");
    expect(abandon.mock.calls.map(([turnId]) => turnId)).toEqual([refused.id]);
    expect(events.filter((event) => (event as any).turnId === refused.id && event.kind !== "message_status").map((event) => event.kind))
      .toEqual(["turn_started", "turn_failed"]);
    // The queued message has not started: its turn waits for the reconnect already in flight.
    expect(events.some((event) => event.kind === "turn_started" && (event as any).turnId === queued.id)).toBe(false);
    expect(reconnect).toHaveBeenCalledTimes(1);

    await writeFile(hold, "release");
    const next = await within(queuedSettled, 5_000, "the queued prompt") as { status?: string };
    expect(next.status).toBe("completed");
    // One reconnect served both: none was started a second time.
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.kind === "provider_reconnected")).toHaveLength(1);

    await within(conversation.stop(), 5_000, "stop");
    stopped = true;
    expect(unhandled).toEqual([]);
  }, 20_000);
});

describe("runs that are not valid", () => {
  test("the session refuses an empty run, a repeated, unknown, taken, still queued or out-of-order message id, and a turn id that is not the first message's", () => {
    const state: Record<string, RunMessageState> = {
      m1: { order: 1, dispatched: false, queued: false },
      m2: { order: 2, dispatched: false, queued: false },
      taken: { order: 3, dispatched: true, queued: false },
      waiting: { order: 4, dispatched: false, queued: true },
    };
    const known = (id: string) => state[id];
    const run = (turnId: string, messageIds: string[]) => ({ turnId, messageIds, messages: messageIds.map((id) => ({ id, text: id })), operationKind: "prompt" as const });
    expect(() => checkTurnRun(run("m1", []), known)).toThrow("at least one");
    expect(() => checkTurnRun(run("m1", ["m1", "m1"]), known)).toThrow("repeats message id m1");
    expect(() => checkTurnRun(run("m1", ["m1", "zz"]), known)).toThrow("does not know");
    expect(() => checkTurnRun(run("m1", ["m1", "taken"]), known)).toThrow("another run already took");
    expect(() => checkTurnRun(run("m1", ["m1", "waiting"]), known)).toThrow("still queued");
    expect(() => checkTurnRun(run("m2", ["m2", "m1"]), known)).toThrow("out of queue order");
    expect(() => checkTurnRun(run("m2", ["m1", "m2"]), known)).toThrow("not its first message");
    expect(() => checkTurnRun(run("m1", ["m1", "m2"]), known)).not.toThrow();
  });

  test("a run's ids come from the queued messages, combined or not", () => {
    const single = turnRunOf({ kind: "prompt", turnId: "m1", operationKind: "prompt", text: "x" } as any);
    expect(single).toEqual({ turnId: "m1", messageIds: ["m1"], messages: [{ id: "m1", text: "x", messageParts: undefined, attachments: undefined }], operationKind: "prompt" });
    const combined = turnRunOf({
      kind: "prompt", turnId: "m1", operationKind: "prompt", text: "x\ny",
      parts: [{ id: "m1", text: "x" }, { id: "m2", text: "y" }],
    } as any);
    expect(combined.messageIds).toEqual(["m1", "m2"]);
  });

  test("the controller rejects a run without a turn id or with a repeated message id, and reports turn_started inside send", async () => {
    const controller = new HarnessController({ adapter: { command: ["bun", ECHO] }, adapterId: "fixture" });
    const reported: TurnEvent[] = [];
    controller.subscribeTurns((event) => reported.push(event));
    expect(() => controller.send({ messageIds: ["m1"], messages: [{ id: "m1", text: "x" }], operationKind: "prompt" })).toThrow("requires its turnId");
    expect(() => controller.send({ turnId: "m1", messageIds: ["m1", "m1"], messages: [{ id: "m1", text: "x" }, { id: "m1", text: "x" }], operationKind: "prompt" })).toThrow("repeats");
    expect(() => controller.send({ turnId: "m1", messageIds: [], messages: [], operationKind: "prompt" })).toThrow("at least one");
    expect(reported).toEqual([]);

    const accepted = controller.send({ turnId: "m1", messageIds: ["m1", "m2"], messages: [{ id: "m1", text: "x" }, { id: "m2", text: "y" }], operationKind: "prompt" });
    expect(reported).toEqual([
      { kind: "turn_started", turnId: "m1", cause: { messageIds: ["m1", "m2"] }, sentBySession: true },
    ]);
    await expect(accepted).resolves.toBeUndefined();
    // Releasing it twice, or releasing a turn never reported, does nothing.
    controller.abandonTurn("m1", "test");
    controller.abandonTurn("m1", "test");
    controller.abandonTurn("never-reported", "test");
  });
});
