import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Agent,
  AgentAuditLogReader,
  ProviderSessionError,
  type AgentAuditCaptureConfig,
  type AgentConversationId,
  type ConversationPersistenceResolver,
  type ConversationRecord,
  type ConversationRecordCaptureConfig,
} from "../src/index.ts";
import { CONVERSATION_CHECKPOINT_STRATEGY_ID, ConversationCheckpointStrategy } from "../src/checkpointing/strategy.ts";
import { createAgentConversationId } from "../src/agent-ids.ts";
import type { InternalInferenceRuntime } from "../src/internal-inference/contracts.ts";

const OPERATIONS_AGENT = resolve(import.meta.dir, "../smoke-tests/test5-operations/operations-agent.ts");
const agents: Agent[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.close()));
  await Promise.allSettled(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "acp-persistence-policy-"));
  directories.push(path);
  return path;
}

/** A runtime that "summarizes" without a provider, so checkpoints run in a test. */
const summarizingRuntime: InternalInferenceRuntime = {
  async run(request, _signal, lifecycle) {
    await lifecycle?.sessionStarted({ internalSessionId: `summary-${request.internalInferenceId}`, model: "test" });
    return {
      internalInferenceId: request.internalInferenceId,
      internalSessionId: `summary-${request.internalInferenceId}`,
      adapterId: request.adapterId,
      model: "test",
      messages: [{ text: "summary" }],
      usage: null,
    };
  },
};

interface Options {
  label?: string;
  capture?: ConversationRecordCaptureConfig;
  auditCapture?: AgentAuditCaptureConfig;
  audit?: boolean;
  checkpointing?: boolean;
  runtime?: InternalInferenceRuntime;
  retryOnce?: boolean;
  resolver?: ConversationPersistenceResolver;
  identity?: boolean;
  recover?: boolean;
}

async function openAgent(path: string, auditDirectory: string, options: Options = {}): Promise<Agent> {
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path },
    adapters: { operations: { command: ["bun", OPERATIONS_AGENT, options.label ?? "policy"] } },
    defaultAdapterId: "operations",
    conversationDefaults: { metering: { pricing: false } },
    ...(options.capture ? { capture: options.capture } : {}),
    ...(options.audit === false ? {} : { auditLog: { directory: auditDirectory, ...(options.auditCapture ? { capture: options.auditCapture } : {}) } }),
    ...(options.checkpointing
      ? {
          checkpointing: {
            schedule: { milestones: [1], everyAfterMilestones: 50 },
            ...(options.recover ? { recovery: { onLoadFailure: "recover" as const } } : {}),
          },
        }
      : {}),
    ...(options.runtime
      ? {
          internalInference: {
            runtime: options.runtime,
            // The built-in checkpoint strategy is registered by the Agent when checkpointing is enabled.
            ...(options.checkpointing ? {} : { strategies: [new ConversationCheckpointStrategy()] }),
            ...(options.retryOnce ? { retry: { maxAttempts: 1, backoffMs: [0] } } : {}),
          },
        }
      : {}),
    ...(options.identity ? { identity: { kind: "checkpoint-backed" as const } } : {}),
    ...(options.resolver ? { conversationPersistence: options.resolver } : {}),
  });
  agents.push(agent);
  return agent;
}

async function auditEntries(path: string) {
  const reader = await AgentAuditLogReader.open({ directory: path });
  return (await reader.readPage({ mode: "logical", limit: 1_000 })).entries;
}
const aboutConversation = (entry: { agentConversationId?: string; payload: unknown }, id: string): boolean =>
  entry.agentConversationId === id || JSON.stringify(entry.payload).includes(id);

const recordsOf = async (agent: Agent, id: AgentConversationId): Promise<readonly ConversationRecord[]> =>
  (await agent.persistence.records.list(id, { limit: 1000 })).records;

