import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Agent,
  ProviderSessionError,
  type ConversationRecord,
  type AgentConversationId,
  type ConversationRecordCaptureConfig,
} from "../src/index.ts";

const OPERATIONS_AGENT = resolve(import.meta.dir, "../smoke-tests/test5-operations/operations-agent.ts");
const agents: Agent[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.close()));
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acp-error-records-"));
  directories.push(directory);
  return directory;
}

function track(agentPromise: Promise<Agent>): Promise<Agent> {
  return agentPromise.then((agent) => {
    agents.push(agent);
    return agent;
  });
}

function openOperations(path: string, label: string, extra: {
  capture?: ConversationRecordCaptureConfig;
  recovery?: { onLoadFailure?: "error" | "recover"; isMissingProviderSession?: (error: unknown) => boolean };
  checkpointing?: boolean;
} = {}): Promise<Agent> {
  return Agent.open({
    persistence: { kind: "sqlite", path },
    adapters: { operations: { command: ["bun", OPERATIONS_AGENT, label] } },
    defaultAdapterId: "operations",
    conversationDefaults: { metering: { pricing: false } },
    ...(extra.capture ? { capture: extra.capture } : {}),
    ...(extra.checkpointing
      ? {
          checkpointing: {
            schedule: { milestones: [1], everyAfterMilestones: 50 },
            ...(extra.recovery ? { recovery: extra.recovery } : {}),
          },
        }
      : {}),
  });
}

async function seedRecordedConversation(path: string): Promise<{
  conversationId: AgentConversationId;
  recorded: string;
  before: NonNullable<Awaited<ReturnType<Agent["persistence"]["conversations"]["get"]>>>;
}> {
  const first = await track(openOperations(path, "owned"));
  const conversation = await first.conversations.create();
  const recorded = conversation.internalSessionId!;
  await conversation.prompt("record the provider thread");
  const before = (await first.persistence.conversations.get(conversation.id))!;
  await conversation.stop();
  await first.close();
  agents.splice(agents.indexOf(first), 1);
  return { conversationId: conversation.id, recorded, before };
}

