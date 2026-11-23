import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Agent,
  ProviderSessionError,
  ProviderSessionInUseError,
  ProviderSessionListUnsupportedError,
  type AgentConversationId,
  type ConversationPersistenceContext,
  type ConversationPersistenceResolver,
  type ConversationRecord,
} from "../src/index.ts";
import {
  RECAP_INSTRUCTION,
  normalizeAdoption,
  selectTail,
  turnsFromReplay,
  withoutRecapTurns,
} from "../src/agent/adoption/index.ts";
import { buildRecoverySeed } from "../src/checkpointing/recovery.ts";
import { resolveConversationCheckpointingConfig } from "../src/checkpointing/config.ts";

const REPLAY_AGENT = resolve(import.meta.dir, "fixtures/replay-agent.ts");
const agents: Agent[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.close()));
  await Promise.allSettled(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const text = (role: "user" | "agent", messageId: string, value: string) => ({
  sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
  messageId,
  content: { type: "text", text: value },
});
const tool = (toolCallId: string, title: string, output: string) => [
  { sessionUpdate: "tool_call", toolCallId, title, kind: "read", status: "pending" },
  { sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawInput: { path: title }, rawOutput: output },
];
const thought = (messageId: string, value: string) => ({ sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: value } });

/** A session with two turns: plain, then one with a thought and a tool call. */
const HISTORY = [
  { sessionUpdate: "available_commands_update", availableCommands: [] },
  { sessionUpdate: "session_info_update", title: "x" },
  text("user", "u1", "Hello there"),
  text("agent", "a1", "Hi, "),
  text("agent", "a1", "how can I help?"),
  text("user", "u2", "Read a.txt"),
  thought("t1", "I should read the file"),
  text("agent", "a2", "Reading it."),
  ...tool("call-1", "a.txt", "kiwi"),
  text("agent", "a3", "It says kiwi."),
];

async function setup(options: {
  sessions?: Record<string, unknown[]>;
  noLoad?: boolean;
  failRecap?: boolean;
  noList?: boolean;
  lazy?: boolean;
  pageSize?: number;
  identity?: boolean;
  /** Checkpointing without a running schedule (the milestone is far away). */
  checkpointing?: boolean;
  conversationPersistence?: ConversationPersistenceResolver;
  path?: string;
  directory?: string;
} = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "acp-adoption-"));
  if (!options.directory) directories.push(directory);
  const file = join(directory, "sessions.json");
  await writeFile(file, JSON.stringify(options.sessions ?? { "ses-1": HISTORY }));
  process.env.REPLAY_AGENT_FILE = file;
  if (options.noLoad) process.env.REPLAY_AGENT_NO_LOAD = "1";
  else delete process.env.REPLAY_AGENT_NO_LOAD;
  if (options.failRecap) process.env.REPLAY_AGENT_FAIL_RECAP = "1";
  else delete process.env.REPLAY_AGENT_FAIL_RECAP;
  if (options.noList) process.env.REPLAY_AGENT_NO_LIST = "1";
  else delete process.env.REPLAY_AGENT_NO_LIST;
  if (options.pageSize) process.env.REPLAY_AGENT_PAGE_SIZE = String(options.pageSize);
  else delete process.env.REPLAY_AGENT_PAGE_SIZE;
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path: options.path ?? join(directory, "agent.sqlite") },
    adapters: { replay: { command: ["bun", REPLAY_AGENT] } },
    defaultAdapterId: "replay",
    conversationDefaults: { metering: { pricing: false }, ...(options.lazy ? { providerStart: "on_first_use" as const } : {}) },
    ...(options.conversationPersistence ? { conversationPersistence: options.conversationPersistence } : {}),
    // Checkpoint-backed identity needs checkpointing enabled; the milestone is far away so none runs here.
    ...(options.identity
      ? { identity: { kind: "checkpoint-backed" as const }, checkpointing: { schedule: { milestones: [1000], everyAfterMilestones: 1000 } } }
      : options.checkpointing
        ? { checkpointing: { schedule: { milestones: [1000], everyAfterMilestones: 1000 } } }
        : {}),
  });
  agents.push(agent);
  return { agent, directory, path: options.path ?? join(directory, "agent.sqlite") };
}

