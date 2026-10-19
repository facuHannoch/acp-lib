import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Agent,
  AgentAuditLogReader,
  type AgentIdentityRuntime,
  type IdentityLoadInput,
  type IdentityUpdateInput,
  type LoadedIdentityContext,
} from "../src/index.ts";
import { AgentSessionHandoffError } from "../src/metering/record.ts";

const OPERATIONS_AGENT = resolve(import.meta.dir, "../smoke-tests/test5-operations/operations-agent.ts");
const PRESENTATION_AGENT = resolve(import.meta.dir, "fixtures/presentation-agent.ts");
const PERMISSION_ORDER_AGENT = resolve(import.meta.dir, "fixtures/permission-order-agent.ts");
const CONFIG_AGENT = resolve(import.meta.dir, "fixtures/config-agent.ts");
const TERMINAL_AGENT = resolve(import.meta.dir, "fixtures/terminal-agent.ts");
const IDENTITY_AGENT = resolve(import.meta.dir, "fixtures/identity-agent.ts");
const PTY_AGENT = resolve(import.meta.dir, "fixtures/idle-pty-agent.ts");
const agents: Agent[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.close()));
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("Agent owner", () => {
  test("keeps a newly created provider attachment runtime-only until a completed prompt", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    const conversationId = conversation.id;

    expect(conversation.internalSessionId).not.toBeNull();
    expect(await agent.persistence.providerSessions.active(conversationId)).toBeNull();

    await conversation.stop();
    expect(conversation.providerAttachmentState.kind).toBe("absent");
    expect(await agent.persistence.providerSessions.active(conversationId)).toBeNull();
    const reopened = await agent.conversations.open(conversationId);
    expect(reopened.providerSession).toBe("new");
    expect(await agent.persistence.providerSessions.active(conversationId)).toBeNull();
  });

  test("records the provider attachment once and does not rotate it on load", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    const conversationId = conversation.id;
    await conversation.prompt("confirm this provider attachment");

    const recorded = await agent.persistence.providerSessions.active(conversationId);
    expect(recorded).toMatchObject({
      internalSessionId: conversation.internalSessionId,
      // Kept so a client can tell which media the agent accepts without a live session.
      promptCapabilities: conversation.capabilities.agent.promptCapabilities,
    });
    if (!recorded) throw new Error("provider attachment was not recorded");
    await conversation.prompt("reuse the recorded attachment");
    expect(await agent.persistence.providerSessions.list(conversationId)).toHaveLength(1);

    await conversation.stop();
    const reopened = await agent.conversations.open(conversationId);
    expect(reopened.providerSession).toBe("loaded");
    expect(await agent.persistence.providerSessions.list(conversationId)).toEqual([recorded]);
  });

  test("does not record a failed first prompt and can confirm a later successful turn", async () => {
    const directory = await makeDirectory();
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { identity: { command: ["bun", IDENTITY_AGENT] } },
      defaultAdapterId: "identity",
    }));
    const conversation = await agent.conversations.create();

    await expect(conversation.prompt("FAIL_IDENTITY_TURN")).rejects.toThrow(
      "intentional identity fixture failure",
    );
    expect(await agent.persistence.providerSessions.active(conversation.id)).toBeNull();

    await conversation.prompt("a later successful turn");
    expect(await agent.persistence.providerSessions.active(conversation.id)).toMatchObject({
      internalSessionId: conversation.internalSessionId,
    });
    expect((await agent.persistence.metering.list(conversation.id)).records).toHaveLength(2);
  });

  test("acknowledges a committed attachment before surfacing a post-commit hook failure", async () => {
    let failAssistantUpdate = true;
    const identity: AgentIdentityRuntime = {
      async load() { return {}; },
      async update(input) {
        if (
          failAssistantUpdate
          && input.records.some((record) => record.kind === "message" && record.role === "assistant")
        ) {
          throw new Error("intentional post-commit identity failure");
        }
      },
    };
    const { agent } = await openAgent({ identity });
    const conversation = await agent.conversations.create();

    await expect(conversation.prompt("commit before identity fails")).rejects.toThrow(
      "intentional post-commit identity failure",
    );
    expect(await agent.persistence.providerSessions.active(conversation.id)).toMatchObject({
      internalSessionId: conversation.internalSessionId,
    });
    expect(await agent.persistence.providerSessions.list(conversation.id)).toHaveLength(1);

    failAssistantUpdate = false;
    await conversation.prompt("do not append the provider attachment twice");
    expect(await agent.persistence.providerSessions.list(conversation.id)).toHaveLength(1);
  });

  test("rolls back final assistant persistence when first attachment confirmation fails", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
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
              throw new Error("intentional provider attachment persistence failure");
            }
            return await target.append(...args);
          };
        },
      });
      return await work(Object.freeze({ ...scope, providerSessions }));
    });

    await expect(conversation.prompt("fail the local attachment commit")).rejects.toThrow(
      "intentional provider attachment persistence failure",
    );
    expect(await agent.persistence.providerSessions.active(conversation.id)).toBeNull();
    expect((await agent.persistence.messages.list(conversation.id)).messages.some(
      (message) => message.role === "assistant" && message.status === "completed",
    )).toBe(false);

    backend.transaction = originalTransaction;
    await conversation.prompt("confirm after the local failure");
    expect(await agent.persistence.providerSessions.active(conversation.id)).toMatchObject({
      internalSessionId: conversation.internalSessionId,
    });
  });

  test("persists opaque consumer metadata only on the submitted user message", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    const consumerMetadata = { deliveryId: "delivery-42", submittedBy: "relay" };
    await conversation.prompt({ text: "hello", consumerMetadata });
    await conversation.promptFrom({ participantId: "agent-bob", text: "second", consumerMetadata: { task: 7 } });
    const messages = (await agent.persistence.messages.list(conversation.id)).messages;
    expect(messages[0]).toMatchObject({ role: "user", consumerMetadata });
    expect(messages[1]?.consumerMetadata).toBeUndefined();
    expect(messages[2]).toMatchObject({ role: "user", participantId: "agent-bob", consumerMetadata: { task: 7 } });
    expect(messages[3]?.consumerMetadata).toBeUndefined();
    expect(messages[0]?.metadata).toContain("operationId");
    await expect(conversation.prompt({ text: "invalid metadata", consumerMetadata: (() => 1) as never }))
      .rejects.toThrow("consumerMetadata must be a JSON value");
    expect((await agent.persistence.messages.list(conversation.id)).messages).toHaveLength(4);
  });

  test("owns multiple independent conversations in one caller-located database", async () => {
    const { agent, path } = await openAgent();
    const first = await agent.conversations.create({ title: "First" });
    const second = await agent.conversations.create({
      title: "Second",
      participants: [{ id: "bob-number", kind: "agent", name: "Bob" }],
    });

    expect(first.id).not.toBe(second.id);
    expect(first.ownerId).toBe(agent.id);
    expect(second.ownerId).toBe(agent.id);
    expect(first.agentSessionId).toBe(agent.id);
    expect(second.participants).toEqual([{ id: "bob-number", kind: "agent", name: "Bob" }]);
    expect((await agent.conversations.list()).conversations).toHaveLength(2);
    expect(agent.persistence.identityRecord.agentSessionId).toBe(agent.id);
    expect(agent.persistence.capabilities.fullTextSearch).toBe(true);
    expect(path.startsWith("/")).toBe(true);
  });

  test("loads identity before a prompt and updates it after each committed side", async () => {
    const identity = new RecordingIdentity();
    const { agent } = await openAgent({ identity });
    const conversation = await agent.conversations.create();
    const result = await conversation.prompt("hello atlas");

    expect(identity.loads).toHaveLength(1);
    expect(identity.loads[0]).toMatchObject({
      agentSessionId: agent.id,
      agentConversationId: conversation.id,
      prompt: "hello atlas",
      consistency: "eventual",
    });
    expect(identity.updates.flatMap((update) => update.records)
      .filter((record) => record.kind === "message")
      .map((record) => [record.role])).toEqual([
      ["user"],
      ["assistant"],
    ]);
    expect(result.text).toContain("private durable identity");

    const messages = (await agent.persistence.messages.list(conversation.id)).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "hello atlas" });
    expect(String(messages[0]?.content)).not.toContain("private durable identity");
    expect(messages[1]).toMatchObject({ role: "assistant" });
  });

  test("preserves a custom identity runtime that has its own kind field", async () => {
    const identity = Object.assign(new RecordingIdentity(), { kind: "consumer-memory" });
    const { agent } = await openAgent({ identity });
    expect(agent.identity).toBe(identity);
  });

  test("captures audit observations independently from canonical conversation policy", async () => {
    const directory = await makeDirectory();
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: operationsAdapters(),
      defaultAdapterId: "operations",
      capture: { message: "none", activity: "none", tool_call: "none", metering: "none" },
      auditLog: {
        directory: join(directory, "audit"),
        capture: {
          message: "content",
          activity: "none",
          tool_call: "none",
          metering: "none",
        },
      },
    }));
    const conversation = await agent.conversations.create();
    await conversation.prompt("audit-only message");

    expect((await agent.persistence.messages.list(conversation.id)).messages).toHaveLength(0);
    expect(await agent.persistence.providerSessions.active(conversation.id)).toMatchObject({
      internalSessionId: conversation.internalSessionId,
    });
    const auditOutbox = agent.persistence.auditOutbox;
    if (!auditOutbox) throw new Error("audit outbox persistence is unavailable");
    await waitUntil(async () => {
      const state = await auditOutbox.state();
      return !!state && state.lastDeliveredSequence === state.lastAllocatedSequence;
    });
    const lines = (await readFile(join(directory, "audit", "audit.000001.jsonl"), "utf8"))
      .trimEnd().split("\n").slice(1).map((line) => JSON.parse(line));
    const messages = lines.filter((item) => item.kind === "message");
    expect(messages.map((item) => item.payload)).toEqual([
      expect.objectContaining({ role: "user", content: "audit-only message" }),
      expect.objectContaining({ role: "assistant" }),
    ]);
    expect(messages.every((item) => item.agentConversationId === conversation.id)).toBe(true);
  });

  test("audits identity updates as agent-level observations", async () => {
    const directory = await makeDirectory();
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: operationsAdapters(),
      defaultAdapterId: "operations",
      identity: new RecordingIdentity(),
      auditLog: { directory: join(directory, "audit") },
    }));
    const conversation = await agent.conversations.create();
    await conversation.prompt("identity audit");
    await agent.audit!.flush({ timeoutMs: 3_000 });
    const reader = await AgentAuditLogReader.open({ directory: join(directory, "audit") });
    const entries = (await reader.readPage({ mode: "logical", limit: 100 })).entries;
    const identityEntries = entries.filter((entry) => entry.kind === "identity");
    expect(identityEntries.length).toBeGreaterThanOrEqual(2);
    expect(identityEntries.every((entry) => JSON.stringify(entry.payload) === '{"state":"updated"}')).toBe(true);
  });

  test("rejects version-2 audit configuration for a custom persistence backend", async () => {
    const { agent } = await openAgent();
    await expect(Agent.open({
      persistence: { kind: "custom", backend: agent.persistence },
      adapters: operationsAdapters(),
      auditLog: { directory: "/tmp/audit-not-opened" },
    })).rejects.toThrow("persistence capability is unavailable: auditOutbox");
  });

  test("preserves every assistant message boundary in canonical persistence", async () => {
    const directory = await makeDirectory();
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { presentation: { command: ["bun", PRESENTATION_AGENT] } },
      defaultAdapterId: "presentation",
    }));
    const conversation = await agent.conversations.create();
    const result = await conversation.prompt("show boundaries");
    expect(result.messages.map((message) => message.text)).toEqual([
      "A before tool",
      "B after tool",
    ]);
    const persisted = (await agent.persistence.messages.list(conversation.id)).messages;
    expect(persisted.map((message) => message.content)).toEqual([
      "show boundaries",
      "A before tool",
      "B after tool",
    ]);
    const toolRecords = (await agent.persistence.records.list(conversation.id, {
      kinds: ["tool_call"],
    })).records;
    expect(toolRecords.map((record) => record.kind === "tool_call" && record.state)).toEqual([
      "announced",
      "completed",
    ]);
  });

  test("does not misclassify provider session observations as model activity", async () => {
    const directory = await makeDirectory();
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { terminal: { command: ["bun", TERMINAL_AGENT] } },
      defaultAdapterId: "terminal",
      capture: { activity: "content", tool_call: "content" },
    }));
    const conversation = await agent.conversations.create();
    await conversation.prompt("classify activity and run a tool");

    const records = (await agent.persistence.records.list(conversation.id, { limit: 1_000 })).records;
    const activities = records.filter((record) => record.kind === "activity");
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      kind: "activity",
      activityType: "plan",
      state: "completed",
    });
    expect(activities[0]?.metadata).toBeUndefined();
    expect(records.filter((record) => record.kind === "tool_call")).not.toEqual([]);
  });

  test("captures permission decisions and raw ACP traffic under per-kind policy", async () => {
    const directory = await makeDirectory();
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { permission: { command: ["bun", PERMISSION_ORDER_AGENT] } },
      defaultAdapterId: "permission",
      capture: {
        tool_call: "content",
        permission: "content",
        protocol: "raw",
      },
      conversationDefaults: { defaultPermission: "approve" },
    }));
    const conversation = await agent.conversations.create();
    await conversation.prompt("run the tool");

    const records = (await agent.persistence.records.list(conversation.id, { limit: 1_000 })).records;
    const permissions = records.filter((record) => record.kind === "permission");
    expect(permissions.map((record) => record.state)).toEqual(["requested", "resolved"]);
    expect(permissions[1]).toMatchObject({ outcome: "approved" });
    expect(records.filter((record) => record.kind === "tool_call")
      .map((record) => record.kind === "tool_call" && record.state)).toEqual([
        "announced",
        "completed",
      ]);
    expect(records.some((record) =>
      record.kind === "protocol" && record.method === "session/request_permission"
    )).toBe(true);
  });

  test("filters high-volume protocol methods before persistence", async () => {
    const directory = await makeDirectory();
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { terminal: { command: ["bun", TERMINAL_AGENT] } },
      defaultAdapterId: "terminal",
      capture: {
        protocol: {
          level: "metadata",
          excludeMethods: ["session/update"],
        },
      },
    }));
    const conversation = await agent.conversations.create();
    await conversation.prompt("filter protocol updates");

    const records = (await agent.persistence.records.list(conversation.id, { limit: 1_000 })).records;
    const protocol = records.filter((record) => record.kind === "protocol");
    expect(protocol.length).toBeGreaterThan(0);
    expect(protocol.some((record) => record.method === "initialize")).toBe(true);
    expect(protocol.some((record) => record.method === "session/prompt")).toBe(true);
    expect(protocol.some((record) => record.method === "session/update")).toBe(false);
    expect(protocol.every((record) => record.message === undefined)).toBe(true);
    expect(records.map((record) => record.sequence)).toEqual(
      Array.from({ length: records.length }, (_, index) => index + 1),
    );
  });

  test("captures configuration lifecycle without discarding earlier states", async () => {
    const directory = await makeDirectory();
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { config: { command: ["bun", CONFIG_AGENT] } },
      defaultAdapterId: "config",
      capture: { configuration: "content" },
    }));
    const conversation = await agent.conversations.create();
    await conversation.setConfig("model", "beta");
    // Re-applying the value it already has changes nothing, so nothing is recorded.
    await conversation.setConfig("model", "beta");

    const records = (await agent.persistence.records.list(conversation.id, {
      kinds: ["configuration"],
    })).records;
    expect(records.map((record) => record.kind === "configuration" && record.status)).toEqual([
      "started",
      "completed",
    ]);
    expect(records[1]).toMatchObject({ configId: "model", value: "beta" });
  });

  test("promptFrom adds a stable local participant without treating it as authentication", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    await conversation.promptFrom("user-2", "hello from another user");

    const summary = await agent.conversations.get(conversation.id);
    expect(summary?.participants).toContainEqual({ id: "user-2", kind: "user" });
    expect((await agent.persistence.messages.list(conversation.id, {
      participantIds: ["user-2"],
    })).messages).toHaveLength(1);
    expect(conversation.participants).toContainEqual({ id: "user-2", kind: "user" });
  });

  test("reopens the same agent and conversation without requiring the ags id twice", async () => {
    const { agent, path } = await openAgent();
    const originalAgentId = agent.id;
    const conversation = await agent.conversations.create();
    const conversationId = conversation.id;
    await conversation.prompt("before restart");
    await agent.close();
    agents.splice(agents.indexOf(agent), 1);

    const reopened = await track(Agent.open({
      persistence: { kind: "sqlite", path },
      adapters: operationsAdapters(),
      defaultAdapterId: "operations",
    }));
    expect(reopened.id).toBe(originalAgentId);
    const opened = await reopened.conversations.open(conversationId);
    expect(opened.providerSession).toBe("loaded");
    expect(opened.conversation.id).toBe(conversationId);
    await opened.conversation.prompt("after restart");
    expect((await reopened.persistence.messages.list(conversationId)).messages).toHaveLength(4);
  });

  test("persists metering records and restores bounded state across conversation lifetimes", async () => {
    const { agent, path } = await openAgent();
    const conversation = await agent.conversations.create();
    const conversationId = conversation.id;
    const first = await conversation.prompt("meter this turn");
    expect(first.metering).not.toBeNull();
    expect((await agent.persistence.metering.list(conversationId)).records).toHaveLength(1);
    expect((await agent.persistence.records.list(conversationId, { kinds: ["metering"] })).records)
      .toEqual([expect.objectContaining({
        kind: "metering",
        operationId: first.operationId,
        meteringRecordId: first.operationId,
        status: "available",
      })]);
    expect((await agent.persistence.metering.state(conversationId))?.state).toEqual(
      first.metering?.nextState,
    );

    await agent.close();
    agents.splice(agents.indexOf(agent), 1);
    const reopened = await track(Agent.open({
      persistence: { kind: "sqlite", path },
      adapters: operationsAdapters(),
      defaultAdapterId: "operations",
    }));
    const opened = await reopened.conversations.open(conversationId);
    expect(opened.conversation.meteringSnapshot.restoration.status).toBe("restored");
    expect(opened.conversation.meteringSnapshot.operationCount).toBe(1);

    const second = await opened.conversation.prompt("meter after reopen");
    expect(second.metering?.nextState.operationCount).toBe(2);
    expect((await reopened.persistence.metering.list(conversationId)).records).toHaveLength(2);
    expect((await reopened.persistence.metering.state(conversationId))?.revision).toBe(2);
    expect((await reopened.persistence.records.list(conversationId, { kinds: ["metering"] })).records)
      .toHaveLength(2);
  });

  test("can omit detailed metering records while preserving restoration state", async () => {
    const directory = await makeDirectory();
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: operationsAdapters(),
      defaultAdapterId: "operations",
      meteringPersistence: { meteringRecords: "none" },
    }));
    const conversation = await agent.conversations.create();
    const result = await conversation.prompt("state only");

    expect(result.metering).not.toBeNull();
    expect((await agent.persistence.metering.list(conversation.id)).records).toEqual([]);
    expect((await agent.persistence.metering.state(conversation.id))?.state.operationCount).toBe(1);
    expect((await agent.persistence.records.list(conversation.id, { kinds: ["metering"] })).records)
      .toHaveLength(1);
  });

  test("adapter registry remains agent-scoped and reflectable", async () => {
    const { agent } = await openAgent();
    agent.adapters.register("second", { command: ["bun", OPERATIONS_AGENT, "second"] });
    expect(agent.adapters.list().map((registration) => registration.id).sort()).toEqual([
      "operations",
      "second",
    ]);
    const conversation = await agent.conversations.create({ adapterId: "second" });
    expect(conversation.adapterId).toBe("second");
    expect(conversation.internalSessionCommands[0]?.name).toBe("status");
  });

  test("switch preserves the agc identity, changes adapter, and recovers the activated target", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const adapters = {
      bob: { command: ["bun", OPERATIONS_AGENT, "bob"] },
      atlas: { command: ["bun", OPERATIONS_AGENT, "atlas"] },
    };
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path },
      adapters,
      defaultAdapterId: "bob",
    }));
    const conversation = await agent.conversations.create();
    const conversationId = conversation.id;
    const oldProviderSessionId = conversation.internalSessionId;

    const switched = await conversation.switch("atlas", {
      continuation: { kind: "provided", content: "portable continuation context" },
      targetPrompt: "continue now",
    });
    expect(conversation.id).toBe(conversationId);
    expect(conversation.adapterId).toBe("atlas");
    expect(conversation.internalSessionId).toStartWith("atlas-thread-");
    expect(switched).toMatchObject({
      fromAdapterId: "bob",
      toAdapterId: "atlas",
      fromInternalSessionId: oldProviderSessionId,
      toInternalSessionId: conversation.internalSessionId,
    });
    expect(switched.targetResult?.text).toContain("continue now");
    const meteringRecords = (await agent.persistence.metering.list(conversationId)).records;
    expect(meteringRecords.map((record) => record.operationKind)).toEqual([
      "switch_seed",
      "internal_command",
    ]);
    // The target is a freshly created thread, so its counters start at zero: the first
    // target operation must be attributable rather than "baseline_required".
    expect(meteringRecords[0]?.usage.status).toBe("metered");
    expect(meteringRecords[1]?.usage.status).toBe("metered");
    const history = await agent.persistence.providerSessions.list(conversationId);
    // The source never completed a provider turn, so it was runtime-only and never
    // became provider-session history. The activated target is the first recorded row.
    expect(history).toHaveLength(1);
    expect(await agent.persistence.providerSessions.active(conversationId)).toMatchObject({
      adapterId: "atlas",
      internalSessionId: conversation.internalSessionId,
      transitionId: switched.handoffId,
    });
    const nativeActions = (await agent.persistence.records.list(conversationId, {
      kinds: ["native_action"],
    })).records;
    expect(nativeActions.map((record) => record.kind === "native_action" && record.state)).toEqual([
      "started",
      "checkpoint",
      "checkpoint",
      "completed",
    ]);

    await agent.close();
    agents.splice(agents.indexOf(agent), 1);
    const reopened = await track(Agent.open({
      persistence: { kind: "sqlite", path },
      adapters,
      defaultAdapterId: "bob",
    }));
    const recovered = await reopened.conversations.open(conversationId);
    expect(recovered.providerSession).toBe("loaded");
    expect(recovered.conversation.adapterId).toBe("atlas");
    expect(recovered.conversation.internalSessionId).toBe(switched.toInternalSessionId);
  });

  test("a failed seed retains the source mapping and records no target row", async () => {
    const directory = await makeDirectory();
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { operations: { command: ["bun", OPERATIONS_AGENT, "fail-seed"] } },
      defaultAdapterId: "operations",
    }));
    const conversation = await agent.conversations.create();
    await conversation.prompt("record the source attachment");
    const source = await agent.persistence.providerSessions.active(conversation.id);
    expect(source).toMatchObject({ internalSessionId: conversation.internalSessionId! });

    const caught = await conversation.handoff({
      continuation: { kind: "provided", content: "portable continuation context" },
    }).then(() => null, (error: unknown) => error);
    expect(caught).toBeInstanceOf(AgentSessionHandoffError);
    if (!(caught instanceof AgentSessionHandoffError)) return;
    expect(caught.activationCompleted).toBe(false);
    expect(caught.providerAttachment).toBe("runtime_only");
    expect(caught.toInternalSessionId).not.toBe(source!.internalSessionId);

    // An unseeded target cannot supersede a source that still works.
    expect(conversation.internalSessionId).toBe(source!.internalSessionId);
    expect(await agent.persistence.providerSessions.list(conversation.id)).toEqual([source!]);
    const stages = (await agent.persistence.records.list(conversation.id, {
      kinds: ["native_action"],
    })).records
      .filter((record) => record.kind === "native_action" && record.action === "handoff")
      .map((record) => record.kind === "native_action" ? record.state : null);
    // started, target_created checkpoint, failed — and no target_activated checkpoint.
    expect(stages).toEqual(["started", "checkpoint", "failed"]);

    // The source still answers, which is the point of not tearing it down.
    const after = await conversation.prompt("the source is still usable");
    expect(after.status).toBe("completed");
    expect(await agent.persistence.providerSessions.list(conversation.id)).toEqual([source!]);
  });

  test("a target prompt failure leaves the confirmed target recorded", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    await conversation.prompt("record the source attachment");
    const source = await agent.persistence.providerSessions.active(conversation.id);

    const caught = await conversation.handoff({
      continuation: { kind: "provided", content: "portable continuation context" },
      targetPrompt: "FAIL_TARGET_PROMPT",
    }).then(() => null, (error: unknown) => error);
    expect(caught).toBeInstanceOf(AgentSessionHandoffError);
    if (!(caught instanceof AgentSessionHandoffError)) return;

    // Seeding already confirmed the target, so this is an operation failure after a
    // successful activation — not a reason to resurrect the source.
    expect(caught.activationCompleted).toBe(true);
    expect(caught.providerAttachment).toBe("recorded");
    expect(String(caught)).toContain("deterministic target prompt failure");
    expect(conversation.internalSessionId).toBe(caught.toInternalSessionId!);
    expect(conversation.internalSessionId).not.toBe(source!.internalSessionId);
    expect(await agent.persistence.providerSessions.active(conversation.id)).toMatchObject({
      internalSessionId: caught.toInternalSessionId!,
      transitionId: caught.handoffId,
    });
  });

  test("a same-adapter handoff records the target only after its seed completes", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    await conversation.prompt("record the source attachment");
    const source = await agent.persistence.providerSessions.active(conversation.id);

    const result = await conversation.handoff({
      continuation: { kind: "provided", content: "portable continuation context" },
    });
    expect(result.providerAttachment).toBe("recorded");
    expect(result.fromInternalSessionId).toBe(source!.internalSessionId);
    expect(result.toInternalSessionId).not.toBe(source!.internalSessionId);
    const history = await agent.persistence.providerSessions.list(conversation.id);
    expect(history).toHaveLength(2);
    expect(await agent.persistence.providerSessions.active(conversation.id)).toMatchObject({
      internalSessionId: result.toInternalSessionId,
      transitionId: result.handoffId,
    });
    // The seed is metered against the target's own zero baseline, not the source's.
    const metering = (await agent.persistence.metering.list(conversation.id)).records;
    expect(metering.at(-1)?.operationKind).toBe("handoff_seed");
    expect(metering.at(-1)?.usage.status).toBe("metered");
  });

  test("mode changes defer and retain provider mappings around a degraded stretch", async () => {
    const directory = await makeDirectory();
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: {
        operations: {
          command: ["bun", OPERATIONS_AGENT, "owned"],
          ptyCommand: ["bun", PTY_AGENT],
        },
      },
      defaultAdapterId: "operations",
    }));
    const conversation = await agent.conversations.create();
    const conversationId = conversation.id;
    await conversation.prompt("record the source attachment");
    const source = await agent.persistence.providerSessions.active(conversationId);

    await conversation.setMode("degraded");
    expect(conversation.mode).toBe("degraded");
    expect(conversation.internalSessionId).toBeNull();
    // Degraded mode has no provider session id to record, so the ACP thread stays the
    // only thing a later open can return to.
    expect(await agent.persistence.providerSessions.active(conversationId)).toEqual(source!);

    await conversation.setMode("normal");
    expect(conversation.mode).toBe("normal");
    expect(conversation.internalSessionId).not.toBe(source!.internalSessionId);
    // The replacement ACP thread is fresh, so it follows the ordinary first-turn rule.
    expect(await agent.persistence.providerSessions.active(conversationId)).toEqual(source!);

    await conversation.prompt("confirm the replacement thread");
    expect(await agent.persistence.providerSessions.active(conversationId)).toMatchObject({
      internalSessionId: conversation.internalSessionId!,
    });
  }, 25_000);

  test("reset starts a blank thread without summary or seed operations", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    const oldProviderSessionId = conversation.internalSessionId;
    const reset = await conversation.reset();

    expect(reset.summary).toBe("");
    expect(reset.meteringRecords).toEqual([]);
    expect(reset.toInternalSessionId).not.toBe(oldProviderSessionId);
    expect(conversation.adapterId).toBe("operations");
    // Nothing ran on the target, so nothing entitles it to be loaded on a later open.
    expect(reset.providerAttachment).toBe("runtime_only");
  });

  test("a promptless reset keeps the previous mapping until the target is prompted", async () => {
    const { agent, path } = await openAgent();
    const conversation = await agent.conversations.create();
    const conversationId = conversation.id;
    await conversation.prompt("record the source attachment");
    const source = await agent.persistence.providerSessions.active(conversationId);

    const reset = await conversation.reset();
    expect(reset.providerAttachment).toBe("runtime_only");
    expect(conversation.internalSessionId).toBe(reset.toInternalSessionId);
    // The live conversation is on the target, but a restart still has only the source
    // to go back to.
    expect(await agent.persistence.providerSessions.active(conversationId)).toEqual(source!);

    await conversation.prompt("the first turn on the reset target");
    const active = await agent.persistence.providerSessions.active(conversationId);
    expect(active).toMatchObject({
      internalSessionId: reset.toInternalSessionId,
      transitionId: reset.handoffId,
    });
    expect(await agent.persistence.providerSessions.list(conversationId)).toHaveLength(2);

    await agent.close();
    agents.splice(agents.indexOf(agent), 1);
    const reopened = await track(Agent.open({
      persistence: { kind: "sqlite", path },
      adapters: operationsAdapters(),
      defaultAdapterId: "operations",
    }));
    const recovered = await reopened.conversations.open(conversationId);
    expect(recovered.providerSession).toBe("loaded");
    expect(recovered.conversation.internalSessionId).toBe(reset.toInternalSessionId);
  });

  test("a promptless reset abandoned before any prompt reopens on the previous mapping", async () => {
    const { agent, path } = await openAgent();
    const conversation = await agent.conversations.create();
    const conversationId = conversation.id;
    await conversation.prompt("record the source attachment");
    const source = await agent.persistence.providerSessions.active(conversationId);

    const reset = await conversation.reset();
    expect(reset.toInternalSessionId).not.toBe(source!.internalSessionId);
    await conversation.stop();
    expect(await agent.persistence.providerSessions.list(conversationId)).toEqual([source!]);

    await agent.close();
    agents.splice(agents.indexOf(agent), 1);
    const reopened = await track(Agent.open({
      persistence: { kind: "sqlite", path },
      adapters: operationsAdapters(),
      defaultAdapterId: "operations",
    }));
    const recovered = await reopened.conversations.open(conversationId);
    expect(recovered.providerSession).toBe("loaded");
    expect(recovered.conversation.internalSessionId).toBe(source!.internalSessionId);
  });
});

