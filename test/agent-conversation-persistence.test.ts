import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Agent,
  ProviderSessionError,
  type AgentConversationId,
  type ConversationPersistenceContext,
  type ConversationPersistenceResolver,
  type ConversationRecord,
  type ConversationRecordCaptureConfig,
} from "../src/index.ts";
import { ConversationSettingsResolver } from "../src/agent/persistence-policy/index.ts";
import type { ManagerSettings } from "../src/agent/manager-settings.ts";
import { resolveConversationRecordCapture } from "../src/persistence/backend.ts";

const OPERATIONS_AGENT = resolve(import.meta.dir, "../smoke-tests/test5-operations/operations-agent.ts");
const agents: Agent[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.close()));
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "acp-conversation-persistence-"));
  directories.push(path);
  return path;
}

async function openAgent(
  path: string,
  extra: {
    label?: string;
    capture?: ConversationRecordCaptureConfig;
    conversationPersistence?: ConversationPersistenceResolver;
    checkpointing?: boolean;
  } = {},
): Promise<Agent> {
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path },
    adapters: { operations: { command: ["bun", OPERATIONS_AGENT, extra.label ?? "persist"] } },
    defaultAdapterId: "operations",
    conversationDefaults: { metering: { pricing: false } },
    ...(extra.capture ? { capture: extra.capture } : {}),
    ...(extra.conversationPersistence ? { conversationPersistence: extra.conversationPersistence } : {}),
    ...(extra.checkpointing
      ? { checkpointing: { schedule: { milestones: [1], everyAfterMilestones: 50 } } }
      : {}),
  });
  agents.push(agent);
  return agent;
}

async function records(agent: Agent, id: AgentConversationId): Promise<readonly ConversationRecord[]> {
  return (await agent.persistence.records.list(id, { limit: 1000 })).records;
}
const messagesOf = (list: readonly ConversationRecord[]) => list.filter((record) => record.kind === "message");