async function records(agent: Agent, id: AgentConversationId): Promise<readonly ConversationRecord[]> {
  return (await agent.persistence.records.list(id, { limit: 1000 })).records;
}
const messages = (list: readonly ConversationRecord[]) =>
  list.filter((record): record is Extract<ConversationRecord, { kind: "message" }> => record.kind === "message");

describe("adopting a provider session", () => {
  test("adoption attaches eagerly even with lazy defaults", async () => {
    const { agent } = await setup({ lazy: true });
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1" } });
    expect(conversation.internalSessionId).toBe("ses-1");
    expect(conversation.connection.isConnected).toBe(true);
    const summary = await agent.conversations.get(conversation.id);
    expect(summary).toMatchObject({ adopted: true, adoptProviderSessionId: "ses-1" });
    const active = await agent.persistence.providerSessions.active(conversation.id);
    expect(active).toMatchObject({ internalSessionId: "ses-1", adapterId: "replay" });
    // The history is not imported by default, and the conversation works from here on.
    expect(messages(await records(agent, conversation.id))).toEqual([]);
    const result = await conversation.prompt("and now?");
    expect(result.messages.map((message) => message.text)).toContain("LIVE_REPLY");
    expect(messages(await records(agent, conversation.id)).length).toBeGreaterThanOrEqual(2);
  });

  test("after a restart the adopted conversation opens by loading its session, like any other", async () => {
    const first = await setup();
    const created = await first.agent.conversations.create({ adopt: { providerSessionId: "ses-1" } });
    await first.agent.close();
    agents.splice(agents.indexOf(first.agent), 1);

    const second = await setup({ directory: first.directory, path: first.path });
    const { conversation, providerSession } = await second.agent.conversations.open(created.id);
    expect(providerSession).toBe("loaded");
    expect(conversation.internalSessionId).toBe("ses-1");
    // Opening did not record the session a second time.
    expect(await second.agent.persistence.providerSessions.list(created.id)).toHaveLength(1);
  });

  test("the resolver sees adopted: true for the conversation it is asked about", async () => {
    const seen: ConversationPersistenceContext[] = [];
    const { agent } = await setup({ conversationPersistence: (context) => { seen.push(context); return undefined; } });
    await agent.conversations.create({ adopt: { providerSessionId: "ses-1" } });
    expect(seen.at(0)?.adopted).toBe(true);
  });

  test("importHistory: true stores messages, thoughts and tool calls, marked as imported", async () => {
    const { agent } = await setup();
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", importHistory: true } });
    const list = await records(agent, conversation.id);
    const stored = messages(list);
    expect(stored.map((record) => [record.role, record.content])).toEqual([
      ["user", "Hello there"],
      ["assistant", "Hi, how can I help?"],
      ["user", "Read a.txt"],
      ["assistant", "Reading it."],
      ["assistant", "It says kiwi."],
    ]);
    expect(stored.every((record) => JSON.parse(record.metadata ?? "{}").imported === true)).toBe(true);
    expect(stored.find((record) => record.role === "assistant")?.metadata).toContain("providerMessageId");
    const tools = list.filter((record) => record.kind === "tool_call");
    expect(tools.some((record) => record.kind === "tool_call" && record.toolCallId === "call-1" && record.state === "completed")).toBe(true);
    // Thoughts are not captured by default, for imported history as for a live turn.
    expect(list.some((record) => record.kind === "thinking")).toBe(false);
  });

  test("with thinking captured, the imported thought is stored in replay order", async () => {
    const { agent } = await setup({ conversationPersistence: () => ({ capture: { thinking: "content" } }) });
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", importHistory: true } });
    const list = await records(agent, conversation.id);
    const order = list.map((record) => record.kind === "message" ? record.role : record.kind);
    const thinking = list.find((record) => record.kind === "thinking");
    expect(thinking).toBeDefined();
    // The second turn's user message precedes its thought, which precedes its tool call.
    expect(order.lastIndexOf("user")).toBeLessThan(order.indexOf("thinking"));
    expect(order.indexOf("thinking")).toBeLessThan(order.indexOf("tool_call"));
  });

  test("importHistory: { last: 1 } stores only the last turn", async () => {
    const { agent } = await setup();
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", importHistory: { last: 1 } } });
    expect(messages(await records(agent, conversation.id)).map((record) => record.content)).toEqual([
      "Read a.txt",
      "Reading it.",
      "It says kiwi.",
    ]);
  });

  test("imported kinds follow the conversation's capture policy, which can tell an adopted one", async () => {
    const { agent } = await setup({
      conversationPersistence: ({ adopted }) => (adopted ? { capture: { tool_call: "none", thinking: "none" } } : undefined),
    });
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", importHistory: true } });
    const list = await records(agent, conversation.id);
    expect(messages(list).length).toBe(5);
    expect(list.some((record) => record.kind === "tool_call")).toBe(false);
    expect(list.some((record) => record.kind === "thinking")).toBe(false);
  });
});

