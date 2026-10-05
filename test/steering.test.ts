import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, AgentSession, type Adapter, type AgentSessionNotification } from "../src/index.ts";
import { AgentConversationQueue } from "../src/agent-conversation-queue.ts";
import { COMBINED_TEXT_SEPARATOR, combinePrompts, mergeHandlers, type SteeringPrompt } from "../src/steering/index.ts";

const FIXTURE = join(import.meta.dir, "fixtures/steer-agent.ts");
const adapter: Adapter = { command: ["bun", FIXTURE], displayName: "Steer fixture" };

const SEQUENTIAL = "Read a.txt, then b.txt, then c.txt, each with its own tool call, one at a time. Then tell me the three words in order.";
const STORY = "Write a detailed 400-word story about a lighthouse keeper named Ottoline.";
const LENGTHS = "Also include the length of each word in your final answer.";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function open(config: { busyDelivery?: "steer" | "queue" } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "steer-test-"));
  const session = await AgentSession.create({
    adapter,
    adapterId: "steer",
    agentSessionId: `steer-${Math.random().toString(36).slice(2)}`,
    cwd,
    defaultPermission: "approve",
    ...config,
  });
  const events: AgentSessionNotification["event"][] = [];
  session.subscribe((notification) => events.push(notification.event));
  cleanups.push(async () => {
    await session.stop().catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  });
  return { session, events };
}

const ofKind = (events: readonly { kind: string }[], kind: string) => events.filter((event) => event.kind === kind) as any[];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start a prompt and call `then` the first time a tool call is reported. */
function promptWithToolHook(session: AgentSession, text: string, then: () => void) {
  let fired = false;
  return session.prompt(text, {
    onActivity: (event) => {
      if (event.kind === "tool" && !fired) {
        fired = true;
        then();
      }
    },
  });
}

describe("steering: delivery at a tool boundary", () => {
  test("a steer message cancels the turn once a tool call settles, then continues the task", async () => {
    const { session, events } = await open();
    let steered!: ReturnType<AgentSession["prompt"]>;
    const first = promptWithToolHook(session, SEQUENTIAL, () => {
      steered = session.prompt({ text: LENGTHS, delivery: "steer" });
    });
    const firstResult = await first;
    const secondResult = await steered;

    expect(firstResult.stopReason).toBe("cancelled");
    expect(firstResult.endedBy).toBe("steer");
    expect(firstResult.followedBy).toEqual([steered.id]);
    expect(secondResult.stopReason).toBe("end_turn");
    expect(secondResult.text).toContain("kiwi (4), banana (6), fig (3)");
    expect(secondResult.endedBy).toBeUndefined();

    const pending = ofKind(events, "message_pending");
    expect(pending).toEqual([{ kind: "message_pending", id: steered.id, delivery: "steer" }]);
    const delivered = ofKind(events, "message_delivered");
    expect(delivered).toEqual([{ kind: "message_delivered", ids: [steered.id], via: "tool_boundary", turnId: steered.id }]);
  });

  test("a queue message waits for the turn to end and does not cancel it", async () => {
    const { session, events } = await open();
    let queued!: ReturnType<AgentSession["prompt"]>;
    const first = promptWithToolHook(session, SEQUENTIAL, () => {
      queued = session.prompt({ text: LENGTHS, delivery: "queue" });
    });
    const firstResult = await first;
    const secondResult = await queued;

    expect(firstResult.stopReason).toBe("end_turn");
    expect(firstResult.endedBy).toBeUndefined();
    expect(secondResult.stopReason).toBe("end_turn");
    expect(ofKind(events, "message_delivered")[0]).toMatchObject({ ids: [queued.id], via: "turn_end" });
  });

  test("busyDelivery sets the default for prompts that do not say", async () => {
    const { session } = await open({ busyDelivery: "steer" });
    let steered!: ReturnType<AgentSession["prompt"]>;
    const first = promptWithToolHook(session, SEQUENTIAL, () => {
      steered = session.prompt(LENGTHS);
    });
    expect((await first).endedBy).toBe("steer");
    await steered;
  });

  test("the default is queue", async () => {
    const { session } = await open();
    let waiting!: ReturnType<AgentSession["prompt"]>;
    const first = promptWithToolHook(session, SEQUENTIAL, () => {
      waiting = session.prompt(LENGTHS);
    });
    expect((await first).stopReason).toBe("end_turn");
    await waiting;
  });

  test("a text-only turn is not cut short by a steer message", async () => {
    const { session } = await open();
    const first = session.prompt(STORY);
    await sleep(100);
    const steered = session.prompt({ text: "Thanks.", delivery: "steer" });
    const firstResult = await first;
    expect(firstResult.stopReason).toBe("end_turn");
    expect(firstResult.endedBy).toBeUndefined();
    await steered;
  });

  test("a queue message ahead keeps its place: the steer message behind it does not cancel the turn", async () => {
    const { session, events } = await open();
    const order: string[] = [];
    let queued!: ReturnType<AgentSession["prompt"]>;
    let steered!: ReturnType<AgentSession["prompt"]>;
    const first = promptWithToolHook(session, SEQUENTIAL, () => {
      queued = session.prompt({ text: "Reply with just the word OK.", delivery: "queue", handlers: { onChunk: () => order.push("queued") } });
      steered = session.prompt({ text: LENGTHS, delivery: "steer", handlers: { onChunk: () => order.push("steered") } });
    });
    const firstResult = await first;
    await Promise.all([queued, steered]);
    expect(firstResult.stopReason).toBe("end_turn");
    expect(order.indexOf("queued")).toBeLessThan(order.indexOf("steered"));
    expect(ofKind(events, "message_delivered").map((event) => event.ids)).toEqual([[queued.id], [steered.id]]);
  });
});

