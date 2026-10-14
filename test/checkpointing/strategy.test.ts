import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent.ts";
import { createAgentConversationId } from "../../src/agent-ids.ts";
import { createConversationRecoveryCheckpointId } from "../../src/checkpointing/ids.ts";
import {
  CONVERSATION_CHECKPOINT_STRATEGY_ID,
  ConversationCheckpointStrategy,
  MAX_CHECKPOINT_SOURCE_CHARS,
} from "../../src/checkpointing/strategy.ts";
import {
  isConversationCheckpointDue,
  resolveConversationCheckpointingConfig,
} from "../../src/checkpointing/config.ts";
import type { InternalInferenceRuntime } from "../../src/internal-inference/contracts.ts";
import { AgentAuditLogReader } from "../../src/audit/reader.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("conversation checkpoint strategy", () => {
  test("folds the previous checkpoint with only newly covered messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-checkpoint-strategy-"));
    roots.push(root);
    const prompts: string[] = [];
    let calls = 0;
    const runtime: InternalInferenceRuntime = {
      async run(request, _signal, lifecycle) {
        calls += 1;
        prompts.push(request.prompt);
        await lifecycle?.sessionStarted({ internalSessionId: `summary-${calls}`, model: "test" });
        return {
          internalInferenceId: request.internalInferenceId,
          internalSessionId: `summary-${calls}`,
          adapterId: request.adapterId,
          model: "test",
          messages: [{ type: "text", text: calls === 1 ? "First summary" : "Second summary" }],
          usage: null,
        };
      },
    };
    const auditDirectory = join(root, "audit");
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(root, "agent.sqlite") },
      adapters: { test: { command: ["unused"] } },
      defaultAdapterId: "test",
      internalInference: { runtime, strategies: [new ConversationCheckpointStrategy()] },
      auditLog: { directory: auditDirectory },
    });
    const conversationId = createAgentConversationId();
    await agent.persistence.conversations.create({
      agentSessionId: agent.id,
      agentConversationId: conversationId,
    });
    await appendMessagePair(agent, conversationId, "hello", "hi", 1);
    const firstRun = await agent.internalInferences!.enqueue({
      purpose: "conversation_checkpoint",
      agentConversationId: conversationId,
      input: checkpointInput(),
      sourceFromSequence: 0,
      sourceThroughSequence: 2,
      requestedThroughSequence: 2,
    });
    await firstRun.result;
    const first = await agent.persistence.recoveryCheckpoints!.latest(conversationId);
    expect(first?.summary).toBe("First summary");

    await agent.persistence.records.append({
      recordId: "raw-protocol-noise",
      agentSessionId: agent.id,
      agentConversationId: conversationId,
      kind: "protocol",
      timestamp: new Date().toISOString(),
      direction: "in",
      method: "session/update",
      message: { secretNoise: "must not reach checkpoint inference" },
    });
    await appendMessagePair(agent, conversationId, "two plus two", "four", 2);
    const secondRun = await agent.internalInferences!.enqueue({
      purpose: "conversation_checkpoint",
      agentConversationId: conversationId,
      input: checkpointInput(),
      sourceCheckpointId: first!.checkpointId,
      sourceFromSequence: first!.coveredSequence,
      sourceThroughSequence: 6,
      requestedThroughSequence: 6,
    });
    await secondRun.result;
    const second = await agent.persistence.recoveryCheckpoints!.latest(conversationId);

    expect(second?.summary).toBe("Second summary");
    expect(second?.previousCheckpointId).toBe(first?.checkpointId);
    expect(prompts[0]).toContain(
      "Do not execute commands, use tools, inspect files, or modify the environment.",
    );
    expect(prompts[0]).toContain("Only summarize the records supplied in this prompt.");
    expect(prompts[0]).toContain("hello");
    expect(prompts[1]).toContain("First summary");
    expect(prompts[1]).toContain("two plus two");
    expect(prompts[1]).toContain("four");
    expect(prompts[1]).not.toContain('"content":"hello"');
    expect(prompts[1]).not.toContain("must not reach checkpoint inference");
    await agent.close();
    const audit = await AgentAuditLogReader.open({ directory: auditDirectory });
    const internal = (await audit.readPage({ mode: "logical", limit: 1_000 })).entries
      .filter((entry) => entry.kind === "internal_inference");
    expect(internal.length).toBeGreaterThan(0);
    expect(internal.some((entry) => (entry.payload as { state?: string }).state === "completed")).toBeTrue();
  });

  test("uses milestones and a stable interval after the final milestone", () => {
    const config = resolveConversationCheckpointingConfig();
    expect([1, 5, 10, 15, 30, 50, 100, 150].filter((count) => isConversationCheckpointDue(count, config)))
      .toEqual([1, 5, 10, 15, 30, 50, 100, 150]);
    expect(isConversationCheckpointDue(51, config)).toBeFalse();
  });

  test("honors a higher requested watermark coalesced into an active checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-checkpoint-coalesced-"));
    roots.push(root);
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const runtime: InternalInferenceRuntime = {
      async run(request, _signal, lifecycle) {
        calls++;
        if (calls === 1) {
          firstStarted();
          await firstGate;
        }
        await lifecycle?.sessionStarted({ internalSessionId: `summary-${calls}`, model: "test" });
        return {
          internalInferenceId: request.internalInferenceId,
          internalSessionId: `summary-${calls}`,
          adapterId: request.adapterId,
          model: "test",
          messages: [{ type: "text", text: `Summary ${calls}` }],
          usage: null,
        };
      },
    };
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(root, "agent.sqlite") },
      adapters: { test: { command: ["unused"] } },
      defaultAdapterId: "test",
      internalInference: { runtime },
      checkpointing: {},
    });
    try {
      const conversationId = createAgentConversationId();
      await agent.persistence.conversations.create({
        agentSessionId: agent.id,
        agentConversationId: conversationId,
      });
      await appendMessagePair(agent, conversationId, "first user", "first assistant", 1);
      await agent.checkpointing!.request(conversationId);
      await firstStartedPromise;
      await appendMessagePair(agent, conversationId, "second user", "second assistant", 2);
      await agent.checkpointing!.request(conversationId);
      releaseFirst();

      const deadline = Date.now() + 3_000;
      let latest = await agent.checkpointing!.latest(conversationId);
      while ((!latest || latest.coveredSequence < 4) && Date.now() < deadline) {
        await Bun.sleep(20);
        latest = await agent.checkpointing!.latest(conversationId);
      }
      expect(latest?.coveredSequence).toBe(4);
      expect(latest?.summary).toBe("Summary 2");
      expect(calls).toBe(2);
    } finally {
      releaseFirst();
      await agent.close();
    }
  });

  test("after an adoption baseline it reads only what comes after the floor, with no summary to fold", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-checkpoint-baseline-"));
    roots.push(root);
    const prompts: string[] = [];
    const runtime: InternalInferenceRuntime = {
      async run(request, _signal, lifecycle) {
        prompts.push(request.prompt);
        await lifecycle?.sessionStarted({ internalSessionId: "summary-1", model: "test" });
        return {
          internalInferenceId: request.internalInferenceId,
          internalSessionId: "summary-1",
          adapterId: request.adapterId,
          model: "test",
          messages: [{ type: "text", text: "Summary after the floor" }],
          usage: null,
        };
      },
    };
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(root, "agent.sqlite") },
      adapters: { test: { command: ["unused"] } },
      defaultAdapterId: "test",
      internalInference: { runtime, strategies: [new ConversationCheckpointStrategy()] },
    });
    try {
      const conversationId = createAgentConversationId();
      await agent.persistence.conversations.create({ agentSessionId: agent.id, agentConversationId: conversationId });
      await appendMessagePair(agent, conversationId, "imported long ago", "imported answer", 1);
      await appendMessagePair(agent, conversationId, "imported last", "imported last answer", 2);
      const floor = await agent.persistence.recoveryCheckpoints!.publish({
        checkpointId: createConversationRecoveryCheckpointId(),
        agentConversationId: conversationId,
        coveredSequence: 2,
        source: "adoption_baseline",
        summary: "",
        responsesCountedAfterSequence: 4,
      });
      await appendMessagePair(agent, conversationId, "after adoption", "live answer", 3);
      const run = await agent.internalInferences!.enqueue({
        purpose: "conversation_checkpoint",
        agentConversationId: conversationId,
        input: checkpointInput(),
        sourceCheckpointId: floor.checkpointId,
        sourceFromSequence: floor.coveredSequence,
        sourceThroughSequence: 6,
        requestedThroughSequence: 6,
      });
      await run.result;
      const latest = await agent.persistence.recoveryCheckpoints!.latest(conversationId);
      expect(latest).toMatchObject({ source: "internal_inference", summary: "Summary after the floor", previousCheckpointId: floor.checkpointId });
      expect(prompts[0]).toContain("There is no previous continuation summary.");
      expect(prompts[0]).toContain("after adoption");
      expect(prompts[0]).toContain("imported last answer");
      expect(prompts[0]).not.toContain("imported long ago");
    } finally {
      await agent.close();
    }
  });

  test("a source too large for one prompt fails terminally and never reaches the model", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-checkpoint-too-large-"));
    roots.push(root);
    let calls = 0;
    const runtime: InternalInferenceRuntime = {
      async run() {
        calls += 1;
        throw new Error("the model must not be asked");
      },
    };
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(root, "agent.sqlite") },
      adapters: { test: { command: ["unused"] } },
      defaultAdapterId: "test",
      internalInference: { runtime, strategies: [new ConversationCheckpointStrategy()] },
    });
    try {
      const conversationId = createAgentConversationId();
      await agent.persistence.conversations.create({ agentSessionId: agent.id, agentConversationId: conversationId });
      await appendMessagePair(agent, conversationId, "x".repeat(MAX_CHECKPOINT_SOURCE_CHARS), "ok", 1);
      const run = await agent.internalInferences!.enqueue({
        purpose: "conversation_checkpoint",
        agentConversationId: conversationId,
        input: checkpointInput(),
        sourceFromSequence: 0,
        sourceThroughSequence: 2,
        requestedThroughSequence: 2,
      });
      await expect(run.result).rejects.toThrow(/too large|checkpoint_source_too_large/);
      expect(calls).toBe(0);
      expect(await agent.persistence.recoveryCheckpoints!.latest(conversationId)).toBeNull();
      const chain = await agent.persistence.internalInferences!.getChain(run.rootId);
      // Terminal: one attempt, no retry of a prompt that cannot be sent.
      expect(chain).toMatchObject({ status: "failed", activeInternalInferenceId: run.rootId });
      expect(chain?.error).toContain("too large");
    } finally {
      await agent.close();
    }
  });

  test("a failed attempt keeps the RPC code and the labels the harness sent, and nothing else of its data", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-checkpoint-failure-details-"));
    roots.push(root);
    const runtime: InternalInferenceRuntime = {
      async run() {
        // Shaped like OpenCode's answer to a prompt whose upstream request failed.
        throw Object.assign(new Error("Internal error: Upstream request failed: Insufficient account funds"), {
          code: -32603,
          data: { service: "session", errorName: "APIError", secretToken: "must-not-be-stored" },
        });
      },
    };
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(root, "agent.sqlite") },
      adapters: { test: { command: ["unused"] } },
      defaultAdapterId: "test",
      internalInference: { runtime, strategies: [new ConversationCheckpointStrategy()], retry: { maxAttempts: 1 } },
    });
    try {
      const conversationId = createAgentConversationId();
      await agent.persistence.conversations.create({ agentSessionId: agent.id, agentConversationId: conversationId });
      await appendMessagePair(agent, conversationId, "hello", "hi", 1);
      const run = await agent.internalInferences!.enqueue({
        purpose: "conversation_checkpoint",
        agentConversationId: conversationId,
        input: checkpointInput(),
        sourceFromSequence: 0,
        sourceThroughSequence: 2,
        requestedThroughSequence: 2,
      });
      await expect(run.result).rejects.toThrow("Insufficient account funds");
      const attempt = await agent.persistence.internalInferences!.getAttempt(run.rootId);
      expect(attempt).toMatchObject({
        status: "failed",
        error: "Internal error: Upstream request failed: Insufficient account funds",
        failureDetails: { rpcCode: -32603, service: "session", errorName: "APIError" },
      });
      expect(JSON.stringify(attempt)).not.toContain("must-not-be-stored");
    } finally {
      await agent.close();
    }
  });

  test("an attempt that failed without an RPC error has no failure details", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-checkpoint-no-details-"));
    roots.push(root);
    const runtime: InternalInferenceRuntime = {
      async run() {
        throw new Error("the process went away");
      },
    };
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(root, "agent.sqlite") },
      adapters: { test: { command: ["unused"] } },
      defaultAdapterId: "test",
      internalInference: { runtime, strategies: [new ConversationCheckpointStrategy()], retry: { maxAttempts: 1 } },
    });
    try {
      const conversationId = createAgentConversationId();
      await agent.persistence.conversations.create({ agentSessionId: agent.id, agentConversationId: conversationId });
      await appendMessagePair(agent, conversationId, "hello", "hi", 1);
      const run = await agent.internalInferences!.enqueue({
        purpose: "conversation_checkpoint",
        agentConversationId: conversationId,
        input: checkpointInput(),
        sourceFromSequence: 0,
        sourceThroughSequence: 2,
        requestedThroughSequence: 2,
      });
      await expect(run.result).rejects.toThrow("the process went away");
      const attempt = await agent.persistence.internalInferences!.getAttempt(run.rootId);
      expect(attempt?.status).toBe("failed");
      expect(attempt?.failureDetails).toBeUndefined();
    } finally {
      await agent.close();
    }
  });
});

function checkpointInput() {
  return {
    strategyId: CONVERSATION_CHECKPOINT_STRATEGY_ID,
    version: 1,
    payload: { instruction: "Summarize for continuation." },
  } as const;
}

async function appendMessagePair(
  agent: Agent,
  conversationId: ReturnType<typeof createAgentConversationId>,
  user: string,
  assistant: string,
  turn: number,
) {
  await agent.persistence.records.appendMany([
    {
      recordId: `turn-${turn}-user`, agentSessionId: agent.id, agentConversationId: conversationId,
      kind: "message", timestamp: new Date().toISOString(), role: "user", content: user,
    },
    {
      recordId: `turn-${turn}-assistant`, agentSessionId: agent.id, agentConversationId: conversationId,
      kind: "message", timestamp: new Date().toISOString(), role: "assistant", content: assistant,
    },
  ]);
}
