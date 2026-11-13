/**
 * The turn path through `send`, `prepareTurn` and `abandonTurn` (controller-interface spec,
 * Brief A2 step 4): the cause of a combined steer run, a turn released when it never reaches the
 * provider, completion only after finalization, the queue waiting for finalization, and invalid runs.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "../../src/agent.ts";
import type { AgentSession } from "../../src/agent-session.ts";
import type { AgentSessionNotification } from "../../src/agent-conversation-contracts.ts";
import type { AgentConversationOwnerLifecycle } from "../../src/agent-conversation-owner.ts";
import { AgentController } from "../../src/controller.ts";
import type { TurnEvent } from "../../src/conversation-controller/contracts.ts";
import { checkTurnRun, turnRunOf } from "../../src/conversation-turns/index.ts";

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
    conversationDefaults: { metering: { pricing: false }, env, cwd: directory, defaultPermission: "approve" },
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

describe("the turn path through send", () => {
  test("a combined steer run's cause lists both message ids; record ids stay keyed by the turn", async () => {
    const { agent, conversation, events } = await agentConversation(STEER);
    let a!: ReturnType<AgentSession["prompt"]>;
    let b!: ReturnType<AgentSession["prompt"]>;
    let fired = false;
    const first = conversation.prompt(SEQUENTIAL, {
      onActivity: (event) => {
        if (event.kind !== "tool" || fired) return;
        fired = true;
        a = conversation.prompt({ text: "Also include the length of each word in your final answer.", delivery: "steer" });
        b = conversation.prompt({ text: "No, actually, only report the length of the longest word.", delivery: "steer" });
      },
    });
    await first;
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);

    const started = ofKind(events, "turn_started");
    expect(started).toEqual([
      { kind: "turn_started", turnId: first.id, cause: { kind: "messages", messageIds: [first.id] } },
      { kind: "turn_started", turnId: a.id, cause: { kind: "messages", messageIds: [a.id, b.id] } },
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
    let configured!: Promise<void>;
    lifecycle.afterPrompt = async (input) => {
      order.push("afterPrompt:start");
      // Queued while this turn finalizes. Give it a window (bounded: 100 ms) in which it would
      // start if the queue did not wait for finalization.
      configured = conversation.setConfig("model", "beta");
      await Bun.sleep(100);
      const committed = await afterPrompt(input);
      order.push("afterPrompt:end");
      return committed;
    };
    cleanups.push(async () => { lifecycle.afterPrompt = afterPrompt; });

    await conversation.prompt("a turn with a slow finalization");
    await configured;
    expect(order).toEqual(["afterPrompt:start", "afterPrompt:end", "turn_completed", "configuration_started"]);
    expect(ofKind(events, "configuration_completed")).toHaveLength(1);
  }, 20_000);
});

describe("runs that are not valid", () => {
  test("the session refuses an empty run, a repeated or unknown message id, and a turn id that is not the first message's", () => {
    const known = (id: string) => ["m1", "m2"].includes(id);
    expect(() => checkTurnRun({ turnId: "m1", messageIds: [], operationKind: "prompt" }, known)).toThrow("at least one");
    expect(() => checkTurnRun({ turnId: "m1", messageIds: ["m1", "m1"], operationKind: "prompt" }, known)).toThrow("repeats message id m1");
    expect(() => checkTurnRun({ turnId: "m1", messageIds: ["m1", "zz"], operationKind: "prompt" }, known)).toThrow("does not know");
    expect(() => checkTurnRun({ turnId: "m2", messageIds: ["m1", "m2"], operationKind: "prompt" }, known)).toThrow("not its first message");
    expect(() => checkTurnRun({ turnId: "m1", messageIds: ["m1", "m2"], operationKind: "prompt" }, known)).not.toThrow();
  });

  test("a run's ids come from the queued messages, combined or not", () => {
    const single = turnRunOf({ kind: "prompt", turnId: "m1", operationKind: "prompt", text: "x" } as any);
    expect(single).toEqual({ turnId: "m1", messageIds: ["m1"], operationKind: "prompt" });
    const combined = turnRunOf({
      kind: "prompt", turnId: "m1", operationKind: "prompt", text: "x\ny",
      parts: [{ id: "m1", text: "x" }, { id: "m2", text: "y" }],
    } as any);
    expect(combined.messageIds).toEqual(["m1", "m2"]);
  });

  test("the controller rejects a run without a turn id or with a repeated message id, and reports turn_started inside send", async () => {
    const controller = new AgentController({ adapter: { command: ["bun", ECHO] }, adapterId: "fixture" });
    const reported: TurnEvent[] = [];
    controller.subscribeTurns((event) => reported.push(event));
    expect(() => controller.send({ messageIds: ["m1"], operationKind: "prompt" })).toThrow("requires its turnId");
    expect(() => controller.send({ turnId: "m1", messageIds: ["m1", "m1"], operationKind: "prompt" })).toThrow("repeats");
    expect(() => controller.send({ turnId: "m1", messageIds: [], operationKind: "prompt" })).toThrow("at least one");
    expect(reported).toEqual([]);

    const accepted = controller.send({ turnId: "m1", messageIds: ["m1", "m2"], operationKind: "prompt" });
    expect(reported).toEqual([
      { kind: "turn_started", turnId: "m1", cause: { kind: "messages", messageIds: ["m1", "m2"] }, sentBySession: true },
    ]);
    await expect(accepted).resolves.toBeUndefined();
    // Releasing it twice, or releasing a turn never reported, does nothing.
    controller.abandonTurn("m1", "test");
    controller.abandonTurn("m1", "test");
    controller.abandonTurn("never-reported", "test");
  });
});