class RecordingIdentity implements AgentIdentityRuntime {
  readonly loads: IdentityLoadInput[] = [];
  readonly updates: IdentityUpdateInput[] = [];

  async load(input: IdentityLoadInput): Promise<LoadedIdentityContext> {
    this.loads.push(input);
    return { promptPreamble: "private durable identity" };
  }

  async update(input: IdentityUpdateInput): Promise<void> {
    this.updates.push(input);
  }
}

async function openAgent(options: { identity?: AgentIdentityRuntime } = {}): Promise<{
  agent: Agent;
  path: string;
}> {
  const directory = await makeDirectory();
  const path = join(directory, "agent.sqlite");
  const agent = await track(Agent.open({
    persistence: { kind: "sqlite", path },
    adapters: operationsAdapters(),
    defaultAdapterId: "operations",
    ...(options.identity ? { identity: options.identity } : {}),
  }));
  return { agent, path };
}

function operationsAdapters() {
  return {
    operations: { command: ["bun", OPERATIONS_AGENT, "owned"] },
  };
}

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acp-agent-owner-"));
  directories.push(directory);
  return directory;
}

async function track(agentPromise: Promise<Agent>): Promise<Agent> {
  const agent = await agentPromise;
  agents.push(agent);
  return agent;
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for condition");
}