describe("the recap: the model summarizes its own history", () => {
  test("recap: true stores the model's summary ahead of the imported tail, as a marked assistant message, hidden from the chat", async () => {
    const { agent } = await setup();
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: true } });
    const list = await records(agent, conversation.id);
    const stored = messages(list);
    expect(stored[0]).toMatchObject({ role: "assistant" });
    expect(stored[0]!.content).toContain("RECAP: the user greeted");
    expect(JSON.parse(stored[0]!.metadata ?? "{}")).toMatchObject({ origin: "adoption_recap", imported: true });
    // Then the imported tail (the default is the last two turns), nothing for the question itself.
    expect(stored.slice(1).map((record) => record.role)).toEqual(["user", "assistant", "user", "assistant", "assistant"]);
    expect(stored.some((record) => String(record.content).includes("summarize this conversation"))).toBe(false);
    // The question is an accountable operation: a native action and a metering reference are recorded.
    expect(list.filter((record) => record.kind === "native_action").map((record) => record.kind === "native_action" && record.state)).toEqual(
      expect.arrayContaining(["started", "completed"]),
    );
    expect(list.some((record) => record.kind === "metering")).toBe(true);
  });

  test("with importHistory: false only the summary is stored", async () => {
    const { agent } = await setup();
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: true, importHistory: false } });
    expect(messages(await records(agent, conversation.id)).map((record) => record.role)).toEqual(["assistant"]);
  });

  test("an Agent with no identity runtime does not recap unless asked; one with identity does by default", async () => {
    const plain = await setup();
    const quiet = await plain.agent.conversations.create({ adopt: { providerSessionId: "ses-1" } });
    expect(messages(await records(plain.agent, quiet.id))).toEqual([]);

    const shared = await setup({ identity: true });
    const remembered = await shared.agent.conversations.create({ adopt: { providerSessionId: "ses-1" } });
    expect(messages(await records(shared.agent, remembered.id))[0]!.content).toContain("RECAP:");
  });

  test("the Agent's other conversations learn about the adopted one", async () => {
    const { agent } = await setup({ identity: true });
    await agent.conversations.create({ adopt: { providerSessionId: "ses-1" } });
    const other = await agent.conversations.create();
    const identity = await agent.identity.load({
      agentSessionId: agent.id,
      agentConversationId: other.id,
      targetProviderContextId: "context-1",
      participant: { id: "user", kind: "user" },
      prompt: "hello",
      consistency: "eventual",
    });
    expect(identity.promptPreamble ?? "").toContain("RECAP: the user greeted");
  });

  test("a recap that fails is recorded and the adoption still succeeds", async () => {
    const { agent } = await setup({ failRecap: true });
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: true } });
    const list = await records(agent, conversation.id);
    const errors = list.filter((record) => record.kind === "error");
    expect(errors.map((record) => record.kind === "error" && record.code)).toEqual(["adoption_recap_failed"]);
    // No summary, but the imported tail is stored and the conversation works.
    expect(messages(list).some((record) => String(record.content).startsWith("RECAP"))).toBe(false);
    expect(messages(list).length).toBe(5);
    const result = await conversation.prompt("still there?");
    expect(result.messages.map((message) => message.text)).toContain("LIVE_REPLY");
  });

  test("normalizeAdoption: the recap default follows the Agent, and sets a small tail", async () => {
    const { normalizeAdoption: normalize } = await import("../src/agent/adoption/index.ts");
    expect(normalize({ providerSessionId: "x" }, { recap: true })).toEqual({ providerSessionId: "x", recap: true, importHistory: { last: 2 } });
    expect(normalize({ providerSessionId: "x" }, { recap: false })).toEqual({ providerSessionId: "x", recap: false, importHistory: false });
    expect(normalize({ providerSessionId: "x", recap: false, importHistory: { last: 5 } }, { recap: true }).importHistory).toEqual({ last: 5 });
    expect(() => normalize({ providerSessionId: "x", recap: "yes" as never })).toThrow(/recap must be a boolean/);
  });
});

