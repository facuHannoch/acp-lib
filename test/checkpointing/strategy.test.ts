import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent.ts";
import { createAgentConversationId } from "../../src/agent-ids.ts";
import {
  CONVERSATION_CHECKPOINT_STRATEGY_ID,
  ConversationCheckpointStrategy,
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