/** A conversation with a stored exchange, made directly so a checkpoint can summarize it. */
async function seedConversation(agent: Agent, title: string): Promise<AgentConversationId> {
  const id = createAgentConversationId();
  await agent.persistence.conversations.create({ agentSessionId: agent.id, agentConversationId: id, title });
  await agent.persistence.records.appendMany([
    { recordId: `${id}-u`, agentSessionId: agent.id, agentConversationId: id, kind: "message", timestamp: new Date().toISOString(), role: "user", content: `remember ${title}` },
    { recordId: `${id}-a`, agentSessionId: agent.id, agentConversationId: id, kind: "message", timestamp: new Date().toISOString(), role: "assistant", content: "noted" },
  ]);
  return id;
}

async function checkpoint(agent: Agent, id: AgentConversationId): Promise<void> {
  const run = await agent.internalInferences!.enqueue({
    purpose: "conversation_checkpoint",
    agentConversationId: id,
    input: { strategyId: CONVERSATION_CHECKPOINT_STRATEGY_ID, version: 1, payload: { instruction: "Summarize." } },
    sourceFromSequence: 0,
    sourceThroughSequence: 2,
    requestedThroughSequence: 2,
  });
  await run.result;
}

const byTitle = (title: string, override: ReturnType<ConversationPersistenceResolver>): ConversationPersistenceResolver =>
  (context) => (context.title === title ? override : undefined);

describe("audit: a conversation can be kept out of the stream", () => {
  test("auditLog: false leaves no entry about the conversation, including the ones caused by its records", async () => {
    const root = await directory();
    const audits = join(root, "audit");
    const agent = await openAgent(join(root, "agent.sqlite"), audits, {
      checkpointing: true,
      runtime: summarizingRuntime,
      resolver: byTitle("private", { auditLog: false }),
    });
    const hidden = await agent.conversations.create({ title: "private" });
    const shown = await agent.conversations.create({ title: "shown" });
    await hidden.prompt("secret hello");
    await shown.prompt("public hello");
    const hiddenSeed = await seedConversation(agent, "private");
    const shownSeed = await seedConversation(agent, "shown");
    await checkpoint(agent, hiddenSeed);
    await checkpoint(agent, shownSeed);
    await agent.close();

    const entries = await auditEntries(audits);
    expect(entries.some((entry) => aboutConversation(entry, shown.id))).toBe(true);
    expect(entries.some((entry) => aboutConversation(entry, shownSeed))).toBe(true);
    for (const id of [hidden.id]) {
      expect(entries.filter((entry) => aboutConversation(entry, id))).toEqual([]);
    }
    // The inference of the hidden seed conversation is audited under agent scope only when it is shown.
    // (The seeded "private" conversation is resolved by title too, so it is hidden as well.)
    expect(entries.filter((entry) => aboutConversation(entry, hiddenSeed))).toEqual([]);
  });

  test("an override on an Agent without an audit log, and an agent-scope kind, are refused before any write", async () => {
    const root = await directory();
    const plain = await openAgent(join(root, "plain.sqlite"), join(root, "a1"), {
      audit: false,
      resolver: () => ({ auditLog: { capture: { message: "content" } } }),
    });
    await expect(plain.conversations.create()).rejects.toThrow(/conversation audit capture requires an Agent audit log/);
    expect((await plain.conversations.list()).conversations).toEqual([]);
    // `false` on an Agent that audits nothing keeps nothing out of nothing: allowed.
    const nothing = await openAgent(join(root, "nothing.sqlite"), join(root, "a3"), { audit: false, resolver: () => ({ auditLog: false }) });
    await nothing.conversations.create();

    const audited = await openAgent(join(root, "audited.sqlite"), join(root, "a2"), {
      resolver: () => ({ auditLog: { capture: { identity: "content" } as never } }),
    });
    await expect(audited.conversations.create()).rejects.toThrow(/cannot select agent-scope kind: identity/);
    expect((await audited.conversations.list()).conversations).toEqual([]);
  });

  test("a load failure under auditLog: false writes no audit entry", async () => {
    const root = await directory();
    const path = join(root, "agent.sqlite");
    const audits = join(root, "audit");
    const seeded = await openAgent(path, join(root, "seed-audit"), { label: "policy", audit: false });
    const created = await seeded.conversations.create();
    await created.prompt("hello");
    const id = created.id;
    await seeded.close();

    const agent = await openAgent(path, audits, { label: "fail-load", resolver: () => ({ auditLog: false }) });
    await expect(agent.conversations.open(id)).rejects.toBeInstanceOf(ProviderSessionError);
    expect((await recordsOf(agent, id)).some((record) => record.kind === "error")).toBe(true); // stored, not audited
    await agent.close();
    expect((await auditEntries(audits)).filter((entry) => aboutConversation(entry, id))).toEqual([]);
  });
});

