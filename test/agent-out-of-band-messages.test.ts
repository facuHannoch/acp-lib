import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Agent,
  AgentAuditLogReader,
  OUT_OF_BAND_MESSAGE_ORIGIN,
  isOutOfBandMessage,
  type AgentConfig,
  type AgentIdentityRuntime,
  type ConversationRecord,
  type IdentityUpdateInput,
} from "../src/index.ts";
import { createAgentConversationId } from "../src/agent-ids.ts";
import { OUT_OF_BAND_PROMPT_MAX_CHARS } from "../src/out-of-band-messages.ts";

const ECHO = resolve(import.meta.dir, "fixtures/echo-prompt-agent.ts");
const agents: Agent[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.close()));
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("appendAssistantMessage", () => {
  test("persists a completed out-of-band assistant record and publishes it", async () => {
    const agent = await open();
    const conversation = await agent.conversations.create();
    await conversation.stop();
    const published: ConversationRecord[] = [];
    agent.events.subscribe(({ event }) => published.push(event.record), {
      conversationIds: [conversation.id],
    });

    const record = await agent.conversations.appendAssistantMessage(conversation.id, {
      text: "Your build finished",
      consumerMetadata: { kind: "send_message_to_user" },
    });

    expect(record).toMatchObject({
      kind: "message",
      role: "assistant",
      status: "completed",
      content: "Your build finished",
      consumerMetadata: { kind: "send_message_to_user" },
    });
    expect(JSON.parse(record.metadata!).origin).toBe(OUT_OF_BAND_MESSAGE_ORIGIN);
    expect(isOutOfBandMessage(record)).toBe(true);
    expect(published.map((item) => item.recordId)).toEqual([record.recordId]);
    const messages = (await agent.persistence.messages.list(conversation.id)).messages;
    expect(messages.at(-1)?.recordId).toBe(record.recordId);
  }, 20_000);

  test("works on a conversation with no live provider session", async () => {
    const path = await sqlitePath();
    let agent = await open({ path });
    const conversation = await agent.conversations.create();
    await agent.close();
    agents.splice(agents.indexOf(agent), 1);

    agent = await open({ path });
    const record = await agent.conversations.appendAssistantMessage(conversation.id, { text: "while closed" });
    expect(record.agentConversationId).toBe(conversation.id);
  }, 20_000);

  test("rejects blank text, unknown or deleted conversations, and lossy message capture", async () => {
    const agent = await open();
    const conversation = await agent.conversations.create();
    await expect(agent.conversations.appendAssistantMessage(conversation.id, { text: "  " }))
      .rejects.toThrow("cannot be blank");
    await expect(agent.conversations.appendAssistantMessage(createAgentConversationId(), { text: "x" }))
      .rejects.toThrow("unknown active conversation");
    await agent.conversations.delete(conversation.id);
    await expect(agent.conversations.appendAssistantMessage(conversation.id, { text: "x" }))
      .rejects.toThrow("unknown active conversation");

    for (const message of ["none", "metadata"] as const) {
      const lossy = await open({ capture: { message } });
      const target = await lossy.conversations.create();
      await expect(lossy.conversations.appendAssistantMessage(target.id, { text: "x" }))
        .rejects.toThrow(`requires message capture "content" or "raw", not "${message}"`);
    }
  }, 30_000);

  test("writes an audit observation and passes the record to the identity runtime", async () => {
    const auditDirectory = await makeDirectory();
    const updates: IdentityUpdateInput[] = [];
    const identity: AgentIdentityRuntime = {
      async load() { return {}; },
      async update(input) { updates.push(input); },
    };
    const agent = await open({
      auditLog: { directory: auditDirectory, capture: { message: "metadata" } },
      identity,
    });
    const conversation = await agent.conversations.create();
    const record = await agent.conversations.appendAssistantMessage(conversation.id, { text: "audited" });

    expect(updates.some((update) => update.records.some((item) => item.recordId === record.recordId)))
      .toBe(true);
    await agent.close();
    agents.splice(agents.indexOf(agent), 1);
    const reader = await AgentAuditLogReader.open({ directory: auditDirectory });
    const entries = (await reader.readPage({ mode: "logical", limit: 1_000 })).entries;
    expect(JSON.stringify(entries)).toContain(record.recordId);
  }, 20_000);
});

