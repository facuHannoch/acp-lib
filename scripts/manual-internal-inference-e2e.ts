import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADAPTERS,
  Agent,
  type InternalInferenceStrategy,
} from "../src/index.ts";

const expected = "INTERNAL_INFERENCE_OK";
const directory = await mkdtemp(join(tmpdir(), "acp-internal-inference-e2e-"));
const databasePath = join(directory, "agent.sqlite");

const strategy: InternalInferenceStrategy<{ prompt: string }> = {
  strategyId: "manual-e2e-v1",
  purpose: "identity_update",
  version: 1,
  validatePayload(value) {
    const prompt = (value as { prompt?: unknown }).prompt;
    if (typeof prompt !== "string") throw new Error("prompt is required");
    return { prompt };
  },
  async prepare(_context, input) {
    return { prompt: input.prompt };
  },
  async complete(context, result) {
    const text = result.messages.map((message) => message.text).join("").trim();
    if (text !== expected) throw new Error(`unexpected provider response: ${JSON.stringify(text)}`);
    return {
      internalInferenceId: result.internalInferenceId,
      rootInternalInferenceId: context.attempt.rootId,
      internalSessionId: result.internalSessionId,
      purpose: context.attempt.purpose,
      artifactId: "manual-e2e-ok",
      completedAt: new Date().toISOString(),
    };
  },
  classifyError(error) {
    return { kind: "terminal", code: error instanceof Error ? error.name : "unknown" };
  },
};

const agent = await Agent.open({
  persistence: { kind: "sqlite", path: databasePath },
  adapters: { codex: ADAPTERS.codex },
  defaultAdapterId: "codex",
  conversationDefaults: { cwd: process.cwd(), metering: { pricing: false } },
  internalInference: {
    strategies: [strategy],
    retry: { maxAttempts: 1, backoffMs: [] },
  },
});

try {
  const stages: string[] = [];
  const run = await agent.internalInferences!.enqueue({
    purpose: "identity_update",
    input: {
      strategyId: strategy.strategyId,
      version: strategy.version,
      payload: { prompt: `Respond with exactly ${expected} and nothing else. Do not use tools.` },
    },
  });
  const unsubscribe = run.subscribe(({ snapshot }) => stages.push(snapshot.stage));
  const completion = await run.result;
  unsubscribe();

  if (completion.artifactId !== "manual-e2e-ok") throw new Error("completion artifact was not published");
  const attempts = await agent.internalInferences!.list({ rootId: run.rootId });
  if (attempts.attempts.length !== 1 || attempts.attempts[0]?.status !== "completed") {
    throw new Error("completed inference was not durably queryable");
  }
  const metering = await agent.persistence.metering.agentState(agent.id);
  if (metering?.state.operationCount !== 1) throw new Error("agent-scoped metering was not persisted");

  console.log(JSON.stringify({
    ok: true,
    databasePath,
    agentSessionId: agent.id,
    internalInferenceId: attempts.attempts[0].id,
    stages,
    meteringOperationCount: metering.state.operationCount,
  }, null, 2));
} finally {
  await agent.close();
}