describe("adoption validation and failure", () => {
  test("rejects before any row: a blank id, a bad tail, and message capture that stores nothing", async () => {
    const { agent } = await setup({ conversationPersistence: ({ adopted }) => (adopted ? { capture: { message: "none" } } : undefined) });
    await expect(agent.conversations.create({ adopt: { providerSessionId: "  " } })).rejects.toThrow(/providerSessionId cannot be blank/);
    await expect(agent.conversations.create({ adopt: { providerSessionId: "ses-1", importHistory: { last: 0 } } })).rejects.toThrow(/positive integer/);
    await expect(agent.conversations.create({ adopt: { providerSessionId: "ses-1" } })).rejects.toThrow(
      /requires message capture "content" or "raw", not "none"/,
    );
    expect((await agent.conversations.list()).conversations).toEqual([]);
  });

  test("degraded mode cannot load a session, so it is refused before any row", async () => {
    const { agent } = await setup();
    await expect(agent.conversations.create({ mode: "degraded", adopt: { providerSessionId: "ses-1" } })).rejects.toThrow(
      /requires ACP \(normal\) mode/,
    );
    expect((await agent.conversations.list()).conversations).toEqual([]);
  });

  test("a session that is already adopted is refused, naming its owner, until that conversation is deleted", async () => {
    const { agent } = await setup();
    const first = await agent.conversations.create({ adopt: { providerSessionId: "ses-1" } });
    const refused = await agent.conversations.create({ adopt: { providerSessionId: "ses-1" } }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProviderSessionInUseError);
    expect((refused as ProviderSessionInUseError).ownedBy).toEqual([first.id]);
    expect((await agent.conversations.list()).conversations).toHaveLength(1); // no row for the refused one
    await first.stop();
    await agent.conversations.delete(first.id);
    const again = await agent.conversations.create({ adopt: { providerSessionId: "ses-1" } });
    expect(again.internalSessionId).toBe("ses-1");
  });

  test("two adoptions at once: only one wins", async () => {
    const { agent } = await setup();
    const results = await Promise.allSettled([
      agent.conversations.create({ adopt: { providerSessionId: "ses-1" } }),
      agent.conversations.create({ adopt: { providerSessionId: "ses-1" } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ProviderSessionInUseError);
  });

  test("a session the provider does not have: the row stays, the failure is recorded, and open() never starts a new session", async () => {
    const { agent } = await setup();
    const error = await agent.conversations.create({ adopt: { providerSessionId: "ses-missing" } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderSessionError);
    const [stored] = (await agent.conversations.list()).conversations;
    expect(stored).toMatchObject({ adopted: true, adoptProviderSessionId: "ses-missing" });
    const id = stored!.agentConversationId;
    expect(await agent.persistence.providerSessions.active(id)).toBeNull();
    expect((await records(agent, id)).some((record) => record.kind === "error")).toBe(true);

    // Opening it retries the same session and fails the same way; it does not fall back to a new one.
    await expect(agent.conversations.open(id)).rejects.toBeInstanceOf(ProviderSessionError);
    expect(await agent.persistence.providerSessions.active(id)).toBeNull();
    // The claim still holds, so the session cannot be adopted into another conversation meanwhile.
    expect(await agent.persistence.providerSessions.conversationsUsing!("ses-missing")).toEqual([id]);
  });

  test("opening a failed adoption once the session exists loads it and records it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-adoption-retry-"));
    directories.push(directory);
    const first = await setup({ directory, sessions: {} });
    await expect(first.agent.conversations.create({ adopt: { providerSessionId: "ses-late" } })).rejects.toBeInstanceOf(ProviderSessionError);
    const id = (await first.agent.conversations.list()).conversations[0]!.agentConversationId;
    await first.agent.close();
    agents.splice(agents.indexOf(first.agent), 1);

    const second = await setup({ directory, path: first.path, sessions: { "ses-late": HISTORY } });
    const { conversation, providerSession } = await second.agent.conversations.open(id);
    expect(providerSession).toBe("loaded");
    expect(conversation.internalSessionId).toBe("ses-late");
    expect(await second.agent.persistence.providerSessions.active(id)).toMatchObject({ internalSessionId: "ses-late" });
    const result = await conversation.prompt("hello");
    expect(result.messages.map((message) => message.text)).toContain("LIVE_REPLY");
  });

  test("an agent that cannot load sessions fails the adoption with a recorded error, and keeps the row", async () => {
    const { agent } = await setup({ noLoad: true });
    await expect(agent.conversations.create({ adopt: { providerSessionId: "ses-1" } })).rejects.toBeInstanceOf(ProviderSessionError);
    const [stored] = (await agent.conversations.list()).conversations;
    expect(stored?.adopted).toBe(true);
    expect((await records(agent, stored!.agentConversationId)).some((record) => record.kind === "error")).toBe(true);
  });
});

describe("listing the provider's sessions", () => {
  const SESSIONS = { "ses-a": HISTORY, "ses-b": HISTORY, "ses-c": HISTORY };

  test("lists what the provider holds, and says which conversation already owns each", async () => {
    const { agent } = await setup({ sessions: SESSIONS });
    const before = await agent.conversations.listProviderSessions();
    expect(before.map((session) => session.providerSessionId)).toEqual(["ses-a", "ses-b", "ses-c"]);
    expect(before[0]).toMatchObject({ title: "Session ses-a", updatedAt: "2026-10-05T00:00:00.000Z" });
    expect(before.every((session) => session.adoptedBy === undefined)).toBe(true);

    const adopted = await agent.conversations.create({ adopt: { providerSessionId: "ses-b" } });
    const after = await agent.conversations.listProviderSessions();
    expect(after.find((session) => session.providerSessionId === "ses-b")?.adoptedBy).toBe(adopted.id);
    expect(after.filter((session) => session.adoptedBy).length).toBe(1);
    // Listing created nothing.
    expect((await agent.conversations.list()).conversations).toHaveLength(1);
  });

  test("a claim from an adoption that failed still shows as owned", async () => {
    const { agent } = await setup({ sessions: SESSIONS, failRecap: false });
    await agent.conversations.create({ adopt: { providerSessionId: "ses-gone" } }).catch(() => undefined);
    const [stored] = (await agent.conversations.list()).conversations;
    // The provider does not list "ses-gone", but the claim keeps it from being adopted elsewhere.
    expect(await agent.persistence.providerSessions.conversationsUsing!("ses-gone")).toEqual([stored!.agentConversationId]);
  });

  test("follows the provider's pages and stops at the limit", async () => {
    const { agent } = await setup({ sessions: SESSIONS, pageSize: 1 });
    expect((await agent.conversations.listProviderSessions()).map((session) => session.providerSessionId)).toEqual(["ses-a", "ses-b", "ses-c"]);
    expect((await agent.conversations.listProviderSessions({ limit: 2 })).map((session) => session.providerSessionId)).toEqual(["ses-a", "ses-b"]);
    await expect(agent.conversations.listProviderSessions({ limit: 0 })).rejects.toThrow(/limit must be a positive integer/);
  });

  test("an agent that does not list sessions says so with a structured error", async () => {
    const { agent } = await setup({ sessions: SESSIONS, noList: true });
    const error = await agent.conversations.listProviderSessions().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderSessionListUnsupportedError);
    expect((error as ProviderSessionListUnsupportedError).adapterId).toBe("replay");
  });

  test("an unknown adapter is refused", async () => {
    const { agent } = await setup({ sessions: SESSIONS });
    await expect(agent.conversations.listProviderSessions({ adapterId: "nope" })).rejects.toThrow();
  });
});

