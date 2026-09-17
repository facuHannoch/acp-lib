#!/usr/bin/env bun

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import {
  ADAPTERS,
  Agent,
  type Adapter,
  type InternalInferenceStrategy,
} from "@qlairoslabs/acp-client";
import { findStoredInference, listStoredMessages } from "./queries.ts";

const here = dirname(fileURLToPath(import.meta.url));
const configuredDirectory = process.env.ACP_TEST8_INTERNAL_INFERENCE_DATA_DIR?.trim();
const ownsTemporaryDirectory = !configuredDirectory;
const directory = configuredDirectory
  ? resolve(configuredDirectory)
  : await mkdtemp(join(tmpdir(), "acp-internal-inference-smoke-"));
if (configuredDirectory) await mkdir(directory, { recursive: true });
const databasePath = join(directory, "agent.sqlite");

const adapters: Record<string, Adapter> = {
  codex: ADAPTERS.codex,
  opencode: ADAPTERS.opencode,
};
const adapterId = process.env.ACP_TEST8_INTERNAL_INFERENCE_ADAPTER?.trim() || "codex";
assert.ok(adapters[adapterId], `unknown adapter: ${adapterId}`);

const conversationPrompts = ["Hello", "What is 2+2?", "+"] as const;
const reviewStrategy: InternalInferenceStrategy<{ instruction: string }> = {
  strategyId: "smoke-conversation-review-v1",
  purpose: "conversation_review",
  version: 1,
  validatePayload(value) {
    const instruction = (value as { instruction?: unknown }).instruction;
    if (typeof instruction !== "string" || !instruction.trim()) {
      throw new Error("conversation review instruction is required");
    }
    return { instruction };
  },
  async prepare(context, input) {
    const conversationId = context.attempt.agentConversationId;
    if (!conversationId) throw new Error("conversation review requires a conversation");
    const history = await context.persistence.messages.list(conversationId);
    return {
      prompt: [
        input.instruction,
        "The canonical conversation messages follow as JSON. Do not use tools.",
        JSON.stringify(history.messages.map(({ role, content }) => ({ role, content }))),
      ].join("\n\n"),
    };
  },
  async complete(context, result) {
    const summary = result.messages.map((message) => message.text).join("").trim();
    if (!summary) throw new Error("conversation review returned an empty summary");
    return {
      internalInferenceId: result.internalInferenceId,
      rootInternalInferenceId: context.attempt.rootId,
      internalSessionId: result.internalSessionId,
      purpose: context.attempt.purpose,
      completedAt: new Date().toISOString(),
      metadata: JSON.stringify({ summary }),
    };
  },
  classifyError(error) {
    return { kind: "terminal", code: error instanceof Error ? error.name : "unknown" };
  },
};

let agent: Agent | undefined;
try {
  agent = await Agent.open({
    persistence: { kind: "sqlite", path: databasePath },
    adapters,
    defaultAdapterId: adapterId,
    conversationDefaults: { cwd: process.cwd(), metering: { pricing: false } },
    internalInference: {
      strategies: [reviewStrategy],
      retry: { maxAttempts: 1, backoffMs: [] },
    },
  });

  const conversation = await agent.conversations.create();
  for (const prompt of conversationPrompts) {
    const response = await conversation.prompt(prompt);
    assert.equal(response.status, "completed", `conversation prompt failed: ${prompt}`);
  }

  const sourceHistory = await agent.persistence.messages.list(conversation.agentConversationId);
  assert.deepEqual(
    sourceHistory.messages.filter(({ role }) => role === "user").map(({ content }) => content),
    conversationPrompts,
    "canonical conversation does not contain the three user prompts",
  );
  console.log(
    `PASS conversation agent=${agent.id} conversation=${conversation.agentConversationId} prompts=${conversationPrompts.length}`,
  );

  const stages: string[] = [];
  const unsubscribe = agent.internalInferences!.subscribe(({ snapshot }) => {
    if (snapshot.purpose === "conversation_review") stages.push(snapshot.stage);
  });
  const run = await agent.internalInferences!.enqueue({
    purpose: "conversation_review",
    agentConversationId: conversation.agentConversationId,
    input: {
      strategyId: reviewStrategy.strategyId,
      version: reviewStrategy.version,
      payload: { instruction: "Tell me briefly how this conversation went." },
    },
  });
  const completion = await run.result;
  unsubscribe();

  const summary = JSON.parse(completion.metadata ?? "null")?.summary;
  assert.equal(typeof summary, "string", "inference completion did not publish its summary");
  assert.ok(summary.trim(), "inference summary is empty");
  assert.match(summary, /4/, "inference summary did not recognize the arithmetic exchange");
  assert.equal(run.snapshot.status, "completed");
  assert.notEqual(
    completion.internalSessionId,
    conversation.internalSessionId,
    "internal inference reused the visible conversation provider session",
  );
  for (const stage of ["preparing_input", "starting_harness", "creating_session", "prompting", "completed"]) {
    assert.ok(stages.includes(stage), `missing internal inference stage: ${stage}`);
  }
  console.log(
    `PASS inference id=${run.activeAttempt.id} providerSession=${completion.internalSessionId}`,
  );

  const database = new Database(databasePath, { readonly: true });
  try {
    const storedMessages = listStoredMessages(database, conversation.agentConversationId);
    assert.deepEqual(
      storedMessages.filter(({ role }) => role === "user").map(({ content }) => content),
      conversationPrompts,
      "SQLite conversation history differs from the prompts",
    );
    const storedInference = findStoredInference(database, run.activeAttempt.id);
    assert.ok(storedInference, "SQLite does not contain the internal inference");
    assert.equal(storedInference.status, "completed");
    assert.equal(storedInference.purpose, "conversation_review");
    assert.equal(storedInference.agentConversationId, conversation.agentConversationId);
    assert.equal(storedInference.internalSessionId, completion.internalSessionId);
    assert.ok(storedInference.meteringOperationId, "internal inference metering was not persisted");
    assert.equal(JSON.parse(storedInference.resultJson ?? "null")?.metadata, completion.metadata);
    console.log(
      `PASS sqlite status=${storedInference.status} purpose=${storedInference.purpose} metered=true`,
    );
  } finally {
    database.close();
  }

  console.log("PASS internal-inference smoke test");
  console.log(JSON.stringify({
    ok: true,
    databasePath,
    agentSessionId: agent.id,
    agentConversationId: conversation.agentConversationId,
    internalInferenceId: run.activeAttempt.id,
    internalSessionId: completion.internalSessionId,
    summary,
    stages,
  }, null, 2));
} finally {
  await agent?.close();
  if (ownsTemporaryDirectory) {
    await rm(directory, { recursive: true, force: true });
  } else {
    console.log(`SQLite retained at ${databasePath}`);
  }
}
