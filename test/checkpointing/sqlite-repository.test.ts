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

  describe("adoption checkpoints", () => {
    async function open() {
      const root = await mkdtemp(join(tmpdir(), "acp-adoption-checkpoints-"));
      roots.push(root);
      const persistence = await SqliteAgentPersistence.open({ path: join(root, "agent.sqlite") });
      const conversationId = createAgentConversationId();
      await persistence.conversations.create({
        agentSessionId: persistence.identityRecord.agentSessionId,
        agentConversationId: conversationId,
      });
      return { persistence, conversationId };
    }

    test("a recap checkpoint has no generator; a baseline has no summary", async () => {
      const { persistence, conversationId } = await open();
      const recap = await persistence.recoveryCheckpoints.publish({
        checkpointId: createConversationRecoveryCheckpointId(),
        agentConversationId: conversationId,
        coveredSequence: 3,
        source: "adoption_recap",
        summary: "what the model said about its own history",
      });
      expect(recap).toMatchObject({ source: "adoption_recap", revision: 1 });
      expect(recap.generatorInternalInferenceId).toBeUndefined();
      expect(await persistence.recoveryCheckpoints.latest(conversationId)).toEqual(recap);

      const baseline = await persistence.recoveryCheckpoints.publish({
        checkpointId: createConversationRecoveryCheckpointId(),
        agentConversationId: conversationId,
        coveredSequence: 7,
        previousCheckpointId: recap.checkpointId,
        source: "adoption_baseline",
        summary: "",
      });
      expect(baseline).toMatchObject({ source: "adoption_baseline", summary: "" });
      await persistence.close();
    });

    test("each source requires what it must have", async () => {
      const { persistence, conversationId } = await open();
      const publish = (input: Record<string, unknown>) => persistence.recoveryCheckpoints.publish({
        checkpointId: createConversationRecoveryCheckpointId(),
        agentConversationId: conversationId,
        coveredSequence: 1,
        ...input,
      } as never);
      const generator = await enqueueInference(persistence, conversationId);
      await expect(publish({ summary: "x" })).rejects.toThrow("must have one");
      await expect(publish({ source: "adoption_recap", summary: "x", generatorInternalInferenceId: generator }))
        .rejects.toThrow("only an internal-inference checkpoint has a generator");
      await expect(publish({ source: "adoption_recap", summary: "  " })).rejects.toThrow("cannot be blank");
      await expect(publish({ generatorInternalInferenceId: generator, summary: "" })).rejects.toThrow("cannot be blank");
      await expect(publish({ source: "adoption_baseline", summary: "not empty" })).rejects.toThrow("has no summary");
      await persistence.close();
    });

    test("the response count starts after the adoption checkpoint's base, not at the first message", async () => {
      const { persistence, conversationId } = await open();
      const agentSessionId = persistence.identityRecord.agentSessionId;
      const response = (id: string) => persistence.records.append({
        recordId: `${id}:assistant`,
        agentSessionId,
        agentConversationId: conversationId,
        kind: "message",
        timestamp: new Date().toISOString(),
        role: "assistant",
        content: id,
        status: "completed",
        metadata: JSON.stringify({ operationId: id }),
      });
      await response("imported-1");
      await response("imported-2");
      await response("imported-3");
      expect(await persistence.recoveryCheckpoints.successfulResponseCount(conversationId)).toBe(3);

      const lastImported = await persistence.recoveryCheckpoints.latestMessageSequence(conversationId);
      await persistence.recoveryCheckpoints.publish({
        checkpointId: createConversationRecoveryCheckpointId(),
        agentConversationId: conversationId,
        coveredSequence: lastImported - 1,
        source: "adoption_baseline",
        summary: "",
        responsesCountedAfterSequence: lastImported,
      });
      expect(await persistence.recoveryCheckpoints.successfulResponseCount(conversationId)).toBe(0);
      await response("live-1");
      await response("live-2");
      expect(await persistence.recoveryCheckpoints.successfulResponseCount(conversationId)).toBe(2);

      // A later internal-inference checkpoint does not move the base.
      const generator = await enqueueInference(persistence, conversationId);
      const latest = await persistence.recoveryCheckpoints.latest(conversationId);
      await persistence.recoveryCheckpoints.publish({
        checkpointId: createConversationRecoveryCheckpointId(),
        agentConversationId: conversationId,
        coveredSequence: await persistence.recoveryCheckpoints.latestMessageSequence(conversationId),
        previousCheckpointId: latest!.checkpointId,
        generatorInternalInferenceId: generator,
        summary: "later",
      });
      expect(await persistence.recoveryCheckpoints.successfulResponseCount(conversationId)).toBe(2);
      await persistence.close();
    });
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