describe("provider-session load error records", () => {
  test("a failed load records an ordered error and throws a structured error", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const { conversationId, recorded, before } = await seedRecordedConversation(path);
    // The reopened agent exposes the same adapter id with a load-failing command.
    const agent = await track(openOperations(path, "fail-load"));
    const events: ConversationRecord[] = [];
    agent.events.subscribe((notification) => events.push(notification.event.record), {
      conversationIds: [conversationId],
    });

    const caught = await agent.conversations.open(conversationId).then(() => null, (error: unknown) => error);
    expect(caught).toBeInstanceOf(ProviderSessionError);
    if (!(caught instanceof ProviderSessionError)) return;
    expect(caught.code).toBe("provider_session_load_failed");
    expect(caught.recoverability).toBe("unknown");
    expect(caught.source).toBe("provider_session");
    expect(caught.agentConversationId).toBe(conversationId);
    expect(caught.internalSessionId).toBe(recorded);
    expect(caught.attemptId).toMatch(/^provider-load-/);
    expect(caught.recordId).toBe(`${caught.attemptId}:error`);

    const records = (await agent.persistence.records.list(conversationId, { kinds: ["error"] })).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      recordId: `${caught.attemptId}:error`,
      source: "provider_session",
      code: "provider_session_load_failed",
      recoverability: "unknown",
      internalSessionId: recorded,
      transitionId: caught.attemptId,
    });
    // The committed error reached the live bus before open rejected.
    expect(events.map((record) => record.recordId)).toContain(records[0]!.recordId);

    // The failed provider mapping remains as evidence.
    expect((await agent.persistence.providerSessions.active(conversationId))?.internalSessionId).toBe(recorded);

    // An error advances conversation sequence and recency without becoming a message.
    const after = await agent.persistence.conversations.get(conversationId);
    expect(after!.latestSequence).toBeGreaterThan(before!.latestSequence);
    const messages = (await agent.persistence.messages.list(conversationId)).messages;
    expect(messages.every((message) => message.role === "user" || message.role === "assistant")).toBe(true);
  });

  test("capture.error none writes no canonical row but keeps the structured error", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const { conversationId } = await seedRecordedConversation(path);

    const agent = await track(openOperations(path, "fail-load", { capture: { error: "none" } }));
    const caught = await agent.conversations.open(conversationId).then(() => null, (error: unknown) => error);
    expect(caught).toBeInstanceOf(ProviderSessionError);
    if (!(caught instanceof ProviderSessionError)) return;
    expect(caught.code).toBe("provider_session_load_failed");
    expect(caught.recordId).toBeUndefined();
    expect((await agent.persistence.records.list(conversationId, { kinds: ["error"] })).records).toEqual([]);
  });

  test("metadata capture projects the error record without message or details", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const { conversationId } = await seedRecordedConversation(path);

    const agent = await track(openOperations(path, "fail-load", { capture: { error: "metadata" } }));
    await agent.conversations.open(conversationId).catch(() => undefined);
    const records = (await agent.persistence.records.list(conversationId, { kinds: ["error"] })).records;
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.kind).toBe("error");
    expect(record.kind === "error" ? record.message : "present").toBeUndefined();
    expect(record.kind === "error" ? record.details : "present").toBeUndefined();
    expect(record.kind === "error" ? record.code : "").toBe("provider_session_load_failed");
  });

  test("a missing session records the load error before recovery action records", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const first = await track(openOperations(path, "owned", { checkpointing: true }));
    const conversation = await first.conversations.create();
    const conversationId = conversation.id;
    const recorded = conversation.internalSessionId!;
    await conversation.prompt("hello");
    await waitFor(async () => (await first.checkpointing!.latest(conversationId)) !== null);
    await conversation.stop();
    await first.close();
    agents.splice(agents.indexOf(first), 1);

    const agent = await track(openOperations(path, "fail-load", {
      checkpointing: true,
      recovery: { onLoadFailure: "recover", isMissingProviderSession: () => true },
    }));
    const events: ConversationRecord[] = [];
    agent.events.subscribe((notification) => events.push(notification.event.record), {
      conversationIds: [conversationId],
    });
    const opened = await agent.conversations.open(conversationId);
    expect(opened.providerSession).toBe("recovered");

    const records = (await agent.persistence.records.list(conversationId, { limit: 1_000 })).records;
    const errorRecord = records.find((record) => record.kind === "error");
    expect(errorRecord).toMatchObject({
      source: "provider_session",
      code: "provider_session_missing",
      recoverability: "recoverable",
      internalSessionId: recorded,
    });
    const recoveryStarted = records.find(
      (record) => record.kind === "native_action"
        && record.action === "conversation_recovery"
        && record.state === "started",
    );
    expect(recoveryStarted).toBeDefined();
    expect(errorRecord!.sequence).toBeLessThan(recoveryStarted!.sequence);
    expect(events.some((record) => record.kind === "error")).toBe(true);
  });

  test("a missing session with no checkpoint still records the error and throws", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const { conversationId } = await seedRecordedConversation(path);

    const agent = await track(openOperations(path, "fail-load", {
      checkpointing: true,
      recovery: { onLoadFailure: "recover", isMissingProviderSession: () => true },
    }));
    const caught = await agent.conversations.open(conversationId).then(() => null, (error: unknown) => error);
    expect(caught).toBeInstanceOf(ProviderSessionError);
    if (!(caught instanceof ProviderSessionError)) return;
    expect(caught.code).toBe("provider_session_missing");
    expect(caught.recoverability).toBe("recoverable");
    const records = (await agent.persistence.records.list(conversationId, { kinds: ["error"] })).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ code: "provider_session_missing", recoverability: "recoverable" });
  });
});

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for condition");
}