describe("audit: a conversation's own capture and fingerprint", () => {
  test("its entries use its levels and fingerprint; the Agent's, and the state's, stay the base", async () => {
    const root = await directory();
    const audits = join(root, "audit");
    const agent = await openAgent(join(root, "agent.sqlite"), audits, {
      auditCapture: { message: "metadata" },
      resolver: byTitle("detailed", { auditLog: { capture: { message: "content" } } }),
    });
    const baseFingerprint = (await agent.audit!.status()).captureFingerprint;
    const detailed = await agent.conversations.create({ title: "detailed" });
    const ordinary = await agent.conversations.create({ title: "ordinary" });
    await detailed.prompt("a visible sentence");
    await ordinary.prompt("another visible sentence");
    expect((await agent.audit!.status()).captureFingerprint).toBe(baseFingerprint);
    await agent.close();

    const entries = await auditEntries(audits);
    const messageEntries = (id: string) => entries.filter((entry) => entry.kind === "message" && entry.agentConversationId === id);
    expect(messageEntries(detailed.id).length).toBeGreaterThan(0);
    expect(messageEntries(detailed.id).every((entry) => entry.captureLevel === "content")).toBe(true);
    expect(messageEntries(ordinary.id).every((entry) => entry.captureLevel === "metadata")).toBe(true);
    expect(JSON.stringify(messageEntries(detailed.id).map((entry) => entry.payload))).toContain("a visible sentence");
    expect(JSON.stringify(messageEntries(ordinary.id).map((entry) => entry.payload))).not.toContain("another visible sentence");

    const fingerprintsOf = (id: string) => new Set(messageEntries(id).map((entry) => entry.captureFingerprint));
    expect([...fingerprintsOf(ordinary.id)]).toEqual([baseFingerprint]);
    expect(fingerprintsOf(detailed.id).has(baseFingerprint)).toBe(false);
    // Agent-scope entries carry the base policy's fingerprint.
    expect(entries.filter((entry) => entry.kind === "agent_lifecycle").every((entry) => entry.captureFingerprint === baseFingerprint)).toBe(true);
  });

  test("an override that changes nothing stamps the base fingerprint", async () => {
    const root = await directory();
    const audits = join(root, "audit");
    const agent = await openAgent(join(root, "agent.sqlite"), audits, {
      auditCapture: { message: "metadata" },
      resolver: () => ({ auditLog: { capture: { message: "metadata" } } }),
    });
    const base = (await agent.audit!.status()).captureFingerprint;
    const conversation = await agent.conversations.create();
    await conversation.prompt("hello");
    await agent.close();
    const own = (await auditEntries(audits)).filter((entry) => entry.agentConversationId === conversation.id);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((entry) => entry.captureFingerprint === base)).toBe(true);
  });
});

