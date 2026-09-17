import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "../../src/agent.ts";
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
  test("executes in the background and reopens a durable completed run", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-inference-manager-"));
    roots.push(root);
    const path = join(root, "agent.sqlite");
    const runtime: InternalInferenceRuntime = {
      async run(request) {
        return result(request.internalInferenceId, request.adapterId, "summary");
      },
    };
    const strategy = testStrategy();
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path },
      adapters: { test: { command: ["unused"] } },
      internalInference: { runtime, strategies: [strategy] },
    });
    const run = await agent.internalInferences!.enqueue({
      purpose: "conversation_checkpoint",
      adapterId: "test",
      input: { version: 1, strategyId: "test", payload: { prompt: "summarize" } },
    });
    const completion = await run.result;
    expect(completion.artifactId).toBe("summary");
    const rootId = run.rootId;
    const agentId = agent.id;
    await agent.close();

    const reopened = await Agent.open({
      id: agentId,
      persistence: { kind: "sqlite", path },
      adapters: { test: { command: ["unused"] } },
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