describe("conversation persistence resolver: what each conversation stores", () => {
  test("one Agent, two conversations: the resolver gives each its own capture", async () => {
    const path = join(await directory(), "agent.sqlite");
    const agent = await openAgent(path, {
      conversationPersistence: ({ title }) => (title === "quiet" ? { capture: { message: "none" } } : undefined),
    });
    const published: ConversationRecord[] = [];
    agent.events.subscribe((notification) => published.push(notification.event.record));

    const quiet = await agent.conversations.create({ title: "quiet" });
    const normal = await agent.conversations.create({ title: "normal" });
    await quiet.prompt("hello quiet");
    await normal.prompt("hello normal");

    expect(messagesOf(await records(agent, quiet.id))).toEqual([]);
    expect(messagesOf(await records(agent, normal.id)).length).toBeGreaterThanOrEqual(2);
    // The committed-record bus publishes what is persisted, so nothing about the quiet one.
    const publishedMessages = published.filter((record) => record.kind === "message");
    expect(publishedMessages.every((record) => record.agentConversationId === normal.id)).toBe(true);
    expect(publishedMessages.length).toBeGreaterThan(0);
  });

  test("the context carries what the library knows, and the stored summary after a restart", async () => {
    const path = join(await directory(), "agent.sqlite");
    const contexts: ConversationPersistenceContext[] = [];
    const resolver: ConversationPersistenceResolver = (context) => {
      contexts.push(context);
      return { capture: { message: "none" } };
    };
    const first = await openAgent(path, { conversationPersistence: resolver });
    const created = await first.conversations.create({
      title: "Quiet title",
      metadata: '{"kind":"quiet"}',
      participants: [{ id: "alice", kind: "user" }],
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      agentConversationId: created.id,
      title: "Quiet title",
      metadata: '{"kind":"quiet"}',
      adopted: false,
    });
    expect(contexts[0]!.participants.some((participant) => participant.id === "alice")).toBe(true);
    await created.prompt("one");
    expect(contexts).toHaveLength(1); // a live conversation's writes never call the resolver again
    await first.close();

    contexts.length = 0;
    const second = await openAgent(path, { conversationPersistence: resolver });
    const reopened = await second.conversations.open(created.id);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ agentConversationId: created.id, title: "Quiet title", metadata: '{"kind":"quiet"}' });
    await reopened.conversation.prompt("two");
    expect(messagesOf(await records(second, created.id))).toEqual([]);
  });

  test("a live conversation keeps the policy it started with; the next open uses the resolver's new answer", async () => {
    const path = join(await directory(), "agent.sqlite");
    let answer: ReturnType<ConversationPersistenceResolver> = { capture: { message: "none" } };
    const agent = await openAgent(path, { conversationPersistence: () => answer });
    const conversation = await agent.conversations.create();
    answer = undefined; // the consumer's configuration changes while the conversation is live
    await conversation.prompt("still quiet");
    expect(messagesOf(await records(agent, conversation.id))).toEqual([]);

    await conversation.stop();
    const reopened = await agent.conversations.open(conversation.id);
    await reopened.conversation.prompt("now stored");
    expect(messagesOf(await records(agent, conversation.id)).length).toBeGreaterThan(0);
  });

  test("an Agent without a resolver stores what it always did", async () => {
    const path = join(await directory(), "agent.sqlite");
    const agent = await openAgent(path);
    const conversation = await agent.conversations.create();
    await conversation.prompt("hello");
    expect(messagesOf(await records(agent, conversation.id)).length).toBeGreaterThanOrEqual(2);
  });

  test("appending an assistant message follows the conversation's own capture", async () => {
    const path = join(await directory(), "agent.sqlite");
    const agent = await openAgent(path, {
      conversationPersistence: ({ title }) => (title === "quiet" ? { capture: { message: "none" } } : undefined),
    });
    const quiet = await agent.conversations.create({ title: "quiet" });
    const normal = await agent.conversations.create({ title: "normal" });
    await expect(agent.conversations.appendAssistantMessage(quiet.id, { text: "note" })).rejects.toThrow(
      /requires message capture "content" or "raw", not "none"/,
    );
    const appended = await agent.conversations.appendAssistantMessage(normal.id, { text: "note" });
    expect(appended.kind).toBe("message");
  });
});

describe("conversation persistence resolver: invalid answers are caller mistakes", () => {
  const cases: Array<[string, ConversationPersistenceResolver, RegExp, { checkpointing?: boolean }?]> = [
    ["a resolver that throws", () => { throw new Error("boom from the resolver"); }, /boom from the resolver/],
    ["a non-object answer", (() => 42) as unknown as ConversationPersistenceResolver, /must return an object or undefined/],
    ["an unknown override key", (() => ({ nope: 1 })) as unknown as ConversationPersistenceResolver, /unknown conversation persistence override key: nope/],
    ["an unknown record kind", () => ({ capture: { banana: "content" } as never }), /unknown record capture kind: banana/],
    ["an invalid level", () => ({ capture: { message: "loud" } as never }), /invalid capture level for message: loud/],
    ["an audit capture override on an Agent without an audit log", () => ({ auditLog: { capture: { message: "content" as const } } }), /conversation audit capture requires an Agent audit log/],
    ["an invalid metering retention", () => ({ meteringRecords: { retain: 0 } }), /invalid meteringRecords retention/],
    [
      "metadata message capture while checkpointing is enabled",
      () => ({ capture: { message: "metadata" } }),
      /checkpointing is enabled: message capture "metadata"/,
      { checkpointing: true },
    ],
  ];

  for (const [name, resolver, expected, extra] of cases) {
    test(`${name} rejects the start before anything is written`, async () => {
      const path = join(await directory(), "agent.sqlite");
      const agent = await openAgent(path, { conversationPersistence: resolver, ...extra });
      await expect(agent.conversations.create()).rejects.toThrow(expected);
      // No row, so no error record and no provider session either.
      expect((await agent.conversations.list()).conversations).toEqual([]);
    });
  }

  test("a resolver that is not a function is refused when the Agent opens", async () => {
    const path = join(await directory(), "agent.sqlite");
    await expect(
      openAgent(path, { conversationPersistence: "nope" as unknown as ConversationPersistenceResolver }),
    ).rejects.toThrow(/conversationPersistence must be a function/);
  });
});