describe("checkpoint records follow the conversation's policy", () => {
  test("native_action capture and audit apply to the checkpoint record, with and without a resolver", async () => {
    const root = await directory();
    const audits = join(root, "audit");
    const agent = await openAgent(join(root, "agent.sqlite"), audits, {
      checkpointing: true,
      runtime: summarizingRuntime,
      resolver: byTitle("quiet", { capture: { native_action: "none" }, auditLog: false }),
    });
    const quiet = await seedConversation(agent, "quiet");
    const plain = await seedConversation(agent, "plain");
    await checkpoint(agent, quiet);
    await checkpoint(agent, plain);
    const action = (records: readonly ConversationRecord[]) =>
      records.filter((record) => record.kind === "native_action" && record.action === "conversation_checkpoint");
    expect(action(await recordsOf(agent, quiet))).toEqual([]);
    expect(action(await recordsOf(agent, plain))).toHaveLength(1);
    // The checkpoint itself exists for both: only the timeline record is policy.
    expect(await agent.persistence.recoveryCheckpoints!.latest(quiet)).not.toBeNull();
    await agent.close();
    const entries = await auditEntries(audits);
    expect(entries.filter((entry) => entry.kind === "native_action" && entry.agentConversationId === quiet)).toEqual([]);
    expect(entries.filter((entry) => entry.kind === "native_action" && entry.agentConversationId === plain).length).toBeGreaterThan(0);
  });

  test("a resolver that throws during a background checkpoint fails that attempt and writes nothing", async () => {
    const root = await directory();
    const agent = await openAgent(join(root, "agent.sqlite"), join(root, "audit"), {
      checkpointing: true,
      runtime: summarizingRuntime,
      retryOnce: true,
      resolver: () => { throw new Error("resolver cannot answer now"); },
    });
    // Seeded without a start, so the resolver is first asked when the checkpoint runs.
    const id = await seedConversation(agent, "x");
    const run = await agent.internalInferences!.enqueue({
      purpose: "conversation_checkpoint",
      agentConversationId: id,
      input: { strategyId: CONVERSATION_CHECKPOINT_STRATEGY_ID, version: 1, payload: { instruction: "Summarize." } },
      sourceFromSequence: 0,
      sourceThroughSequence: 2,
      requestedThroughSequence: 2,
    });
    await expect(run.result).rejects.toThrow(/resolver cannot answer now/);
    expect(await agent.persistence.recoveryCheckpoints!.latest(id)).toBeNull();
    expect((await recordsOf(agent, id)).some((record) => record.kind === "native_action")).toBe(false);
  });
});

