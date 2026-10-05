import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, type AgentConversationId } from "../src/index.ts";
import { createInternalInferenceId } from "../src/internal-inference/ids.ts";
import { createConversationRecoveryCheckpointId } from "../src/checkpointing/ids.ts";

const REPLAY_AGENT = resolve(import.meta.dir, "fixtures/replay-agent.ts");
const STEER_AGENT = resolve(import.meta.dir, "fixtures/steer-agent.ts");
const HISTORY = [
  { sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "text", text: "Hello there" } },
  { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "Hi" } },
];
const agents: Agent[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.close()));
  await Promise.allSettled(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(options: { noDelete?: boolean; failDelete?: boolean; command?: string[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "acp-removal-"));
  directories.push(directory);
  const sessionsFile = join(directory, "sessions.json");
  await writeFile(sessionsFile, JSON.stringify({ "ses-1": HISTORY, "ses-2": HISTORY }));
  process.env.REPLAY_AGENT_FILE = sessionsFile;
  for (const [name, on] of [["NO_DELETE", options.noDelete], ["FAIL_DELETE", options.failDelete]] as const) {
    if (on) process.env[`REPLAY_AGENT_${name}`] = "1";
    else delete process.env[`REPLAY_AGENT_${name}`];
  }
  const path = join(directory, "agent.sqlite");
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path },
    adapters: { replay: { command: options.command ?? ["bun", REPLAY_AGENT] } },
    defaultAdapterId: "replay",
    conversationDefaults: { metering: { pricing: false }, cwd: directory },
  });
  agents.push(agent);
  return { agent, path, sessionsFile, directory };
}

const countRecords = async (agent: Agent, id: AgentConversationId): Promise<number> =>
  (await agent.persistence.records.list(id, { limit: 1000 })).records.length;

/** A checkpoint needs an internal inference row to point at; this makes a completed one the way the manager would. */
async function publishCheckpoint(agent: Agent, id: AgentConversationId, coveredSequence: number): Promise<void> {
  const inferenceId = createInternalInferenceId();
  const jobs = agent.persistence.internalInferences!;
  await jobs.enqueue({
    internalInferenceId: inferenceId,
    agentSessionId: agent.id,
    agentConversationId: id,
    purpose: "conversation_checkpoint",
    adapterId: "replay",
    input: { strategyId: "conversation-checkpoint-v1", strategyVersion: 1, payload: { instruction: "x" } } as never,
    sourceThroughSequence: coveredSequence,
  });
  const claimed = await jobs.claimNext({ workerId: "test", leaseToken: "lease", leaseDurationMs: 60_000 });
  expect(claimed?.attempt.internalInferenceId).toBe(inferenceId);
  await jobs.complete({
    internalInferenceId: inferenceId,
    workerId: "test",
    leaseToken: "lease",
    internalSessionId: "internal",
    completion: {
      internalInferenceId: inferenceId,
      rootInternalInferenceId: inferenceId,
      internalSessionId: "internal",
      purpose: "conversation_checkpoint",
      completedAt: new Date().toISOString(),
    },
  });
  await agent.persistence.recoveryCheckpoints!.publish({
    checkpointId: createConversationRecoveryCheckpointId(),
    agentConversationId: id,
    coveredSequence,
    generatorInternalInferenceId: inferenceId,
    summary: "A summary",
  });
}

