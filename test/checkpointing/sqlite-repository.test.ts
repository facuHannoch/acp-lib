import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentConversationId } from "../../src/agent-ids.ts";
import { createConversationRecoveryCheckpointId } from "../../src/checkpointing/ids.ts";
import { createInternalInferenceId } from "../../src/internal-inference/ids.ts";
import { SqliteAgentPersistence } from "../../src/persistence/sqlite-backend.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("conversation recovery checkpoint persistence", () => {
  test("publishes an ordered checkpoint lineage and reopens it", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-recovery-checkpoints-"));
    roots.push(root);
    const path = join(root, "agent.sqlite");
    const persistence = await SqliteAgentPersistence.open({ path });
    const conversationId = createAgentConversationId();
    await persistence.conversations.create({
      agentSessionId: persistence.identityRecord.agentSessionId,
      agentConversationId: conversationId,
    });
    const firstInferenceId = await enqueueInference(persistence, conversationId);
    const first = await persistence.recoveryCheckpoints.publish({
      checkpointId: createConversationRecoveryCheckpointId(),
      agentConversationId: conversationId,
      coveredSequence: 2,
      generatorInternalInferenceId: firstInferenceId,
      summary: "The user greeted the agent.",
    });
    const secondInferenceId = await enqueueInference(persistence, conversationId);
    const second = await persistence.recoveryCheckpoints.publish({
      checkpointId: createConversationRecoveryCheckpointId(),
      agentConversationId: conversationId,
      coveredSequence: 8,
      previousCheckpointId: first.checkpointId,
      generatorInternalInferenceId: secondInferenceId,
      summary: "The user greeted the agent and established the answer as four.",
    });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(await persistence.recoveryCheckpoints.latest(conversationId)).toEqual(second);
    expect((await persistence.recoveryCheckpoints.list(conversationId)).map((item) => item.checkpointId))
      .toEqual([second.checkpointId, first.checkpointId]);
    await persistence.close();

    const reopened = await SqliteAgentPersistence.open({ path });
    expect(await reopened.recoveryCheckpoints.get(second.checkpointId)).toEqual(second);
    await reopened.close();
  });

  test("rejects stale lineage publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-recovery-checkpoint-conflict-"));
    roots.push(root);
    const persistence = await SqliteAgentPersistence.open({ path: join(root, "agent.sqlite") });
    const conversationId = createAgentConversationId();
    await persistence.conversations.create({
      agentSessionId: persistence.identityRecord.agentSessionId,
      agentConversationId: conversationId,
    });
    const firstInferenceId = await enqueueInference(persistence, conversationId);
    await persistence.recoveryCheckpoints.publish({
      checkpointId: createConversationRecoveryCheckpointId(),
      agentConversationId: conversationId,
      coveredSequence: 1,
      generatorInternalInferenceId: firstInferenceId,
      summary: "first",
    });
    const staleInferenceId = await enqueueInference(persistence, conversationId);
    await expect(persistence.recoveryCheckpoints.publish({
      checkpointId: createConversationRecoveryCheckpointId(),
      agentConversationId: conversationId,
      coveredSequence: 2,
      generatorInternalInferenceId: staleInferenceId,
      summary: "stale",
    })).rejects.toThrow("previous version changed");
    await persistence.close();
  });
});

async function enqueueInference(
  persistence: SqliteAgentPersistence,
  conversationId: ReturnType<typeof createAgentConversationId>,
) {
  const internalInferenceId = createInternalInferenceId();
  await persistence.internalInferences.enqueue({
    internalInferenceId,
    agentSessionId: persistence.identityRecord.agentSessionId,
    agentConversationId: conversationId,
    purpose: "checkpoint_fixture",
    adapterId: "test",
    input: { strategyId: "test", version: 1, payload: {} },
  });
  return internalInferenceId;
}