describe("steering: interrupt, combining and withdrawing", () => {
  test("interrupt() cancels at any moment and the pending steer message is sent", async () => {
    const { session, events } = await open();
    const first = session.prompt(STORY);
    await sleep(150);
    const steered = session.prompt({ text: "Stop. Summarize in one sentence what you wrote so far.", delivery: "steer" });
    session.interrupt();
    const firstResult = await first;
    const secondResult = await steered;
    expect(firstResult.stopReason).toBe("cancelled");
    expect(firstResult.endedBy).toBe("interrupt");
    expect(firstResult.followedBy).toEqual([steered.id]);
    expect(secondResult.text).toContain("Ottoline");
    expect(ofKind(events, "message_delivered")[0]).toMatchObject({ via: "interrupt" });
  });

  test("consecutive steer messages are sent as one prompt, with every promise settling on the same result", async () => {
    const { session, events } = await open();
    const seen: string[] = [];
    let a!: ReturnType<AgentSession["prompt"]>;
    let b!: ReturnType<AgentSession["prompt"]>;
    const first = promptWithToolHook(session, SEQUENTIAL, () => {
      a = session.prompt({ text: LENGTHS, delivery: "steer", handlers: { onChunk: (text) => seen.push(`a:${text}`) } });
      b = session.prompt({
        text: "No, actually, only report the length of the longest word.",
        delivery: "steer",
        handlers: { onChunk: (text) => seen.push(`b:${text}`) },
      });
    });
    const firstResult = await first;
    const [ra, rb] = await Promise.all([a, b]);
    expect(firstResult.followedBy).toEqual([a.id, b.id]);
    expect(ra).toBe(rb);
    expect(ra.operationId).toBe(a.id);
    expect(ra.text).toContain("banana (6)");
    expect(ofKind(events, "message_delivered")).toEqual([
      { kind: "message_delivered", ids: [a.id, b.id], via: "tool_boundary", turnId: a.id },
    ]);
    // Both messages' handlers saw the same turn.
    expect(seen.some((entry) => entry.startsWith("a:"))).toBe(true);
    expect(seen.some((entry) => entry.startsWith("b:"))).toBe(true);
  });

  test("withdraw() takes a pending message back and its promise settles as cancelled", async () => {
    const { session, events } = await open();
    let pending!: ReturnType<AgentSession["prompt"]>;
    const first = promptWithToolHook(session, SEQUENTIAL, () => {
      pending = session.prompt({ text: LENGTHS, delivery: "steer" });
      expect(session.pendingMessages.map((message) => message.id)).toEqual([pending.id]);
      expect(pending.withdraw()).toBe(true);
      expect(pending.withdraw()).toBe(false);
      expect(session.pendingMessages).toEqual([]);
    });
    const firstResult = await first;
    const withdrawn = await pending;
    expect(firstResult.stopReason).toBe("end_turn");
    expect(withdrawn).toMatchObject({ stopReason: "cancelled", status: "cancelled", usage: null, metering: null });
    expect(ofKind(events, "message_withdrawn")).toEqual([{ kind: "message_withdrawn", id: pending.id }]);
    expect(ofKind(events, "message_delivered")).toEqual([]);
  });

  test("interrupt({ clearQueue }) drops pending messages like queued prompts", async () => {
    const { session, events } = await open();
    let pending!: ReturnType<AgentSession["prompt"]>;
    const first = promptWithToolHook(session, SEQUENTIAL, () => {
      pending = session.prompt({ text: LENGTHS, delivery: "steer" });
      session.interrupt({ clearQueue: true });
    });
    const firstResult = await first;
    const dropped = await pending;
    expect(firstResult.stopReason).toBe("cancelled");
    expect(firstResult.endedBy).toBe("interrupt");
    expect(firstResult.followedBy).toBeUndefined();
    expect(dropped.stopReason).toBe("cancelled");
    expect(ofKind(events, "message_withdrawn")).toEqual([{ kind: "message_withdrawn", id: pending.id }]);
  });

  test("a prompt that does not wait emits no message events", async () => {
    const { session, events } = await open();
    await session.prompt("Reply with just the word OK.");
    expect(ofKind(events, "message_pending")).toEqual([]);
    expect(ofKind(events, "message_delivered")).toEqual([]);
  });
});

