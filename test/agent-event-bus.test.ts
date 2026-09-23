import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Agent,
  type AgentConversationId,
  type AgentEventNotification,
  type AgentIdentityRuntime,
  type AgentSessionId,
  type ConversationRecord,
  type ConversationRecordCaptureConfig,
  type ConversationRecordKind,
} from "../src/index.ts";
import { createAgentConversationId } from "../src/agent-ids.ts";
import {
  CONVERSATION_CHECKPOINT_STRATEGY_ID,
  ConversationCheckpointStrategy,
} from "../src/checkpointing/strategy.ts";
import type { InternalInferenceRuntime } from "../src/internal-inference/contracts.ts";
import { CommittedRecordEventBus } from "../src/observation/agent-event-bus.ts";

const OPERATIONS_AGENT = resolve(import.meta.dir, "../smoke-tests/test5-operations/operations-agent.ts");
const PRESENTATION_AGENT = resolve(import.meta.dir, "fixtures/presentation-agent.ts");
const agents: Agent[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.close()));
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

function messageRecord(input: {
  readonly recordId: string;
  readonly sequence: number;
  readonly conversationId?: string;
  readonly role?: "assistant" | "user";
  readonly content?: string;
}): ConversationRecord {
  return Object.freeze({
    recordId: input.recordId,
    agentSessionId: "ags-unit" as AgentSessionId,
    agentConversationId: (input.conversationId ?? "agc-unit") as AgentConversationId,
    sequence: input.sequence,
    kind: "message",
    timestamp: new Date(0).toISOString(),
    role: input.role ?? "assistant",
    content: input.content ?? "hello",
    status: "completed",
  });
}

function meteringRecord(input: {
  readonly recordId: string;
  readonly sequence: number;
  readonly conversationId?: string;
}): ConversationRecord {
  return Object.freeze({
    recordId: input.recordId,
    agentSessionId: "ags-unit" as AgentSessionId,
    agentConversationId: (input.conversationId ?? "agc-unit") as AgentConversationId,
    sequence: input.sequence,
    kind: "metering",
    timestamp: new Date(0).toISOString(),
    operationId: `op-${input.recordId}`,
    meteringRecordId: `op-${input.recordId}`,
    status: "available",
  });
}

function unitBus() {
  const errors: unknown[] = [];
  const bus = new CommittedRecordEventBus({
    agentSessionId: "ags-unit" as AgentSessionId,
    onListenerError: ({ error }) => errors.push(error),
  });
  return { bus, errors };
}

