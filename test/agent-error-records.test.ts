import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Agent,
  AgentAuditLogReader,
  ProviderSessionError,
  type AgentConversationId,
  type AgentIdentityRuntime,
  type ConversationRecord,
  type ConversationRecordCaptureConfig,
  type IdentityLoadInput,
  type IdentityUpdateInput,
  type LoadedIdentityContext,
  type RecordCaptureLevel,
} from "../src/index.ts";
import { createAgentConversationId } from "../src/agent-ids.ts";
import {
  CONVERSATION_CHECKPOINT_STRATEGY_ID,
  ConversationCheckpointStrategy,
} from "../src/checkpointing/strategy.ts";
import type { InternalInferenceRuntime } from "../src/internal-inference/contracts.ts";
import { AgentSessionHandoffError } from "../src/metering/record.ts";

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
  recovery?: {
    onLoadFailure?: "error" | "recover";
    isMissingProviderSession?: (error: unknown) => boolean;
    seedInstruction?: string;
  };
  checkpointing?: boolean;
  identity?: AgentIdentityRuntime;
  auditDirectory?: string;
  auditErrorCapture?: RecordCaptureLevel;
} = {}): Promise<Agent> {
  return Agent.open({
    persistence: { kind: "sqlite", path },
    adapters: { operations: { command: ["bun", OPERATIONS_AGENT, label] } },
    defaultAdapterId: "operations",
    conversationDefaults: { metering: { pricing: false } },
    ...(extra.capture ? { capture: extra.capture } : {}),
    ...(extra.identity ? { identity: extra.identity } : {}),
    ...(extra.auditDirectory
      ? {
          auditLog: {
            directory: extra.auditDirectory,
            ...(extra.auditErrorCapture ? { capture: { error: extra.auditErrorCapture } } : {}),
          },
        }
      : {}),
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

class RecordingIdentity implements AgentIdentityRuntime {
  readonly updates: IdentityUpdateInput[] = [];

  async load(_input: IdentityLoadInput): Promise<LoadedIdentityContext> {
    return { promptPreamble: "" };
  }

  async update(input: IdentityUpdateInput): Promise<void> {
    this.updates.push(input);
  }
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

  test("a failed creation records an error with its conversation id", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path },
      adapters: { broken: { command: ["bun", "-e", "process.exit(1)"] } },
      defaultAdapterId: "broken",
      conversationDefaults: { metering: { pricing: false } },
    }));
    const caught = await agent.conversations.create().then(() => null, (error: unknown) => error);
    expect(caught).toBeInstanceOf(ProviderSessionError);
    if (!(caught instanceof ProviderSessionError)) return;
    expect(caught.code).toBe("provider_session_create_failed");
    expect(caught.source).toBe("provider_session");
    expect(caught.recoverability).toBe("retryable");
    expect(caught.message).toBe("The provider session could not be created.");
    expect(caught.attemptId).toMatch(/^provider-create-/);
    expect(caught.recordId).toBe(`${caught.attemptId}:error`);

    const records = (await agent.persistence.records.list(caught.agentConversationId, {
      kinds: ["error"],
    })).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      recordId: `${caught.attemptId}:error`,
      code: "provider_session_create_failed",
      recoverability: "retryable",
    });
  });

  test("a recovery failure records recovery_failed after the load error", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const first = await track(openOperations(path, "owned", { checkpointing: true }));
    const conversation = await first.conversations.create();
    const conversationId = conversation.id;
    await conversation.prompt("hello");
    await waitFor(async () => (await first.checkpointing!.latest(conversationId)) !== null);
    await conversation.stop();
    await first.close();
    agents.splice(agents.indexOf(first), 1);

    const agent = await track(openOperations(path, "fail-load-seed", {
      checkpointing: true,
      recovery: {
        onLoadFailure: "recover",
        isMissingProviderSession: () => true,
        seedInstruction: "Continue this conversation",
      },
    }));
    const caught = await agent.conversations.open(conversationId).then(() => null, (error: unknown) => error);
    expect(caught).toBeInstanceOf(ProviderSessionError);
    if (!(caught instanceof ProviderSessionError)) return;
    expect(caught.code).toBe("recovery_failed");
    expect(caught.source).toBe("recovery");
    expect(caught.recoverability).toBe("recoverable");

    const records = (await agent.persistence.records.list(conversationId, {
      kinds: ["error"],
      limit: 100,
    })).records;
    expect(records.map((record) => record.kind === "error" ? record.code : "")).toEqual([
      "provider_session_missing",
      "recovery_failed",
    ]);
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

describe("error record boundaries", () => {
  test("caller configuration mistakes are not persisted and orphan no conversation", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path },
      adapters: { operations: { command: ["bun", OPERATIONS_AGENT, "owned"] } },
      defaultAdapterId: "operations",
      conversationDefaults: { metering: { pricing: false } },
    }));

    const unknownAdapter = await agent.conversations.create({ adapterId: "does-not-exist" })
      .then(() => null, (error: unknown) => error);
    expect(unknownAdapter).toBeInstanceOf(Error);
    expect(unknownAdapter).not.toBeInstanceOf(ProviderSessionError);
    expect((await agent.persistence.conversations.list({ limit: 100 })).conversations).toHaveLength(0);
  });

  test("an Agent without a unique default adapter rejects before writing a conversation", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path },
      adapters: {
        a: { command: ["bun", OPERATIONS_AGENT, "owned"] },
        b: { command: ["bun", OPERATIONS_AGENT, "owned"] },
      },
      conversationDefaults: { metering: { pricing: false } },
    }));

    const caught = await agent.conversations.create().then(() => null, (error: unknown) => error);
    expect(caught).not.toBeInstanceOf(ProviderSessionError);
    expect((await agent.persistence.conversations.list({ limit: 100 })).conversations).toHaveLength(0);
  });

  test("canonical and audit error capture are independent", async () => {
    // Canonical none, audit content: no canonical row, one audit error entry.
    const canonicalOff = await makeDirectory();
    const canonicalOffPath = join(canonicalOff, "agent.sqlite");
    const canonicalOffAudit = join(canonicalOff, "audit");
    const canonicalOffSeed = await seedRecordedConversation(canonicalOffPath);
    const canonicalOffAgent = await track(openOperations(canonicalOffPath, "fail-load", {
      capture: { error: "none" },
      auditDirectory: canonicalOffAudit,
      auditErrorCapture: "content",
    }));
    await canonicalOffAgent.conversations.open(canonicalOffSeed.conversationId).catch(() => undefined);
    await canonicalOffAgent.audit!.flush({ timeoutMs: 5_000 });
    expect((await canonicalOffAgent.persistence.records.list(canonicalOffSeed.conversationId, {
      kinds: ["error"],
    })).records).toEqual([]);
    expect(await auditKinds(canonicalOffAudit)).toContain("error");

    // Canonical content, audit none: one canonical row, no audit error entry.
    const auditOff = await makeDirectory();
    const auditOffPath = join(auditOff, "agent.sqlite");
    const auditOffAudit = join(auditOff, "audit");
    const auditOffSeed = await seedRecordedConversation(auditOffPath);
    const auditOffAgent = await track(openOperations(auditOffPath, "fail-load", {
      capture: { error: "content" },
      auditDirectory: auditOffAudit,
      auditErrorCapture: "none",
    }));
    await auditOffAgent.conversations.open(auditOffSeed.conversationId).catch(() => undefined);
    await auditOffAgent.audit!.flush({ timeoutMs: 5_000 });
    expect((await auditOffAgent.persistence.records.list(auditOffSeed.conversationId, {
      kinds: ["error"],
    })).records).toHaveLength(1);
    expect(await auditKinds(auditOffAudit)).not.toContain("error");
  });

  test("error records never enter identity delivery", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const { conversationId } = await seedRecordedConversation(path);
    const identity = new RecordingIdentity();
    const agent = await track(openOperations(path, "fail-load", { identity }));
    await agent.conversations.open(conversationId).catch(() => undefined);
    expect(identity.updates.flatMap((update) => update.records)
      .some((record) => record.kind === "error")).toBe(false);
  });

  test("error records never enter checkpoint summaries", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const prompts: string[] = [];
    const runtime: InternalInferenceRuntime = {
      async run(request, _signal, lifecycle) {
        prompts.push(request.prompt);
        await lifecycle?.sessionStarted({
          internalSessionId: `summary-${request.internalInferenceId}`,
          model: "test",
        });
        return {
          internalInferenceId: request.internalInferenceId,
          internalSessionId: `summary-${request.internalInferenceId}`,
          adapterId: request.adapterId,
          model: "test",
          messages: [{ type: "text", text: "summary" }],
          usage: null,
        };
      },
    };
    const agent = await track(Agent.open({
      persistence: { kind: "sqlite", path },
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
        recordId: "msg-user",
        agentSessionId: agent.id,
        agentConversationId: conversationId,
        kind: "message",
        timestamp: new Date().toISOString(),
        role: "user",
        content: "remember the blue door",
      },
      {
        recordId: "msg-assistant",
        agentSessionId: agent.id,
        agentConversationId: conversationId,
        kind: "message",
        timestamp: new Date().toISOString(),
        role: "assistant",
        content: "noted",
      },
      {
        recordId: "provider-load-x:error",
        agentSessionId: agent.id,
        agentConversationId: conversationId,
        kind: "error",
        timestamp: new Date().toISOString(),
        source: "provider_session",
        code: "provider_session_missing",
        recoverability: "recoverable",
        message: "SECRET_ERROR_TEXT must not reach a summary",
      },
    ]);

    const run = await agent.internalInferences!.enqueue({
      purpose: "conversation_checkpoint",
      agentConversationId: conversationId,
      input: {
        strategyId: CONVERSATION_CHECKPOINT_STRATEGY_ID,
        version: 1,
        payload: { instruction: "Summarize for continuation." },
      },
      sourceFromSequence: 0,
      sourceThroughSequence: 3,
      requestedThroughSequence: 3,
    });
    await run.result;

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("remember the blue door");
    expect(prompts[0]).not.toContain("SECRET_ERROR_TEXT");
    expect(prompts[0]).not.toContain("provider_session_missing");
  });

  test("a recording failure attaches recordingError and keeps the primary error", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const { conversationId } = await seedRecordedConversation(path);
    const agent = await track(openOperations(path, "fail-load"));
    const backend = agent.persistence;
    const originalTransaction = backend.transaction.bind(backend);
    backend.transaction = async () => {
      throw new Error("intentional recording failure");
    };
    try {
      const caught = await agent.conversations.open(conversationId).then(() => null, (error: unknown) => error);
      expect(caught).toBeInstanceOf(ProviderSessionError);
      if (!(caught instanceof ProviderSessionError)) return;
      expect(caught.code).toBe("provider_session_load_failed");
      expect(caught.recordId).toBeUndefined();
      expect(caught.recordingError?.message).toBe("intentional recording failure");
      expect(caught.cause).toBeDefined();
    } finally {
      backend.transaction = originalTransaction;
    }
  });

  test("a failed native action does not create a duplicate error record", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const agent = await track(openOperations(path, "fail-seed"));
    const conversation = await agent.conversations.create();
    await conversation.prompt("record the source thread");
    const caught = await conversation.handoff({
      continuation: { kind: "provided", content: "portable continuation context" },
    }).then(() => null, (error: unknown) => error);
    expect(caught).toBeInstanceOf(AgentSessionHandoffError);

    const records = (await agent.persistence.records.list(conversation.id, { limit: 1_000 })).records;
    expect(records.some(
      (record) => record.kind === "native_action" && record.state === "failed",
    )).toBe(true);
    expect(records.filter((record) => record.kind === "error")).toHaveLength(0);
  });
});

async function auditKinds(directory: string): Promise<string[]> {
  const reader = await AgentAuditLogReader.open({ directory });
  return (await reader.readPage({ mode: "logical", limit: 1_000 })).entries.map((entry) => entry.kind);
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for condition");
}