describe("steering: what a combined prompt records", () => {
  test("each original message is stored as sent, with its participant and metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "steer-agent-"));
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { steer: adapter },
      defaultAdapterId: "steer",
      conversationDefaults: { cwd: directory, defaultPermission: "approve" },
    });
    cleanups.push(async () => {
      await agent.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    });
    const conversation = await agent.conversations.create();
    let b!: ReturnType<typeof conversation.promptFrom>;
    let c!: ReturnType<typeof conversation.promptFrom>;
    let fired = false;
    const first = conversation.prompt(SEQUENTIAL, {
      onActivity: (event) => {
        if (event.kind !== "tool" || fired) return;
        fired = true;
        b = conversation.promptFrom({ participantId: "agent-b", text: "(agent b) I finished this thing", delivery: "steer", consumerMetadata: { sender: "b" } });
        c = conversation.promptFrom({ participantId: "agent-c", text: "(agent c) I had a problem", delivery: "steer", consumerMetadata: { sender: "c" } });
      },
    });
    await first;
    const result = await b;
    await c;

    const records = (await agent.persistence.records.list(conversation.id, { limit: 1000 })).records;
    const users = records.filter((record) => record.kind === "message" && record.role === "user") as any[];
    expect(users.map((record) => record.content)).toEqual([
      SEQUENTIAL,
      "(agent b) I finished this thing",
      "(agent c) I had a problem",
    ]);
    expect(users[1].participantId).toBe("agent-b");
    expect(users[1].consumerMetadata).toEqual({ sender: "b" });
    expect(users[2].participantId).toBe("agent-c");
    expect(users[2].consumerMetadata).toEqual({ sender: "c" });
    // The two messages were one operation: the same operation id on both records.
    expect(users[1].recordId).toBe(`${result.operationId}:user`);
    expect(users[2].recordId).toBe(`${result.operationId}:user:2`);
  });
});