describe("turning a replay into turns", () => {
  const notification = (update: unknown) => ({ sessionId: "s", update });

  test("a user message starts a turn; chunks of one message join; other updates are skipped", () => {
    const turns = turnsFromReplay(HISTORY.map(notification));
    expect(turns).toHaveLength(2);
    expect(turns[0]!.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect((turns[0]!.items[1] as { text: string }).text).toBe("Hi, how can I help?");
    expect(turns[1]!.items.map((item) => item.kind)).toEqual(["user", "activity", "assistant", "activity", "activity", "assistant"]);
  });

  test("assistant messages are bounded by messageId, even back to back", () => {
    const turns = turnsFromReplay([text("user", "u", "q"), text("agent", "a1", "one"), text("agent", "a2", "two")].map(notification));
    expect(turns[0]!.items.map((item) => (item as { text?: string }).text)).toEqual(["q", "one", "two"]);
  });

  test("a tool call replayed after the next user message stays where the replay put it", () => {
    const turns = turnsFromReplay([
      text("user", "u1", "run it"),
      text("agent", "a1", "ok"),
      text("user", "u2", "does it exist?"),
      ...tool("late", "sleep 20", "done"),
      text("agent", "a2", "no"),
    ].map(notification));
    expect(turns).toHaveLength(2);
    expect(turns[0]!.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(turns[1]!.items.map((item) => item.kind)).toEqual(["user", "activity", "activity", "assistant"]);
  });

  test("history that starts with an assistant message gets a first turn without a user message", () => {
    const turns = turnsFromReplay([text("agent", "a1", "hello")].map(notification));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.items.map((item) => item.kind)).toEqual(["assistant"]);
  });

  test("selectTail keeps the last n turns, or all", () => {
    const turns = turnsFromReplay(HISTORY.map(notification));
    expect(selectTail(turns, 1)).toHaveLength(1);
    expect(selectTail(turns, 1)[0]).toBe(turns[1]);
    expect(selectTail(turns, 9)).toHaveLength(2);
    expect(selectTail(turns, undefined)).toHaveLength(2);
  });

  test("normalizeAdoption validates and defaults", () => {
    expect(normalizeAdoption({ providerSessionId: "x" })).toEqual({ providerSessionId: "x", recap: false, importHistory: false });
    expect(normalizeAdoption({ providerSessionId: "x", importHistory: true })).toEqual({ providerSessionId: "x", recap: false, importHistory: {} });
    expect(normalizeAdoption({ providerSessionId: "x", importHistory: { last: 3 } }).importHistory).toEqual({ last: 3 });
    expect(() => normalizeAdoption({ providerSessionId: "x", importHistory: { last: 1.5 } })).toThrow(/positive integer/);
  });
});

/** A provider history of `turns` plain turns, two messages each. */
function longHistory(turns: number): unknown[] {
  return Array.from({ length: turns }, (_, index) => [
    text("user", `u${index}`, `question ${index}`),
    text("agent", `a${index}`, `answer ${index}`),
  ]).flat();
}

describe("where checkpointing starts for an adopted conversation", () => {
  const latestCheckpoint = (agent: Agent, id: AgentConversationId) => agent.persistence.recoveryCheckpoints!.latest(id);

  test("with a recap and the default tail, the recap is the first checkpoint and the imported turns come after it", async () => {
    const { agent } = await setup({ checkpointing: true });
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: true } });
    const stored = messages(await records(agent, conversation.id));
    const floor = await latestCheckpoint(agent, conversation.id);
    expect(floor).toMatchObject({ source: "adoption_recap", revision: 1, coveredSequence: stored[0]!.sequence });
    expect(floor!.summary).toContain("RECAP: the user greeted");
    expect(floor!.generatorInternalInferenceId).toBeUndefined();
    // Counting responses starts after everything the adoption stored.
    expect(floor!.responsesCountedAfterSequence).toBe(stored.at(-1)!.sequence);
    expect(await agent.persistence.recoveryCheckpoints!.successfulResponseCount(conversation.id)).toBe(0);
    await conversation.prompt("and now?");
    expect(await agent.persistence.recoveryCheckpoints!.successfulResponseCount(conversation.id)).toBe(1);
  });

  test("a recovery from it seeds the recap and the imported turns after it, once each", async () => {
    const { agent } = await setup({ checkpointing: true });
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: true } });
    const floor = (await latestCheckpoint(agent, conversation.id))!;
    const latest = await agent.persistence.recoveryCheckpoints!.latestMessageSequence(conversation.id);
    const seed = await buildRecoverySeed(
      agent.persistence.messages,
      conversation.id,
      floor,
      latest,
      resolveConversationCheckpointingConfig().recovery,
    );
    expect(seed.prompt.match(/RECAP: the user greeted/g)?.length).toBe(1);
    expect(seed.prompt).toContain("Read a.txt");
    expect(seed.prompt).toContain("It says kiwi.");
  });

  test("a long history imported whole: the floor is the last 50 messages back, and the recap stands for everything before it", async () => {
    const { agent } = await setup({ checkpointing: true, sessions: { "ses-1": longHistory(60) } });
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: true, importHistory: true } });
    const stored = messages(await records(agent, conversation.id));
    // The recap, then 120 imported messages.
    expect(stored.length).toBe(121);
    const floor = (await latestCheckpoint(agent, conversation.id))!;
    expect(floor.source).toBe("adoption_recap");
    expect(floor.coveredSequence).toBe(stored.at(-1)!.sequence - 50);
    expect(floor.coveredSequence).toBeGreaterThan(stored[0]!.sequence);
    // The whole history is still stored and readable; only summarizing starts after the floor.
    expect(stored.some((record) => record.content === "question 0")).toBe(true);
  });

  test("without a recap, a long import gets a baseline: no summary, the same floor", async () => {
    const { agent } = await setup({ checkpointing: true, sessions: { "ses-1": longHistory(60) } });
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: false, importHistory: true } });
    const stored = messages(await records(agent, conversation.id));
    expect(stored.length).toBe(120);
    const floor = (await latestCheckpoint(agent, conversation.id))!;
    expect(floor).toMatchObject({ source: "adoption_baseline", summary: "", coveredSequence: stored.at(-1)!.sequence - 50 });
    const seed = await buildRecoverySeed(
      agent.persistence.messages,
      conversation.id,
      floor,
      stored.at(-1)!.sequence,
      resolveConversationCheckpointingConfig().recovery,
    );
    // Only the messages after the floor are known, and nothing pretends to be a summary.
    expect(seed.prompt).not.toContain("Continuation checkpoint");
    expect(seed.prompt).toContain("answer 59");
    expect(seed.prompt).not.toContain("question 0");
  });

  test("without a recap and with little stored there is nothing to put a floor under", async () => {
    const { agent } = await setup({ checkpointing: true });
    const bare = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: false } });
    expect(await latestCheckpoint(agent, bare.id)).toBeNull();
  });

  test("a conversation that does not checkpoint gets no floor", async () => {
    const { agent } = await setup();
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: true } });
    expect(await latestCheckpoint(agent, conversation.id)).toBeNull();
  });

  test("a failed recap leaves a baseline when there is history stored beyond the tail", async () => {
    const { agent } = await setup({ checkpointing: true, failRecap: true, sessions: { "ses-1": longHistory(60) } });
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: true, importHistory: true } });
    expect(await latestCheckpoint(agent, conversation.id)).toMatchObject({ source: "adoption_baseline", summary: "" });
  });

  test("identity does not deliver a baseline as an empty summary", async () => {
    const { agent } = await setup({ identity: true, sessions: { "ses-1": longHistory(60) } });
    const adopted = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: false, importHistory: true } });
    expect(await latestCheckpoint(agent, adopted.id)).toMatchObject({ source: "adoption_baseline" });
    const other = await agent.conversations.create();
    const identity = await agent.identity.load({
      agentSessionId: agent.id,
      agentConversationId: other.id,
      targetProviderContextId: "context-1",
      participant: { id: "user", kind: "user" },
      prompt: "hello",
      consistency: "eventual",
    });
    expect(identity.promptPreamble ?? "").toContain("question 0");
    expect(identity.promptPreamble ?? "").not.toContain("Summary through source sequence");
  });

  test("deleting the conversation with its checkpoints removes the floor too", async () => {
    const { agent } = await setup({ checkpointing: true });
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: true } });
    await agent.conversations.delete(conversation.id, { checkpoints: true });
    expect(await latestCheckpoint(agent, conversation.id)).toBeNull();
  });
});

