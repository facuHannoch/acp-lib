import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../../src/agent.ts";
import type { ConversationRecoveryProgress } from "../../src/checkpointing/recovery.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("checkpoint recovery", () => {
  test("creates and seeds a new provider session when the recorded one is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-checkpoint-recovery-"));
    roots.push(root);
    const path = join(root, "agent.sqlite");
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../smoke-tests/test5-operations/operations-agent.ts",
    );
    const config = {
      persistence: { kind: "sqlite" as const, path },
      adapters: { test: { command: ["bun", fixture, "fail-load"] } },
      defaultAdapterId: "test",
      conversationDefaults: { metering: { pricing: false } },
      checkpointing: {
        recovery: { isMissingProviderSession: () => true },
      },
    };

    const firstAgent = await Agent.open(config);
    const conversation = await firstAgent.conversations.create();
    const conversationId = conversation.agentConversationId;
    expect((await conversation.prompt("hello")).status).toBe("completed");
    await waitFor(async () => (await firstAgent.checkpointing!.latest(conversationId)) !== null);
    const checkpoint = await firstAgent.checkpointing!.latest(conversationId);
    expect((await conversation.prompt("this happened after the checkpoint")).status).toBe("completed");
    const latestSequence = (await firstAgent.persistence.conversations.get(conversationId))!.latestSequence;
    const oldSessionId = conversation.internalSessionId!;
    await firstAgent.close();

    const progress: ConversationRecoveryProgress[] = [];
    const reopenedAgent = await Agent.open(config);
    const opened = await reopenedAgent.conversations.open(conversationId, {
      onRecoveryProgress: (event) => progress.push(event),
    });

    expect(opened.providerSession).toBe("recovered");
    expect(opened.recovery?.checkpointId).toBe(checkpoint?.checkpointId);
    expect(opened.recovery?.previousInternalSessionId).toBe(oldSessionId);
    expect(opened.recovery?.recoveredThroughSequence).toBe(latestSequence);
    expect(opened.recovery!.recoveredThroughSequence).toBeGreaterThan(checkpoint!.coveredSequence);
    expect(progress.map(({ stage }) => stage)).toEqual([
      "load_failed",
      "loading_checkpoint",
      "loading_checkpoint",
      "creating_session",
      "seeding",
      "completed",
    ]);
    const sessions = await reopenedAgent.persistence.providerSessions.list(conversationId);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.deactivatedAt).toBeDefined();
    expect(JSON.parse(sessions[1]?.metadata ?? "null")?.recoveryCheckpointId)
      .toBe(checkpoint?.checkpointId);
    const actions = await reopenedAgent.persistence.records.list(conversationId, {
      kinds: ["native_action"],
    });
    expect(actions.records.some((record) =>
      record.kind === "native_action"
      && record.action === "conversation_recovery"
      && record.state === "completed")).toBeTrue();
    await reopenedAgent.close();
  }, 15_000);
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for checkpoint");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
