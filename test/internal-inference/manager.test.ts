import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "../../src/agent.ts";
import { createAgentConversationId } from "../../src/agent-ids.ts";
import { SqliteAgentPersistence } from "../../src/persistence/sqlite-backend.ts";
import type {
  InternalInferenceResult,
  InternalInferenceRuntime,
  InternalInferenceStrategy,
} from "../../src/internal-inference/contracts.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("internal inference manager", () => {
  test("constructs the default harness runtime from agent configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-inference-default-runtime-"));
    roots.push(root);
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(root, "agent.sqlite") },
      adapters: { test: { command: ["unused"] } },
      defaultAdapterId: "test",
      internalInference: { strategies: [testStrategy()] },
    });
    expect(agent.internalInferences).toBeDefined();
    await agent.close();
  });

  test("executes in the background and reopens a durable completed run", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-inference-manager-"));
    roots.push(root);
    const path = join(root, "agent.sqlite");
    const runtime: InternalInferenceRuntime = {
      async run(request, _signal, lifecycle) {
        lifecycle?.stageChanged?.("creating_session");
        await lifecycle?.sessionStarted({ internalSessionId: "provider-test", model: "test" });
        lifecycle?.stageChanged?.("prompting");
        return result(request.internalInferenceId, request.adapterId, "summary");
      },
    };
    const strategy = testStrategy();
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path },
      adapters: { test: { command: ["unused"] } },
      defaultAdapterId: "test",
      internalInference: { runtime, strategies: [strategy] },
    });
    const progress: Array<{ sequence: number; stage: string }> = [];
    agent.internalInferences!.subscribe((event) => {
      progress.push({ sequence: event.sequence, stage: event.snapshot.stage });
    });
    const run = await agent.internalInferences!.enqueue({
      purpose: "conversation_checkpoint",
      input: { version: 1, strategyId: "test", payload: { prompt: "summarize" } },
    });
    const completion = await run.result;
    expect(completion.artifactId).toBe("summary");
    expect(progress.map((entry) => entry.stage)).toEqual(expect.arrayContaining([
      "preparing_input",
      "starting_harness",
      "creating_session",
      "prompting",
      "persisting_result",
      "completed",
    ]));
    expect(progress.map((entry) => entry.sequence)).toEqual(
      [...progress.map((entry) => entry.sequence)].sort((a, b) => a - b),
    );
    expect((await agent.internalInferences!.list({ rootId: run.rootId })).attempts).toHaveLength(1);
    const rootId = run.rootId;
    const agentId = agent.id;
    await agent.close();

    const reopened = await Agent.open({
      id: agentId,
      persistence: { kind: "sqlite", path },
      adapters: { test: { command: ["unused"] } },
      defaultAdapterId: "test",
      internalInference: { runtime, strategies: [strategy] },
    });
    const restored = await reopened.internalInferences!.getRun(rootId);
    expect((await restored!.result).artifactId).toBe("summary");
    await reopened.close();
  });

  test("follows a linked retry from the run handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-inference-retry-"));
    roots.push(root);
    let calls = 0;
    const runtime: InternalInferenceRuntime = {
      async run(request) {
        calls += 1;
        if (calls === 1) throw new Error("temporary");
        return result(request.internalInferenceId, request.adapterId, "retried");
      },
    };
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(root, "agent.sqlite") },
      adapters: { test: { command: ["unused"] } },
      internalInference: {
        runtime,
        strategies: [testStrategy(true)],
        retry: { maxAttempts: 2, backoffMs: [0] },
      },
    });
    const run = await agent.internalInferences!.enqueue({
      purpose: "conversation_checkpoint",
      adapterId: "test",
      input: { version: 1, strategyId: "test", payload: { prompt: "summarize" } },
    });
    expect((await run.result).artifactId).toBe("retried");
    expect(run.activeAttempt.snapshot.attemptNumber).toBe(2);
    expect(calls).toBe(2);
    expect((await agent.persistence.metering.agentState(agent.id))?.state.operationCount).toBe(1);
    await agent.close();
  });

  test("fences an abort-ignoring runtime and durably schedules shutdown recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-inference-shutdown-"));
    roots.push(root);
    const path = join(root, "agent.sqlite");
    const runtime: InternalInferenceRuntime = {
      async run() {
        return await new Promise<InternalInferenceResult>(() => {});
      },
    };
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path },
      adapters: { test: { command: ["unused"] } },
      defaultAdapterId: "test",
      internalInference: {
        runtime,
        strategies: [testStrategy(true)],
        shutdownGraceMs: 0,
        retry: { maxAttempts: 2, backoffMs: [0] },
      },
    });
    const run = await agent.internalInferences!.enqueue({
      purpose: "conversation_checkpoint",
      input: { version: 1, strategyId: "test", payload: { prompt: "never finishes" } },
    });
    await waitFor(() => run.activeAttempt.snapshot.status === "running");
    const agentId = agent.id;
    await agent.close();

    const persistence = await SqliteAgentPersistence.open({ path, agentSessionId: agentId });
    const chain = await persistence.internalInferences.getChain(run.rootId);
    expect(chain?.status).toBe("active");
    expect(chain?.activeInternalInferenceId).not.toBe(run.rootId);
    expect((await persistence.internalInferences.getAttempt(run.rootId))?.failureCode)
      .toBe("shutdown_interrupted");
    await persistence.close();
  });

  test("meters restored background work before its conversation is opened", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-inference-metering-"));
    roots.push(root);
    const runtime: InternalInferenceRuntime = {
      async run(request, _signal, lifecycle) {
        await lifecycle?.sessionStarted({ internalSessionId: "detached-provider", model: null });
        return {
          ...result(request.internalInferenceId, request.adapterId, "metered"),
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        };
      },
    };
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(root, "agent.sqlite") },
      adapters: { test: { command: ["unused"] } },
      defaultAdapterId: "test",
      conversationDefaults: { metering: { pricing: false } },
      internalInference: { runtime, strategies: [testStrategy()] },
    });
    const conversationId = createAgentConversationId();
    await agent.persistence.conversations.create({
      agentSessionId: agent.id,
      agentConversationId: conversationId,
    });
    const run = await agent.internalInferences!.enqueue({
      purpose: "conversation_checkpoint",
      agentConversationId: conversationId,
      input: { version: 1, strategyId: "test", payload: { prompt: "meter" } },
    });
    await run.result;
    expect((await agent.persistence.metering.state(conversationId))?.state.operationCount).toBe(1);
    expect((await agent.persistence.metering.list(conversationId)).records[0]?.operationKind)
      .toBe("conversation_checkpoint");
    await agent.close();
  });

  test("meters agent-level internal work without assigning it to a conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-inference-agent-metering-"));
    roots.push(root);
    const runtime: InternalInferenceRuntime = {
      async run(request, _signal, lifecycle) {
        await lifecycle?.sessionStarted({ internalSessionId: "agent-provider", model: null });
        return {
          ...result(request.internalInferenceId, request.adapterId, "identity"),
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        };
      },
    };
    const identity = { ...testStrategy(), purpose: "identity_update" as const };
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(root, "agent.sqlite") },
      adapters: { test: { command: ["unused"] } },
      defaultAdapterId: "test",
      conversationDefaults: { metering: { pricing: false } },
      internalInference: { runtime, strategies: [identity] },
    });
    const run = await agent.internalInferences!.enqueue({
      purpose: "identity_update",
      input: { version: 1, strategyId: "test", payload: { prompt: "identity" } },
    });

    await run.result;
    expect((await agent.persistence.metering.agentState(agent.id))?.state.operationCount).toBe(1);
    const records = await agent.persistence.metering.listAgent(agent.id);
    expect(records.records).toHaveLength(1);
    expect(records.records[0]?.operationKind).toBe("identity_update");
    await agent.close();
  });

  test("serializes detached metering for concurrent work on one closed conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-inference-metering-concurrency-"));
    roots.push(root);
    let sessionNumber = 0;
    const runtime: InternalInferenceRuntime = {
      async run(request, _signal, lifecycle) {
        sessionNumber += 1;
        await lifecycle?.sessionStarted({
          internalSessionId: `detached-provider-${sessionNumber}`,
          model: null,
        });
        return {
          ...result(request.internalInferenceId, request.adapterId, request.purpose),
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        };
      },
    };
    const checkpoint = testStrategy();
    const identity = { ...testStrategy(), purpose: "identity_update" as const };
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(root, "agent.sqlite") },
      adapters: { test: { command: ["unused"] } },
      defaultAdapterId: "test",
      conversationDefaults: { metering: { pricing: false } },
      internalInference: {
        runtime,
        strategies: [checkpoint, identity],
        maxConcurrency: 2,
      },
    });
    const conversationId = createAgentConversationId();
    await agent.persistence.conversations.create({
      agentSessionId: agent.id,
      agentConversationId: conversationId,
    });
    const first = await agent.internalInferences!.enqueue({
      purpose: "conversation_checkpoint",
      agentConversationId: conversationId,
      input: { version: 1, strategyId: "test", payload: { prompt: "first" } },
    });
    const second = await agent.internalInferences!.enqueue({
      purpose: "identity_update",
      agentConversationId: conversationId,
      input: { version: 1, strategyId: "test", payload: { prompt: "second" } },
    });

    await Promise.all([first.result, second.result]);
    const state = await agent.persistence.metering.state(conversationId);
    expect(state?.state.operationCount).toBe(2);
    expect((await agent.persistence.metering.list(conversationId)).records).toHaveLength(2);
    await agent.close();
  });
});

function testStrategy(retry = false): InternalInferenceStrategy<{ prompt: string }> {
  return {
    strategyId: "test",
    purpose: "conversation_checkpoint",
    version: 1,
    validatePayload(payload) {
      const value = payload as { prompt?: unknown };
      if (typeof value?.prompt !== "string") throw new Error("prompt required");
      return { prompt: value.prompt };
    },
    async prepare(_context, payload) {
      return { prompt: payload.prompt };
    },
    async complete(context, inference) {
      return {
        internalInferenceId: inference.internalInferenceId,
        rootInternalInferenceId: context.attempt.rootId,
        internalSessionId: inference.internalSessionId,
        purpose: context.attempt.purpose,
        artifactId: inference.messages[0]?.text,
        completedAt: new Date().toISOString(),
      };
    },
    classifyError() {
      return retry
        ? { kind: "retryable", code: "temporary" }
        : { kind: "terminal", code: "failed" };
    },
  };
}

function result(id: `aii-${string}`, adapterId: string, text: string): InternalInferenceResult {
  return {
    internalInferenceId: id,
    internalSessionId: `session-${id}`,
    adapterId,
    model: "test",
    messages: [{ text }],
    usage: null,
    stopReason: "end_turn",
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for internal inference state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
