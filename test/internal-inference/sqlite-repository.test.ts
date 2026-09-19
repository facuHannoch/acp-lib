import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentConversationId, createAgentSessionId } from "../../src/agent-ids.ts";
import { createInternalInferenceId } from "../../src/internal-inference/ids.ts";
import { SqliteAgentPersistence } from "../../src/persistence/sqlite-backend.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQLite internal inference repository", () => {
  test("coalesces active work, leases one attempt, and completes it", async () => {
    const { backend, conversationId } = await fixture();
    const repository = backend.internalInferences;
    const firstId = createInternalInferenceId();
    const first = await repository.enqueue({
      internalInferenceId: firstId,
      agentSessionId: backend.identityRecord.agentSessionId,
      agentConversationId: conversationId,
      purpose: "conversation_checkpoint",
      adapterId: "test",
      input: { version: 1, strategyId: "checkpoint", payload: { throughSequence: 5 } },
      sourceThroughSequence: 5,
      requestedThroughSequence: 5,
    });
    const coalesced = await repository.enqueue({
      internalInferenceId: createInternalInferenceId(),
      agentSessionId: backend.identityRecord.agentSessionId,
      agentConversationId: conversationId,
      purpose: "conversation_checkpoint",
      adapterId: "test",
      input: { version: 1, strategyId: "checkpoint", payload: { throughSequence: 10 } },
      sourceThroughSequence: 10,
      requestedThroughSequence: 10,
    });
    expect(coalesced.attempt.internalInferenceId).toBe(firstId);
    expect((await repository.getChain(firstId))?.requestedThroughSequence).toBe(10);

    const claimed = await repository.claimNext({
      workerId: "worker-a",
      leaseToken: "lease-a",
      leaseDurationMs: 30_000,
    });
    expect(claimed?.attempt.status).toBe("running");
    expect(await repository.claimNext({
      workerId: "worker-b",
      leaseToken: "lease-b",
      leaseDurationMs: 30_000,
    })).toBeNull();
    expect(await repository.heartbeat(firstId, "worker-b", "lease-b", 30_000)).toBeNull();
    expect(await repository.heartbeat(firstId, "worker-a", "lease-a", 30_000)).not.toBeNull();

    await repository.complete({
      internalInferenceId: firstId,
      workerId: "worker-a",
      leaseToken: "lease-a",
      internalSessionId: "provider-1",
      completion: {
        internalInferenceId: firstId,
        rootInternalInferenceId: firstId,
        internalSessionId: "provider-1",
        purpose: "conversation_checkpoint",
        artifactId: "checkpoint-1",
        completedAt: new Date().toISOString(),
      },
    });
    expect((await repository.getAttempt(firstId))?.status).toBe("completed");
    expect((await repository.getChain(firstId))?.status).toBe("completed");
    await backend.close();
  });

  test("keeps a failed attempt and creates a separately identified retry", async () => {
    const { backend, conversationId } = await fixture();
    const repository = backend.internalInferences;
    const rootId = createInternalInferenceId();
    await repository.enqueue({
      internalInferenceId: rootId,
      agentSessionId: backend.identityRecord.agentSessionId,
      agentConversationId: conversationId,
      purpose: "conversation_recovery",
      adapterId: "test",
      input: { version: 1, strategyId: "recovery", payload: null },
    });
    await repository.claimNext({ workerId: "worker", leaseToken: "lease", leaseDurationMs: 30_000 });
    const retryId = createInternalInferenceId();
    await repository.fail({
      internalInferenceId: rootId,
      workerId: "worker",
      leaseToken: "lease",
      error: "temporary",
      failureCode: "provider_unavailable",
      retry: { internalInferenceId: retryId },
    });

    expect((await repository.getAttempt(rootId))?.status).toBe("failed");
    const retry = await repository.getAttempt(retryId);
    expect(retry?.status).toBe("queued");
    expect(retry?.retryOfInternalInferenceId).toBe(rootId);
    expect(retry?.rootInternalInferenceId).toBe(rootId);
    expect(retry?.attemptNumber).toBe(2);
    expect((await repository.getChain(rootId))?.activeInternalInferenceId).toBe(retryId);
    await backend.close();
  });

  test("fences an expired lease and recovers through a new attempt", async () => {
    const { backend, conversationId } = await fixture();
    const repository = backend.internalInferences;
    const rootId = createInternalInferenceId();
    await repository.enqueue({
      internalInferenceId: rootId,
      agentSessionId: backend.identityRecord.agentSessionId,
      agentConversationId: conversationId,
      purpose: "identity_update",
      adapterId: "test",
      input: { version: 1, strategyId: "identity", payload: null },
    });
    await repository.claimNext({
      workerId: "dead-worker",
      leaseToken: "expired-lease",
      leaseDurationMs: 1,
      now: "2026-01-01T00:00:00.000Z",
    });
    const retryId = createInternalInferenceId();
    const abandoned = await repository.recoverExpired({
      retryInternalInferenceId: retryId,
      maxAttempts: 2,
      now: "2026-01-01T00:00:01.000Z",
    });
    expect(abandoned?.failureCode).toBe("lease_expired");
    expect((await repository.getAttempt(retryId))?.attemptNumber).toBe(2);
    expect((await repository.getChain(rootId))?.activeInternalInferenceId).toBe(retryId);
    await backend.close();
  });

  test("prunes complete retry lineages without touching active work", async () => {
    const { backend } = await fixture();
    const repository = backend.internalInferences;
    for (let index = 0; index < 3; index += 1) {
      const id = createInternalInferenceId();
      await repository.enqueue({
        internalInferenceId: id,
        agentSessionId: backend.identityRecord.agentSessionId,
        purpose: "conversation_recovery",
        adapterId: "test",
        input: { version: 1, strategyId: "recovery", payload: { index } },
        requestedAt: `2026-01-01T00:00:0${index}.000Z`,
      });
      await repository.claimNext({
        workerId: `worker-${index}`,
        leaseToken: `lease-${index}`,
        leaseDurationMs: 30_000,
        now: `2026-01-01T00:00:0${index}.000Z`,
      });
      await repository.complete({
        internalInferenceId: id,
        workerId: `worker-${index}`,
        leaseToken: `lease-${index}`,
        internalSessionId: `provider-${index}`,
        completedAt: `2026-01-01T00:00:0${index}.500Z`,
        completion: {
          internalInferenceId: id,
          rootInternalInferenceId: id,
          internalSessionId: `provider-${index}`,
          purpose: "conversation_recovery",
          completedAt: `2026-01-01T00:00:0${index}.500Z`,
        },
      });
    }
    const activeId = createInternalInferenceId();
    await repository.enqueue({
      internalInferenceId: activeId,
      agentSessionId: backend.identityRecord.agentSessionId,
      purpose: "identity_update",
      adapterId: "test",
      input: { version: 1, strategyId: "identity", payload: null },
    });

    expect(await repository.pruneTerminal(1)).toBe(2);
    expect((await repository.list()).attempts).toHaveLength(2);
    expect(await repository.getAttempt(activeId)).not.toBeNull();
    await backend.close();
  });

  test("allows only one lease winner across concurrent claims", async () => {
    const { backend, conversationId } = await fixture();
    const id = createInternalInferenceId();
    await backend.internalInferences.enqueue({
      internalInferenceId: id,
      agentSessionId: backend.identityRecord.agentSessionId,
      agentConversationId: conversationId,
      purpose: "conversation_checkpoint",
      adapterId: "test",
      input: { version: 1, strategyId: "checkpoint", payload: null },
    });

    const claims = await Promise.all([
      backend.internalInferences.claimNext({
        workerId: "process-a",
        leaseToken: "lease-a",
        leaseDurationMs: 30_000,
      }),
      backend.internalInferences.claimNext({
        workerId: "process-b",
        leaseToken: "lease-b",
        leaseDurationMs: 30_000,
      }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.attempt.internalInferenceId).toBe(id);
    await backend.close();
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "acp-inference-"));
  roots.push(root);
  const agentSessionId = createAgentSessionId();
  const backend = await SqliteAgentPersistence.open({
    path: join(root, "agent.sqlite"),
    agentSessionId,
  });
  const conversationId = createAgentConversationId();
  await backend.conversations.create({ agentSessionId, agentConversationId: conversationId });
  return { backend, conversationId };
}