describe("out-of-band messages in provider text", () => {
  test("the next turn shows them to the provider but persists only the user's text", async () => {
    const agent = await open();
    const conversation = await agent.conversations.create();
    await agent.conversations.appendAssistantMessage(conversation.id, { text: "BUILD_FINISHED" });

    const first = await conversation.prompt("which ones?");
    const prompt = echoed(first.text);
    expect(prompt).toContain("<messages-you-sent>");
    expect(prompt).toContain("BUILD_FINISHED");
    expect(prompt.indexOf("BUILD_FINISHED")).toBeLessThan(prompt.indexOf("<current-message>\nwhich ones?"));
    const users = (await agent.persistence.messages.list(conversation.id)).messages
      .filter((message) => message.role === "user");
    expect(users.map((message) => message.content)).toEqual(["which ones?"]);

    const second = await conversation.prompt("and now?");
    expect(echoed(second.text)).toBe("and now?");
  }, 20_000);

  test("a failed turn does not count as delivery", async () => {
    const agent = await open();
    const conversation = await agent.conversations.create();
    await agent.conversations.appendAssistantMessage(conversation.id, { text: "RETRY_ME" });
    await expect(conversation.prompt("FAIL_TURN")).rejects.toThrow("intentional echo fixture failure");

    const retried = await conversation.prompt("retry");
    expect(echoed(retried.text)).toContain("RETRY_ME");
  }, 20_000);

  test("a message appended during a turn is delivered on the next turn", async () => {
    const agent = await open();
    const conversation = await agent.conversations.create();
    const running = conversation.prompt("SLOW_TURN");
    await waitFor(async () => (await agent.persistence.messages.list(conversation.id)).messages
      .some((message) => message.role === "user"));
    await agent.conversations.appendAssistantMessage(conversation.id, { text: "MID_TURN" });
    expect(echoed((await running).text)).not.toContain("MID_TURN");

    const next = await conversation.prompt("after");
    expect(echoed(next.text)).toContain("MID_TURN");
    const later = await conversation.prompt("later");
    expect(echoed(later.text)).not.toContain("MID_TURN");
  }, 20_000);

  test("delivery survives closing and reloading the provider session", async () => {
    const path = await sqlitePath();
    let agent = await open({ path });
    const conversation = await agent.conversations.create();
    await conversation.prompt("hi");
    await agent.conversations.appendAssistantMessage(conversation.id, { text: "WHILE_OPEN" });
    await agent.close();
    agents.splice(agents.indexOf(agent), 1);

    agent = await open({ path });
    const reopened = await agent.conversations.open(conversation.id);
    expect(reopened.providerSession).toBe("loaded");
    expect(echoed((await reopened.conversation.prompt("back")).text)).toContain("WHILE_OPEN");
  }, 20_000);

  test("a recovery seed that covered the message counts as delivery", async () => {
    const agent = await open();
    const conversation = await agent.conversations.create();
    await conversation.prompt("hi");
    const appended = await agent.conversations.appendAssistantMessage(conversation.id, { text: "SEEDED" });
    const active = await agent.persistence.providerSessions.active(conversation.id);
    // Stands in for the provider-session record a recovery writes after seeding.
    await agent.persistence.providerSessions.append({
      ...active!,
      providerSessionRecordId: `provider-${crypto.randomUUID()}`,
      activatedAt: new Date().toISOString(),
      transitionId: `recovery-${crypto.randomUUID()}`,
      metadata: JSON.stringify({ recoveredThroughSequence: appended.sequence }),
    });

    expect(echoed((await conversation.prompt("next")).text)).not.toContain("SEEDED");
  }, 20_000);

  test("other conversations see the message through identity", async () => {
    const agent = await open({
      identity: { kind: "checkpoint-backed" },
      checkpointing: { schedule: { milestones: [1_000], everyAfterMilestones: 1_000 } },
    });
    const source = await agent.conversations.create();
    await agent.conversations.appendAssistantMessage(source.id, { text: "CROSS_CONVERSATION_FACT" });
    const target = await agent.conversations.create();
    expect(echoed((await target.prompt("hello")).text)).toContain("CROSS_CONVERSATION_FACT");
  }, 20_000);

  test("keeps the newest messages within the size cap", async () => {
    const agent = await open();
    const conversation = await agent.conversations.create();
    const chunk = "x".repeat(3_000);
    for (const label of ["OLDEST", "MIDDLE", "NEWEST"]) {
      await agent.conversations.appendAssistantMessage(conversation.id, { text: `${label} ${chunk}` });
    }
    const prompt = echoed((await conversation.prompt("hi")).text);
    expect(prompt).not.toContain("OLDEST");
    expect(prompt).toContain("MIDDLE");
    expect(prompt).toContain("NEWEST");
    expect(prompt).toContain("(1 earlier message omitted)");
    expect(prompt.length).toBeLessThan(OUT_OF_BAND_PROMPT_MAX_CHARS + 500);
  }, 20_000);
});

function echoed(text: string): string {
  return (JSON.parse(text) as { prompt: string }).prompt;
}

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acp-out-of-band-"));
  directories.push(directory);
  return directory;
}

async function sqlitePath(): Promise<string> {
  return join(await makeDirectory(), "agent.sqlite");
}

async function open(extra: Partial<AgentConfig> & { path?: string } = {}): Promise<Agent> {
  const { path, ...config } = extra;
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path: path ?? await sqlitePath() },
    adapters: { echo: { command: ["bun", ECHO] } },
    defaultAdapterId: "echo",
    conversationDefaults: { metering: { pricing: false } },
    ...config,
  });
  agents.push(agent);
  return agent;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for condition");
}