describe("checkpointing with a default that stores no messages", () => {
  test("an Agent may enable checkpointing with message capture none; metadata is refused", async () => {
    const root = await directory();
    const agent = await openAgent(join(root, "a.sqlite"), join(root, "audit"), {
      capture: { message: "none" },
      checkpointing: true,
      runtime: summarizingRuntime,
      resolver: byTitle("recoverable", { capture: { message: "content" } }),
    });
    const recoverable = await agent.conversations.create({ title: "recoverable" });
    const other = await agent.conversations.create({ title: "other" });
    await recoverable.prompt("hello");
    await other.prompt("hello");
    expect((await recordsOf(agent, recoverable.id)).filter((r) => r.kind === "message").length).toBeGreaterThan(0);
    expect((await recordsOf(agent, other.id)).filter((r) => r.kind === "message")).toEqual([]);

    await expect(openAgent(join(root, "b.sqlite"), join(root, "audit-b"), {
      capture: { message: "metadata" },
      checkpointing: true,
      runtime: summarizingRuntime,
    })).rejects.toThrow(/cannot use message capture "metadata"/);
  });

  test("a conversation that stores no messages is never checkpointed, and cannot recover from a checkpoint", async () => {
    const root = await directory();
    const path = join(root, "agent.sqlite");
    const first = await openAgent(path, join(root, "audit"), {
      label: "policy",
      checkpointing: true,
      runtime: summarizingRuntime,
      resolver: byTitle("mute", { capture: { message: "none" } }),
    });
    const mute = await first.conversations.create({ title: "mute" });
    await mute.prompt("one");
    await mute.prompt("two");
    expect(await first.persistence.recoveryCheckpoints!.successfulResponseCount(mute.id)).toBe(0);
    await first.checkpointing!.request(mute.id);
    await Bun.sleep(100);
    expect(await first.persistence.recoveryCheckpoints!.latest(mute.id)).toBeNull();
    const id = mute.id;
    await first.close();

    // With recovery enabled but no checkpoint to recover from, a lost provider session throws.
    const second = await openAgent(path, join(root, "audit"), {
      label: "fail-load",
      checkpointing: true,
      recover: true,
      runtime: summarizingRuntime,
      resolver: byTitle("mute", { capture: { message: "none" } }),
    });
    await expect(second.conversations.open(id)).rejects.toBeInstanceOf(ProviderSessionError);
  });

  test("a sibling's identity context holds nothing from a conversation that stores no messages", async () => {
    const root = await directory();
    const agent = await openAgent(join(root, "agent.sqlite"), join(root, "audit"), {
      checkpointing: true,
      runtime: summarizingRuntime,
      identity: true,
      resolver: byTitle("mute", { capture: { message: "none" } }),
    });
    const mute = await agent.conversations.create({ title: "mute" });
    const talkative = await agent.conversations.create({ title: "talkative" });
    const sibling = await agent.conversations.create({ title: "sibling" });
    await mute.prompt("a secret about turquoise");
    await talkative.prompt("a note about vermilion");
    const identity = await agent.identity.load({
      agentSessionId: agent.id,
      agentConversationId: sibling.id,
      targetProviderContextId: "context-1",
      participant: { id: "user", kind: "user" },
      prompt: "hello",
      consistency: "eventual",
    });
    expect(identity.promptPreamble ?? "").toContain("vermilion");
    expect(identity.promptPreamble ?? "").not.toContain("turquoise");
  });
});

describe("metering retention per conversation", () => {
  test("none keeps no detailed records for that conversation, including its inferences, while another keeps them", async () => {
    const root = await directory();
    const path = join(root, "agent.sqlite");
    const agent = await openAgent(path, join(root, "audit"), {
      checkpointing: true,
      runtime: summarizingRuntime,
      resolver: byTitle("lean", { meteringRecords: "none" }),
    });
    const lean = await agent.conversations.create({ title: "lean" });
    const full = await agent.conversations.create({ title: "full" });
    await lean.prompt("hello");
    await full.prompt("hello");
    const leanSeed = await seedConversation(agent, "lean");
    const fullSeed = await seedConversation(agent, "full");
    await checkpoint(agent, leanSeed);
    await checkpoint(agent, fullSeed);
    await agent.close();

    const database = new Database(path, { readonly: true });
    const detailed = (id: string) =>
      database.query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM metering_records WHERE agent_conversation_id = ? AND record_json IS NOT NULL",
      ).get(id)?.n ?? 0;
    const rows = (id: string) =>
      database.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM metering_records WHERE agent_conversation_id = ?").get(id)?.n ?? 0;
    expect(rows(lean.id)).toBeGreaterThan(0);
    expect(detailed(lean.id)).toBe(0);
    expect(detailed(full.id)).toBeGreaterThan(0);
    expect(rows(leanSeed)).toBeGreaterThan(0);
    expect(detailed(leanSeed)).toBe(0);
    expect(detailed(fullSeed)).toBeGreaterThan(0);
    database.close();
  });

  test("an invalid retention is refused before any write", async () => {
    const root = await directory();
    const agent = await openAgent(join(root, "agent.sqlite"), join(root, "audit"), {
      resolver: () => ({ meteringRecords: { retain: 0 } }),
    });
    await expect(agent.conversations.create()).rejects.toThrow(/invalid meteringRecords retention/);
    expect((await agent.conversations.list()).conversations).toEqual([]);
  });
});
