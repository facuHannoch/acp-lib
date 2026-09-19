import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentConversationId, createAgentSessionId } from "../src/agent-ids.ts";
import type { ConversationRecoveryCheckpoint } from "../src/checkpointing/contracts.ts";
import { CheckpointBackedIdentityRuntime } from "../src/identity/checkpoint-backed.ts";
import type { IdentityLoadInput } from "../src/identity.ts";
import type { PersistenceBackend } from "../src/persistence/backend.ts";
import { SqliteAgentPersistence } from "../src/persistence/sqlite-backend.ts";

const backends: SqliteAgentPersistence[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(backends.splice(0).map((backend) => backend.close()));
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("checkpoint-backed identity", () => {
  test("renders source messages compactly without losing speaker or multiline boundaries", async () => {
    const fixture = await makeFixture();
    await fixture.add(fixture.source, "Hello.\nReply with only READY.", "user:default");
    const loaded = await fixture.runtime.load(fixture.input());
    expect(loaded.promptPreamble).toContain('[1] user (user:default): "Hello.\\nReply with only READY."');
    expect(loaded.promptPreamble).not.toContain('"participantId":');
    expect(loaded.promptPreamble).not.toContain('"content":');
  });

  test("bootstraps from a checkpoint plus uncovered tail, then delivers only new messages", async () => {
    const fixture = await makeFixture();
    await fixture.add(fixture.source, "first");
    await fixture.add(fixture.source, "second");
    await fixture.add(fixture.source, "third");
    fixture.checkpoints.set(fixture.source, checkpoint(fixture.source, 2, "summary of first and second"));

    const first = await fixture.runtime.load(fixture.input());
    expect(first.promptPreamble).toContain("summary of first and second");
    expect(first.promptPreamble).toContain('[3] user (user:default): "third"');
    expect(first.promptPreamble).not.toContain('[1] user (user:default): "first"');
    expect(first.deliveryReceipt?.sources).toEqual([{
      sourceConversationId: fixture.source,
      deliveredThroughSequence: 3,
    }]);
    await fixture.runtime.delivered(first.deliveryReceipt!);

    expect(await fixture.runtime.load(fixture.input())).toEqual({});
    await fixture.add(fixture.source, "fourth");
    const delta = await fixture.runtime.load(fixture.input());
    expect(delta.promptPreamble).toContain("fourth");
    expect(delta.promptPreamble).not.toContain("summary of first and second");
    await fixture.runtime.delivered(delta.deliveryReceipt!);

    const freshThread = await fixture.runtime.load(fixture.input("provider-replaced"));
    expect(freshThread.promptPreamble).toContain("summary of first and second");
    expect(freshThread.promptPreamble).toContain("fourth");
    expect(freshThread.promptPreamble).not.toContain(`Source conversation ${fixture.target}`);
  });

  test("creates source cursors lazily and never advances past the bounded delivered prefix", async () => {
    const fixture = await makeFixture({ maxContextChars: 1000, maxSourceChars: 150 });
    await fixture.add(fixture.source, "first bounded message");
    await fixture.add(fixture.source, "second bounded message");
    await fixture.add(fixture.source, "third bounded message");
    const first = await fixture.runtime.load(fixture.input());
    expect(first.deliveryReceipt?.sources[0]?.deliveredThroughSequence).toBeLessThan(3);
    await fixture.runtime.delivered(first.deliveryReceipt!);
    const second = await fixture.runtime.load(fixture.input());
    expect(second.deliveryReceipt?.sources[0]?.deliveredThroughSequence).toBeGreaterThan(
      first.deliveryReceipt!.sources[0]!.deliveredThroughSequence,
    );
    await expect(fixture.runtime.load({ ...fixture.input("strict-thread"), consistency: "through-current" }))
      .rejects.toThrow("cannot include every available");

    const anotherSource = createAgentConversationId();
    await fixture.backend.conversations.create({
      agentSessionId: fixture.agentId,
      agentConversationId: anotherSource,
    });
    await fixture.add(anotherSource, "new source appeared");
    const fresh = await fixture.runtime.load(fixture.input("another-target-thread"));
    expect(fresh.promptPreamble).toContain("new source appeared");
    expect(await fixture.backend.identityDelivery.get(fixture.target, "another-target-thread", anotherSource)).toBeNull();
  });

  test("uses a newer checkpoint to bridge an oversized undelivered delta", async () => {
    const fixture = await makeFixture({ maxContextChars: 1000, maxSourceChars: 260 });
    await fixture.add(fixture.source, "a");
    const first = await fixture.runtime.load(fixture.input());
    await fixture.runtime.delivered(first.deliveryReceipt!);
    for (let index = 2; index <= 10; index++) await fixture.add(fixture.source, `message-${index}`);
    fixture.checkpoints.set(fixture.source, checkpoint(fixture.source, 8, "compressed through eight"));

    const catchup = await fixture.runtime.load(fixture.input());
    expect(catchup.promptPreamble).toContain("compressed through eight");
    expect(catchup.deliveryReceipt?.sources[0]?.deliveredThroughSequence).toBeGreaterThanOrEqual(8);
  });

  test("tracks two source conversations independently", async () => {
    const fixture = await makeFixture();
    const otherSource = createAgentConversationId();
    await fixture.backend.conversations.create({
      agentSessionId: fixture.agentId,
      agentConversationId: otherSource,
    });
    await fixture.add(fixture.source, "source one initial");
    await fixture.add(otherSource, "source two initial");
    const first = await fixture.runtime.load(fixture.input());
    expect(first.deliveryReceipt?.sources).toHaveLength(2);
    await fixture.runtime.delivered(first.deliveryReceipt!);

    await fixture.add(otherSource, "source two new");
    const second = await fixture.runtime.load(fixture.input());
    expect(second.deliveryReceipt?.sources.map((source) => source.sourceConversationId)).toEqual([otherSource]);
    await fixture.runtime.delivered(second.deliveryReceipt!);
    await fixture.add(fixture.source, "source one new");
    const third = await fixture.runtime.load(fixture.input());
    expect(third.deliveryReceipt?.sources.map((source) => source.sourceConversationId)).toEqual([fixture.source]);
  });
});

async function makeFixture(config: { maxContextChars?: number; maxSourceChars?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "acp-identity-"));
  directories.push(directory);
  const agentId = createAgentSessionId();
  const backend = await SqliteAgentPersistence.open({ path: join(directory, "agent.sqlite"), agentSessionId: agentId });
  backends.push(backend);
  const source = createAgentConversationId();
  const target = createAgentConversationId();
  await backend.conversations.create({ agentSessionId: agentId, agentConversationId: source });
  await backend.conversations.create({ agentSessionId: agentId, agentConversationId: target });
  const checkpoints = new Map<string, ConversationRecoveryCheckpoint>();
  const repository = {
    latest: async (id: string) => checkpoints.get(id) ?? null,
    latestMessageSequence: backend.recoveryCheckpoints.latestMessageSequence.bind(backend.recoveryCheckpoints),
  };
  const persistence = Object.assign(Object.create(backend), { recoveryCheckpoints: repository }) as PersistenceBackend;
  const runtime = new CheckpointBackedIdentityRuntime(persistence, { kind: "checkpoint-backed", ...config });
  let nextRecord = 0;
  return {
    agentId, backend, source, target, checkpoints, runtime,
    input: (provider = "provider-one"): IdentityLoadInput => ({
      agentSessionId: agentId,
      agentConversationId: target,
      targetProviderContextId: provider,
      prompt: "current question",
      consistency: "eventual",
    }),
    add: async (conversationId: typeof source, content: string, participantId?: string) => await backend.records.append({
      recordId: `identity-message-${++nextRecord}`,
      agentSessionId: agentId,
      agentConversationId: conversationId,
      kind: "message",
      role: "user",
      ...(participantId ? { participantId } : {}),
      content,
      timestamp: new Date().toISOString(),
      status: "completed",
    }),
  };
}

function checkpoint(conversationId: ReturnType<typeof createAgentConversationId>, coveredSequence: number, summary: string): ConversationRecoveryCheckpoint {
  return {
    checkpointId: `chk-unit-${coveredSequence}`,
    agentConversationId: conversationId,
    revision: 1,
    coveredSequence,
    generatorInternalInferenceId: `aii-unit-${coveredSequence}`,
    summary,
    createdAt: new Date().toISOString(),
  };
}