describe("conversation persistence resolver: error records follow the conversation's policy", () => {
  test("a load failure under capture error none writes no row but still throws the structured error", async () => {
    const path = join(await directory(), "agent.sqlite");
    const seeded = await openAgent(path, { label: "persist" });
    const conversation = await seeded.conversations.create();
    await conversation.prompt("hello");
    const id = conversation.id;
    await seeded.close();

    // The control: the Agent's own policy records the failure.
    const control = await openAgent(path, { label: "fail-load" });
    await expect(control.conversations.open(id)).rejects.toBeInstanceOf(ProviderSessionError);
    const withError = await records(control, id);
    expect(withError.some((record) => record.kind === "error")).toBe(true);
    await control.close();

    // The same failure under a conversation that stores no errors.
    const path2 = join(await directory(), "agent.sqlite");
    const seeded2 = await openAgent(path2, { label: "persist" });
    const conversation2 = await seeded2.conversations.create();
    await conversation2.prompt("hello");
    const id2 = conversation2.id;
    await seeded2.close();
    const quiet = await openAgent(path2, {
      label: "fail-load",
      conversationPersistence: () => ({ capture: { error: "none" } }),
    });
    await expect(quiet.conversations.open(id2)).rejects.toBeInstanceOf(ProviderSessionError);
    expect((await records(quiet, id2)).some((record) => record.kind === "error")).toBe(false);
  });
});

describe("ConversationSettingsResolver", () => {
  const base = (captureConfig: ConversationRecordCaptureConfig | undefined, checkpointing = false): ManagerSettings =>
    ({
      capture: resolveConversationRecordCapture(captureConfig),
      ...(captureConfig ? { captureConfig } : {}),
      checkpointing: checkpointing ? ({ enabled: true } as never) : null,
      auditLog: null,
      meteringRecords: "all",
      defaults: {},
    }) as unknown as ManagerSettings;
  const context: ConversationPersistenceContext = { agentConversationId: "agc-x" as AgentConversationId, participants: [], adopted: false };

  test("keys the override sets replace the Agent's; omitted keys follow the Agent", () => {
    const settings = new ConversationSettingsResolver(
      base({ message: "raw", error: "none", tool_call: "content" }),
      () => ({ capture: { message: "none" } }),
    ).settingsFor(context);
    expect(settings.capture.message).toBe("none");
    expect(settings.capture.error).toBe("none");
    expect(settings.capture.tool_call).toBe("content");
  });

  test("protocol counts as one key: an override replaces its level and filters together", () => {
    const settings = new ConversationSettingsResolver(
      base({ protocol: { level: "metadata", excludeMethods: ["session/update"] } }),
      () => ({ capture: { protocol: "raw" } }),
    ).settingsFor(context);
    expect(settings.capture.protocol).toEqual({ level: "raw", includeMethods: [], excludeMethods: [] });
  });

  test("no resolver, undefined and {} all mean the Agent's own settings", () => {
    const agentSettings = base({ message: "raw" });
    expect(new ConversationSettingsResolver(agentSettings, undefined).settingsFor(context)).toBe(agentSettings);
    expect(new ConversationSettingsResolver(agentSettings, () => undefined).settingsFor(context)).toBe(agentSettings);
    expect(new ConversationSettingsResolver(agentSettings, () => ({})).settingsFor(context)).toBe(agentSettings);
    expect(new ConversationSettingsResolver(agentSettings, () => ({ capture: {} })).settingsFor(context)).toBe(agentSettings);
  });

  test("identical overrides are resolved once", () => {
    const resolver = new ConversationSettingsResolver(base(undefined), () => ({ capture: { message: "none", error: "none" } }));
    const first = resolver.settingsFor(context);
    const second = resolver.settingsFor({ ...context, agentConversationId: "agc-y" as AgentConversationId });
    expect(second.capture).toBe(first.capture);
  });
});
