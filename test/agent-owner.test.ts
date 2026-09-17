import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Agent,
  type AgentIdentityRuntime,
  type IdentityLoadInput,
  type IdentityUpdateInput,
  type LoadedIdentityContext,
} from "../src/index.ts";

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

describe("Agent owner", () => {
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
    expect(identity.updates.map((update) => update.records.map((record) => record.role))).toEqual([
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
    const history = await agent.persistence.providerSessions.list(conversationId);
    expect(history).toHaveLength(2);
    expect(history[0]?.deactivatedAt).toBeDefined();
    expect(await agent.persistence.providerSessions.active(conversationId)).toMatchObject({
      adapterId: "atlas",
      internalSessionId: conversation.internalSessionId,
      transitionId: switched.handoffId,
    });

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

  test("reset starts a blank thread without summary or seed operations", async () => {
    const { agent } = await openAgent();
    const conversation = await agent.conversations.create();
    const oldProviderSessionId = conversation.internalSessionId;
    const reset = await conversation.reset();

    expect(reset.summary).toBe("");
    expect(reset.meteringRecords).toEqual([]);
    expect(reset.toInternalSessionId).not.toBe(oldProviderSessionId);
    expect(conversation.adapterId).toBe("operations");
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