describe("clearing a transcript", () => {
  test("deletes the records, keeps the conversation, its participants and provider session, and keeps counting sequences", async () => {
    const { agent, path } = await setup();
    const conversation = await agent.conversations.create({ title: "kept" });
    await conversation.prompt("first");
    await conversation.prompt("second");
    const before = (await agent.persistence.records.list(conversation.id, { limit: 1000 })).records;
    const lastSequence = Math.max(...before.map((record) => record.sequence));
    expect(before.length).toBeGreaterThan(2);

    const result = await agent.conversations.clearTranscript(conversation.id);
    expect(result).toEqual({ recordsDeleted: before.length, checkpointsDeleted: 0 });
    expect(await countRecords(agent, conversation.id)).toBe(0);
    const summary = await agent.conversations.get(conversation.id);
    expect(summary).toMatchObject({ title: "kept" });
    expect(summary?.participants.length).toBeGreaterThan(0);
    expect(await agent.persistence.providerSessions.active(conversation.id)).not.toBeNull();

    // Detail rows and the full-text entries went with them.
    const inspection = new Database(path, { readonly: true });
    expect(inspection.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM conversation_messages").get()?.n).toBe(0);
    expect(inspection.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM conversation_messages_fts WHERE conversation_messages_fts MATCH 'first'").get()?.n).toBe(0);
    inspection.close();

    // The conversation keeps working, and its sequences continue past the deleted ones.
    await conversation.prompt("after");
    const after = (await agent.persistence.records.list(conversation.id, { limit: 1000 })).records;
    expect(after.length).toBeGreaterThan(0);
    expect(Math.min(...after.map((record) => record.sequence))).toBeGreaterThan(lastSequence);
  });

  test("another conversation is untouched", async () => {
    const { agent } = await setup();
    const one = await agent.conversations.create();
    const two = await agent.conversations.create();
    await one.prompt("one");
    await two.prompt("two");
    const kept = await countRecords(agent, two.id);
    await agent.conversations.clearTranscript(one.id);
    expect(await countRecords(agent, two.id)).toBe(kept);
  });

  test("checkpoints are deleted only when asked", async () => {
    const { agent } = await setup();
    const conversation = await agent.conversations.create();
    await conversation.prompt("hello");
    const sequence = Math.max(...(await agent.persistence.records.list(conversation.id, { limit: 1000 })).records.map((r) => r.sequence));
    await publishCheckpoint(agent, conversation.id, sequence);
    expect(await agent.persistence.recoveryCheckpoints!.latest(conversation.id)).not.toBeNull();

    expect(await agent.conversations.clearTranscript(conversation.id)).toMatchObject({ checkpointsDeleted: 0 });
    expect(await agent.persistence.recoveryCheckpoints!.latest(conversation.id)).not.toBeNull();

    const result = await agent.conversations.clearTranscript(conversation.id, { checkpoints: true });
    expect(result.checkpointsDeleted).toBe(1);
    expect(await agent.persistence.recoveryCheckpoints!.latest(conversation.id)).toBeNull();
  });

  test("refuses an unknown or deleted conversation, and one that is busy", async () => {
    const { agent } = await setup({ command: ["bun", STEER_AGENT] });
    await expect(agent.conversations.clearTranscript("agc-00000000-0000-4000-8000-000000000000" as AgentConversationId)).rejects.toThrow(/unknown active conversation/);

    const busy = await agent.conversations.create();
    const running = busy.prompt("Write a detailed 400-word story about a lighthouse keeper named Ottoline.");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(agent.conversations.clearTranscript(busy.id)).rejects.toThrow(/is busy/);
    await running;
    await agent.conversations.clearTranscript(busy.id); // idle again: allowed

    await agent.conversations.delete(busy.id);
    await expect(agent.conversations.clearTranscript(busy.id)).rejects.toThrow(/unknown active conversation/);
  });
});

describe("deleting a conversation", () => {
  test("a deletion time as a string still works, and nothing else is done by default", async () => {
    const { agent } = await setup();
    const conversation = await agent.conversations.create();
    await conversation.prompt("hello");
    const result = await agent.conversations.delete(conversation.id, "2026-10-05T00:00:00.000Z");
    expect(result).toEqual({ providerDeleted: false, checkpointsDeleted: 0 });
    expect((await agent.conversations.list()).conversations).toEqual([]);
    expect((await agent.conversations.get(conversation.id))?.deletedAt).toBe("2026-10-05T00:00:00.000Z");
  });

  test("providerSession: best-effort also deletes the provider's session, and reports it", async () => {
    const { agent, sessionsFile } = await setup();
    const adopted = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: false } });
    const result = await agent.conversations.delete(adopted.id, { providerSession: "best-effort" });
    expect(result.providerDeleted).toBe(true);
    expect(Object.keys(JSON.parse(await readFile(sessionsFile, "utf8")))).toEqual(["ses-2"]);
    expect((await agent.conversations.listProviderSessions()).map((session) => session.providerSessionId)).toEqual(["ses-2"]);
  });

  test("a provider that cannot delete says so; one that fails reports false; the session is left alone either way", async () => {
    const unsupported = await setup({ noDelete: true });
    const first = await unsupported.agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: false } });
    expect((await unsupported.agent.conversations.delete(first.id, { providerSession: "best-effort" })).providerDeleted).toBe("unsupported");

    const failing = await setup({ failDelete: true });
    const second = await failing.agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: false } });
    expect((await failing.agent.conversations.delete(second.id, { providerSession: "best-effort" })).providerDeleted).toBe(false);
    expect(Object.keys(JSON.parse(await readFile(failing.sessionsFile, "utf8")))).toEqual(["ses-1", "ses-2"]);
  });

  test("the default and \"no\" leave the provider's session in place, and the session can be adopted again", async () => {
    const { agent, sessionsFile } = await setup();
    const adopted = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: false } });
    expect((await agent.conversations.delete(adopted.id, { providerSession: "no" })).providerDeleted).toBe(false);
    expect(Object.keys(JSON.parse(await readFile(sessionsFile, "utf8")))).toEqual(["ses-1", "ses-2"]);
    const again = await agent.conversations.create({ adopt: { providerSessionId: "ses-1", recap: false } });
    expect(again.internalSessionId).toBe("ses-1");
  });

  test("a conversation with no recorded provider session has nothing to delete there", async () => {
    const { agent } = await setup();
    const conversation = await agent.conversations.create(); // nothing prompted yet: no recorded provider session
    expect((await agent.conversations.delete(conversation.id, { providerSession: "best-effort" })).providerDeleted).toBe(false);
  });

  test("checkpoints can be deleted with the conversation", async () => {
    const { agent } = await setup();
    const conversation = await agent.conversations.create();
    await conversation.prompt("hello");
    const sequence = Math.max(...(await agent.persistence.records.list(conversation.id, { limit: 1000 })).records.map((r) => r.sequence));
    await publishCheckpoint(agent, conversation.id, sequence);
    const result = await agent.conversations.delete(conversation.id, { checkpoints: true });
    expect(result.checkpointsDeleted).toBe(1);
    expect(await agent.persistence.recoveryCheckpoints!.latest(conversation.id)).toBeNull();
  });
});
