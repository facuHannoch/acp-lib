import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../../src/agent.ts";
import type { ConversationRecoveryProgress } from "../../src/checkpointing/recovery.ts";
import {
  classifyProviderSessionLoadError,
  isMissingProviderSessionError,
} from "../../src/checkpointing/recovery.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("checkpoint recovery", () => {
  test("recognizes provider missing-session errors without treating arbitrary failures as missing", () => {
    expect(isMissingProviderSessionError({
      message: "Internal error",
      data: { details: "no rollout found for thread id missing-id" },
    })).toBeTrue();
    expect(isMissingProviderSessionError({
      code: -32603,
      message: "Internal error: OpenCode service failure",
      data: { service: "session" },
    })).toBeTrue();
    expect(isMissingProviderSessionError({
      code: -32603,
      message: "Internal error: OpenCode service failure",
      data: { service: "provider" },
    })).toBeFalse();
    expect(isMissingProviderSessionError({
      code: -32002,
      message: "Resource not found: 1693ca18-ac92-404e-8cc2-375d3a6899da",
      data: { uri: "1693ca18-ac92-404e-8cc2-375d3a6899da" },
    })).toBeTrue();
    expect(isMissingProviderSessionError({
      code: -32603,
      message: "Internal error",
      data: { details: "session 01a1 is archived. Run `codex unarchive 01a1` to unarchive it first." },
    })).toBeTrue();
    // Grok Build, `session/load` of an id it has no file for (measured on grok 1.0.70).
    expect(isMissingProviderSessionError({
      code: -32603,
      message: "Path not found.",
      data: { detail: "No such file or directory (os error 2)", code: "FS_NOT_FOUND" },
    })).toBeTrue();
    expect(isMissingProviderSessionError({
      code: -32603,
      message: "Path not found.",
      data: { code: "FS_PERMISSION_DENIED" },
    })).toBeFalse();
    expect(isMissingProviderSessionError({ code: -32603, message: "Internal error" })).toBeFalse();
    expect(isMissingProviderSessionError(new Error("authentication failed"))).toBeFalse();
  });

  test("classifies a load failure conservatively", () => {
    expect(classifyProviderSessionLoadError({ message: "session not found" })).toEqual({
      missing: true,
      code: "provider_session_missing",
      recoverability: "recoverable",
    });
    expect(classifyProviderSessionLoadError(new Error("authentication failed"))).toEqual({
      missing: false,
      code: "provider_session_load_failed",
      recoverability: "unknown",
    });
  });

  for (const deferred of [false, true]) test(`creates and seeds a new provider session when the recorded one is missing (${deferred ? "first use" : "on open"})`, async () => {
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
    // Leave another checkpoint durably queued across shutdown. On reopen its metering
    // setup races with provider-session recovery unless ownership selection is serialized.
    await firstAgent.checkpointing!.request(conversationId);
    await firstAgent.close();

    const progress: ConversationRecoveryProgress[] = [];
    const reopenedAgent = await Agent.open(config);
    const [opened, concurrentOpen] = await Promise.all([
      reopenedAgent.conversations.open(conversationId, {
        ...(deferred ? { runtime: { providerStart: "on_first_use" as const } } : {}),
        onRecoveryProgress: (event) => progress.push(event),
      }),
      reopenedAgent.conversations.open(conversationId),
    ]);

    expect(opened.providerSession).toBe(deferred ? "deferred" : "recovered");
    expect(concurrentOpen.conversation).toBe(opened.conversation);
    expect(concurrentOpen.providerSession).toBe(opened.providerSession);
    if (deferred) {
      expect(progress).toEqual([]);
      expect(opened.conversation.internalSessionId).toBe(oldSessionId);
      expect(opened.conversation.connection.isConnected).toBe(false);
      expect((await opened.conversation.prompt("first use after reopen")).status).toBe("completed");
    } else {
      expect(opened.recovery?.checkpointId).toBe(checkpoint?.checkpointId);
      expect(opened.recovery?.previousInternalSessionId).toBe(oldSessionId);
      expect(opened.recovery?.recoveredThroughSequence).toBe(latestSequence);
      expect(opened.recovery!.recoveredThroughSequence).toBeGreaterThan(checkpoint!.coveredSequence);
    }
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
    await waitFor(async () =>
      ((await reopenedAgent.checkpointing!.latest(conversationId))?.coveredSequence ?? 0)
        >= latestSequence);
    const metering = await reopenedAgent.persistence.metering.list(conversationId);
    expect(metering.records.map((record) => record.nextState.operationCount))
      .toEqual(metering.records.map((_, index) => index + 1));
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