describe("a cancel that loses the race with the end of the turn", () => {
  test("the turn is complete, not cancelled, and nothing says it was interrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "steer-agent-"));
    process.env.STEER_AGENT_IGNORE_CANCEL = "1";
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { steer: adapter },
      defaultAdapterId: "steer",
      conversationDefaults: { cwd: directory, defaultPermission: "approve" },
    });
    cleanups.push(async () => {
      delete process.env.STEER_AGENT_IGNORE_CANCEL;
      await agent.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    });
    const conversation = await agent.conversations.create();
    const result = await conversation.prompt("Reply with just the word OK.", {
      onChunk: () => conversation.interrupt(),
    });
    // The provider ignored the cancel and ended the turn normally; that is what is reported and stored.
    expect(result.stopReason).toBe("end_turn");
    expect(result.status).toBe("completed");
    expect(result.endedBy).toBeUndefined();
    const records = (await agent.persistence.records.list(conversation.id, { limit: 1000 })).records;
    const assistant = records.filter((record) => record.kind === "message" && record.role === "assistant") as any[];
    expect(assistant.length).toBeGreaterThan(0);
    expect(assistant.at(-1).status).toBe("completed");
  });
});

describe("agent extension notifications", () => {
  test("an unknown vendor notification is ignored quietly", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { session } = await open();
      await session.prompt("Reply with just the word OK.");
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("steering building blocks", () => {
  const prompt = (id: string, text: string, extra: Partial<SteeringPrompt> = {}): SteeringPrompt => ({
    kind: "prompt",
    turnId: id,
    operationKind: "prompt",
    delivery: "steer",
    waited: true,
    text,
    resolve: () => {},
    reject: () => {},
    ...extra,
  });

  test("combinePrompts joins the texts in order and keeps each original as a part", () => {
    const resolved: string[] = [];
    const combined = combinePrompts([
      prompt("a", "one", { participantId: "p1", resolve: () => resolved.push("a") }),
      prompt("b", "two", { consumerMetadata: { n: 2 }, resolve: () => resolved.push("b") }),
    ]);
    expect(combined.turnId).toBe("a");
    expect(combined.text).toBe(`one${COMBINED_TEXT_SEPARATOR}two`);
    expect(combined.parts).toEqual([
      { id: "a", text: "one", participantId: "p1" },
      { id: "b", text: "two", consumerMetadata: { n: 2 } },
    ]);
    combined.resolve({} as never);
    expect(resolved).toEqual(["a", "b"]);
  });

  test("combinePrompts returns a single prompt unchanged", () => {
    const only = prompt("a", "one");
    expect(combinePrompts([only])).toBe(only);
    expect(combinePrompts([only]).parts).toBeUndefined();
  });

  test("combinePrompts concatenates attachments", () => {
    const one = { type: "image", data: "1" } as never;
    const two = { type: "image", data: "2" } as never;
    const combined = combinePrompts([prompt("a", "x", { attachments: [one] }), prompt("b", "y", { attachments: [two] })]);
    expect(combined.attachments).toEqual([one, two]);
  });

  test("mergeHandlers calls every handler and lets the first permission handler decide", () => {
    const calls: string[] = [];
    const merged = mergeHandlers([
      { onChunk: () => calls.push("1") },
      { onChunk: () => calls.push("2"), onPermissionRequest: () => ({ outcome: "cancelled" }) },
      { onPermissionRequest: () => ({ outcome: "selected", optionId: "x" }) },
    ])!;
    merged.onChunk!("hi");
    expect(calls).toEqual(["1", "2"]);
    expect(merged.onPermissionRequest!({} as never)).toEqual({ outcome: "cancelled" });
    expect(mergeHandlers([undefined, undefined])).toBeUndefined();
  });

  test("the queue exposes its head, a copy, removal and a run from the head", () => {
    const queue = new AgentConversationQueue<number>();
    [1, 2, 3, 10, 4].forEach((value) => queue.enqueue(value));
    expect(queue.peek()).toBe(1);
    expect(queue.snapshot()).toEqual([1, 2, 3, 10, 4]);
    expect(queue.takeWhile((value) => value < 5)).toEqual([1, 2, 3]);
    expect(queue.remove((value) => value === 4)).toBe(4);
    expect(queue.remove((value) => value === 99)).toBeUndefined();
    expect(queue.snapshot()).toEqual([10]);
  });
});