describe("adopting a session that was adopted before", () => {
  test("the recap question and its answer are not imported as turns of the history", async () => {
    const question = text("user", "uq", RECAP_INSTRUCTION);
    const answer = text("agent", "aq", "an earlier recap");
    const turns = turnsFromReplay([...HISTORY, question, answer].map((update) => ({ update })));
    expect(turns.length).toBe(3);
    const kept = withoutRecapTurns(turns);
    expect(kept.length).toBe(2);
    expect(JSON.stringify(kept)).not.toContain("an earlier recap");
    expect(JSON.stringify(kept)).not.toContain("automated request");
    expect(selectTail(kept, 1)[0]!.items.some((item) => item.kind === "assistant" && item.text.includes("kiwi"))).toBe(true);
  });

  test("a replay containing the recap turn imports the real turns", async () => {
    const { agent } = await setup({
      sessions: { "ses-1": [...HISTORY, text("user", "uq", RECAP_INSTRUCTION), text("agent", "aq", "an earlier recap")] },
    });
    const conversation = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: false, importHistory: { last: 1 } } });
    const stored = messages(await records(agent, conversation.id));
    expect(stored.map((record) => String(record.content))).toEqual(["Read a.txt", "Reading it.", "It says kiwi."]);
  });
});

test("replayed media does not mint empty imported assistant messages", () => {
  expect(turnsFromReplay([{ update: { sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/png", data: "AQ==" } } }])).toEqual([]);
});