describe("CommittedRecordEventBus", () => {
  test("a default subscription receives every record in ascending sequence order", () => {
    const { bus } = unitBus();
    const seen: AgentEventNotification[] = [];
    bus.subscribe((notification) => seen.push(notification));

    bus.publish([
      messageRecord({ recordId: "second", sequence: 2 }),
      messageRecord({ recordId: "first", sequence: 1 }),
    ]);

    expect(seen.map((notification) => notification.event.record.recordId)).toEqual(["first", "second"]);
    expect(seen.map((notification) => notification.deliverySequence)).toEqual([1, 2]);
    expect(seen.every((notification) => notification.event.kind === "conversation_record_committed")).toBe(true);
    expect(seen.every((notification) => notification.agentSessionId === "ags-unit")).toBe(true);
  });

  test("conversation and record-kind filters are independent per subscriber", () => {
    const { bus } = unitBus();
    const seenA: string[] = [];
    const seenB: string[] = [];
    bus.subscribe((notification) => seenA.push(notification.event.record.recordId), {
      conversationIds: ["agc-a" as AgentConversationId],
    });
    bus.subscribe((notification) => seenB.push(notification.event.record.recordId), {
      recordKinds: ["metering"],
    });

    bus.publish([
      messageRecord({ recordId: "a-msg", sequence: 1, conversationId: "agc-a" }),
      messageRecord({ recordId: "b-msg", sequence: 1, conversationId: "agc-b" }),
      meteringRecord({ recordId: "a-meter", sequence: 2, conversationId: "agc-a" }),
    ]);

    expect(seenA).toEqual(["a-msg", "a-meter"]);
    expect(seenB).toEqual(["a-meter"]);
  });

  test("an empty filter selects nothing and an unknown kind fails at subscription", () => {
    const { bus } = unitBus();
    const seen: string[] = [];
    bus.subscribe((notification) => seen.push(notification.event.record.recordId), {
      conversationIds: [],
    });
    bus.subscribe((notification) => seen.push(notification.event.record.recordId), {
      recordKinds: [],
    });
    bus.publish([messageRecord({ recordId: "a", sequence: 1 })]);
    expect(seen).toEqual([]);

    expect(() => bus.subscribe(() => {}, {
      recordKinds: ["not_a_kind" as ConversationRecordKind],
    })).toThrow(/unknown record kind/);
  });

  test("registration order is stable and a throwing listener cannot block another", () => {
    const { bus, errors } = unitBus();
    const order: string[] = [];
    bus.subscribe(() => {
      order.push("first");
      throw new Error("intentional listener failure");
    });
    bus.subscribe(() => order.push("second"));

    bus.publish([messageRecord({ recordId: "a", sequence: 1 })]);

    expect(order).toEqual(["first", "second"]);
    expect(errors).toHaveLength(1);
  });

  test("unsubscribe is idempotent and close stops delivery", () => {
    const { bus } = unitBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((notification) => seen.push(notification.event.record.recordId));

    bus.publish([messageRecord({ recordId: "before", sequence: 1 })]);
    unsubscribe();
    unsubscribe();
    bus.publish([messageRecord({ recordId: "after-unsubscribe", sequence: 2 })]);
    expect(seen).toEqual(["before"]);

    bus.subscribe((notification) => seen.push(notification.event.record.recordId));
    bus.close();
    bus.publish([messageRecord({ recordId: "after-close", sequence: 3 })]);
    expect(seen).toEqual(["before"]);
  });
});

async function openAgent(options: {
  capture?: ConversationRecordCaptureConfig;
  adapter?: "operations" | "presentation";
  audit?: boolean;
} = {}): Promise<{ agent: Agent; path: string }> {
  const directory = await makeDirectory();
  const path = join(directory, "agent.sqlite");
  const agent = await track(Agent.open({
    persistence: { kind: "sqlite", path },
    adapters: {
      operations: { command: ["bun", OPERATIONS_AGENT, "owned"] },
      presentation: { command: ["bun", PRESENTATION_AGENT] },
    },
    defaultAdapterId: options.adapter ?? "operations",
    ...(options.capture ? { capture: options.capture } : {}),
    ...(options.audit ? { auditLog: { directory: join(directory, "audit") } } : {}),
  }));
  return { agent, path };
}

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acp-agent-events-"));
  directories.push(directory);
  return directory;
}

async function track(agentPromise: Promise<Agent>): Promise<Agent> {
  const agent = await agentPromise;
  agents.push(agent);
  return agent;
}

describe("Agent committed-record events", () => {
  test("a prompt publishes the exact persisted records for its conversation", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    const seen: ConversationRecord[] = [];
    agent.events.subscribe((notification) => seen.push(notification.event.record), {
      conversationIds: [conversation.id],
    });

    await conversation.prompt("hello there");

    const persisted = (await agent.persistence.records.list(conversation.id, { limit: 1_000 })).records;
    const byId = new Map(persisted.map((record) => [record.recordId, record]));
    for (const record of seen) {
      const stored = byId.get(record.recordId);
      expect(stored).toBeDefined();
      expect(stored?.sequence).toBe(record.sequence);
      expect(stored?.kind).toBe(record.kind);
    }
    expect(seen.some((record) => record.kind === "message" && record.role === "user")).toBe(true);
    expect(seen.some(
      (record) => record.kind === "message" && record.role === "assistant" && record.status === "completed",
    )).toBe(true);
  });

  test("a rolled-back transaction emits nothing", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    const seen: ConversationRecord[] = [];
    agent.events.subscribe((notification) => seen.push(notification.event.record), {
      conversationIds: [conversation.id],
    });

    const backend = agent.persistence;
    const originalTransaction = backend.transaction.bind(backend);
    let failProviderAppend = true;
    backend.transaction = async (work) => await originalTransaction(async (scope) => {
      const providerSessions = new Proxy(scope.providerSessions, {
        get(target, property, receiver) {
          if (property !== "append") return Reflect.get(target, property, receiver);
          return async (...args: Parameters<typeof target.append>) => {
            if (failProviderAppend) {
              failProviderAppend = false;
              throw new Error("intentional rollback");
            }
            return await target.append(...args);
          };
        },
      });
      return await work(Object.freeze({ ...scope, providerSessions }));
    });

    await expect(conversation.prompt("roll back the turn")).rejects.toThrow("intentional rollback");
    backend.transaction = originalTransaction;

    // The final assistant records were appended inside the transaction that rolled back, so
    // they are neither emitted nor readable. Every emitted record is one that committed —
    // including the streaming snapshot, which commits in its own earlier transaction.
    const persisted = (await agent.persistence.records.list(conversation.id, { limit: 1_000 })).records;
    const persistedIds = new Set(persisted.map((record) => record.recordId));
    for (const record of seen) expect(persistedIds.has(record.recordId)).toBe(true);
    expect(seen.some(
      (record) => record.kind === "message" && record.role === "assistant" && record.status === "completed",
    )).toBe(false);
  });

  test("a listener's persistence read sees the record that triggered it", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    let resolveRead!: (value: { completedId: string; readIds: readonly string[] }) => void;
    const readDone = new Promise<{ completedId: string; readIds: readonly string[] }>((resolve) => {
      resolveRead = resolve;
    });
    agent.events.subscribe((notification) => {
      const record = notification.event.record;
      if (record.kind !== "message" || record.role !== "assistant" || record.status !== "completed") return;
      const completedId = record.recordId;
      // Issued from inside a listener. If listeners ran inside the write transaction this
      // read could not observe the record that had just been appended.
      void agent.persistence.records.list(conversation.id, { limit: 100 }).then((page) => {
        resolveRead({ completedId, readIds: page.records.map((item) => item.recordId) });
      });
    }, { conversationIds: [conversation.id] });

    await conversation.prompt("reentrant read");
    const { completedId, readIds } = await readDone;

    expect(readIds).toContain(completedId);
  });

  test("streaming revisions are each emitted and reconcile with a reload", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    const assistant: ConversationRecord[] = [];
    agent.events.subscribe((notification) => {
      const record = notification.event.record;
      if (record.kind === "message" && record.role === "assistant") assistant.push(record);
    }, { conversationIds: [conversation.id] });

    await conversation.prompt("stream a reply");

    expect(assistant.length).toBeGreaterThanOrEqual(2);
    const logicalIds = new Set(assistant.map((record) => record.kind === "message" ? record.logicalMessageId : null));
    expect(logicalIds.size).toBe(1);
    const last = assistant.at(-1);
    expect(last?.kind).toBe("message");
    expect(last?.kind === "message" ? last.status : undefined).toBe("completed");

    const persisted = (await agent.persistence.records.list(conversation.id, {
      kinds: ["message"],
      limit: 1_000,
    })).records;
    const latest = persisted.at(-1);
    expect(latest?.recordId).toBe(assistant.at(-1)?.recordId);
  });

  test("tool-call revisions are each emitted and reconcile with a reload", async () => {
    const { agent } = await openAgent({ adapter: "presentation" });
    const conversation = await agent.conversations.create();
    const tools: ConversationRecord[] = [];
    agent.events.subscribe((notification) => {
      if (notification.event.record.kind === "tool_call") tools.push(notification.event.record);
    }, { conversationIds: [conversation.id] });

    await conversation.prompt("use a tool");

    expect(tools.length).toBeGreaterThanOrEqual(1);
    const persisted = (await agent.persistence.records.list(conversation.id, {
      kinds: ["tool_call"],
    })).records;
    expect(tools.map((record) => record.recordId)).toEqual(persisted.map((record) => record.recordId));
  });

  test("metadata capture emits the persisted metadata projection", async () => {
    const { agent } = await openAgent({ capture: { message: "metadata" } });
    const conversation = await agent.conversations.create();
    const seen: ConversationRecord[] = [];
    agent.events.subscribe((notification) => seen.push(notification.event.record), {
      recordKinds: ["message"],
      conversationIds: [conversation.id],
    });

    await conversation.prompt("secret content");

    const assistant = seen.filter((record) => record.kind === "message" && record.role === "assistant");
    expect(assistant.length).toBeGreaterThan(0);
    for (const record of assistant) {
      expect(record.kind === "message" && record.content).toBe("");
    }
  });

  test("capture none emits no canonical message event", async () => {
    const { agent } = await openAgent({ capture: { message: "none" } });
    const conversation = await agent.conversations.create();
    const seen: ConversationRecord[] = [];
    agent.events.subscribe((notification) => seen.push(notification.event.record), {
      recordKinds: ["message"],
      conversationIds: [conversation.id],
    });

    await conversation.prompt("not persisted");

    expect(seen).toEqual([]);
  });

  test("an audit-only observation emits no canonical event", async () => {
    const { agent } = await openAgent({ capture: { message: "none" }, audit: true });
    const conversation = await agent.conversations.create();
    const seen: ConversationRecord[] = [];
    agent.events.subscribe((notification) => seen.push(notification.event.record), {
      recordKinds: ["message"],
      conversationIds: [conversation.id],
    });

    await conversation.prompt("audit only");

    expect(seen).toEqual([]);
    const state = await agent.persistence.auditOutbox!.state();
    expect(state?.lastAllocatedSequence ?? 0).toBeGreaterThan(0);
  });

  test("metering references are published through the same path", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    const metering: ConversationRecord[] = [];
    agent.events.subscribe((notification) => {
      if (notification.event.record.kind === "metering") metering.push(notification.event.record);
    }, { conversationIds: [conversation.id] });

    await conversation.prompt("meter this");

    expect(metering.length).toBeGreaterThan(0);
    const persisted = (await agent.persistence.records.list(conversation.id, {
      kinds: ["metering"],
    })).records;
    expect(metering.map((record) => record.recordId)).toEqual(persisted.map((record) => record.recordId));
  });

  test("a checkpoint completion record is published through the bus", async () => {
    const directory = await makeDirectory();
    const runtime: InternalInferenceRuntime = {
      async run(request, _signal, lifecycle) {
        await lifecycle?.sessionStarted({
          internalSessionId: `summary-${request.internalInferenceId}`,
          model: "test",
        });
        return {
          internalInferenceId: request.internalInferenceId,
          internalSessionId: `summary-${request.internalInferenceId}`,
          adapterId: request.adapterId,
          model: "test",
          messages: [{ type: "text", text: "checkpoint summary" }],
          usage: null,
        };
      },
    };
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { test: { command: ["unused"] } },
      defaultAdapterId: "test",
      internalInference: { runtime, strategies: [new ConversationCheckpointStrategy()] },
    }));
    const conversationId = createAgentConversationId();
    await agent.persistence.conversations.create({
      agentSessionId: agent.id,
      agentConversationId: conversationId,
    });
    await agent.persistence.records.appendMany([
      {
        recordId: "checkpoint-source-user",
        agentSessionId: agent.id,
        agentConversationId: conversationId,
        kind: "message",
        timestamp: new Date().toISOString(),
        role: "user",
        content: "hello",
      },
      {
        recordId: "checkpoint-source-assistant",
        agentSessionId: agent.id,
        agentConversationId: conversationId,
        kind: "message",
        timestamp: new Date().toISOString(),
        role: "assistant",
        content: "hi",
      },
    ]);

    const checkpoints: ConversationRecord[] = [];
    agent.events.subscribe((notification) => {
      const record = notification.event.record;
      if (record.kind === "native_action" && record.action === "conversation_checkpoint") {
        checkpoints.push(record);
      }
    }, { conversationIds: [conversationId] });

    const run = await agent.internalInferences!.enqueue({
      purpose: "conversation_checkpoint",
      agentConversationId: conversationId,
      input: {
        strategyId: CONVERSATION_CHECKPOINT_STRATEGY_ID,
        version: 1,
        payload: { instruction: "Summarize for continuation." },
      },
      sourceFromSequence: 0,
      sourceThroughSequence: 2,
      requestedThroughSequence: 2,
    });
    await run.result;

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      kind: "native_action",
      action: "conversation_checkpoint",
      state: "completed",
    });
    const persisted = (await agent.persistence.records.list(conversationId, {
      kinds: ["native_action"],
    })).records;
    expect(persisted.map((record) => record.recordId)).toContain(checkpoints[0]!.recordId);
  });

  test("concurrent conversations preserve each conversation's own sequence order", async () => {
    const { agent } = await openAgent();
    const left = await agent.conversations.create();
    const right = await agent.conversations.create();
    const leftSeen: number[] = [];
    const rightSeen: number[] = [];
    agent.events.subscribe((notification) => {
      if (notification.event.record.agentConversationId === left.id) leftSeen.push(notification.event.record.sequence);
    });
    agent.events.subscribe((notification) => {
      if (notification.event.record.agentConversationId === right.id) rightSeen.push(notification.event.record.sequence);
    });

    await Promise.all([left.prompt("left"), right.prompt("right")]);

    expect(leftSeen.length).toBeGreaterThan(0);
    expect(rightSeen.length).toBeGreaterThan(0);
    for (const sequences of [leftSeen, rightSeen]) {
      expect([...sequences]).toEqual([...sequences].sort((a, b) => a - b));
    }
  });

  test("a throwing subscriber cannot fail a prompt and does not stop other subscribers", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    const seen: string[] = [];
    agent.events.subscribe(() => {
      throw new Error("intentional subscriber failure");
    });
    agent.events.subscribe((notification) => seen.push(notification.event.record.recordId));

    const result = await conversation.prompt("survive the subscriber");

    expect(result.status).toBe("completed");
    expect(seen.length).toBeGreaterThan(0);
  });

  test("an event is published even when a later identity update fails", async () => {
    let failAssistantUpdate = true;
    const identity: AgentIdentityRuntime = {
      async load() {
        return { promptPreamble: "" };
      },
      async update(input) {
        if (
          failAssistantUpdate
          && input.records.some((record) => record.kind === "message" && record.role === "assistant")
        ) {
          throw new Error("intentional identity failure");
        }
      },
    };
    const directory = await makeDirectory();
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { operations: { command: ["bun", OPERATIONS_AGENT, "owned"] } },
      defaultAdapterId: "operations",
      identity,
    }));
    const conversation = await agent.conversations.create();
    const completed: ConversationRecord[] = [];
    agent.events.subscribe((notification) => {
      const record = notification.event.record;
      if (record.kind === "message" && record.role === "assistant" && record.status === "completed") {
        completed.push(record);
      }
    }, { conversationIds: [conversation.id] });

    await expect(conversation.prompt("publish before identity fails")).rejects.toThrow(
      "intentional identity failure",
    );
    // Publication follows the commit and precedes the identity projection, so a failing
    // identity update must not suppress an event for a record that already committed.
    expect(completed.length).toBeGreaterThan(0);
    failAssistantUpdate = false;
  });

  test("a consumer-direct append is not observed by the Agent bus", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    const seen: ConversationRecord[] = [];
    agent.events.subscribe((notification) => seen.push(notification.event.record), {
      conversationIds: [conversation.id],
    });

    await agent.persistence.records.append({
      recordId: "direct-append",
      agentSessionId: agent.id,
      agentConversationId: conversation.id,
      kind: "message",
      timestamp: new Date().toISOString(),
      role: "user",
      content: "written outside the Agent",
      status: "completed",
    });

    expect(seen).toEqual([]);
  });

  test("closing the Agent clears subscriptions and publishes nothing afterward", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    const seen: string[] = [];
    agent.events.subscribe((notification) => seen.push(notification.event.record.recordId));

    await agent.close();
    agents.splice(agents.indexOf(agent), 1);

    agent.publishCommittedRecords([messageRecord({
      recordId: "after-close",
      sequence: 1,
      conversationId: conversation.id,
    })]);
    expect(seen).toEqual([]);
  });
});
