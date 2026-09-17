#!/usr/bin/env bun

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import {
  ADAPTERS,
  Agent,
  type Adapter,
  type AgentConversationId,
  type OperationMeteringRecord,
} from "@qlairoslabs/acp-client";
import {
  findStoredMeteringRecord,
  findStoredMeteringState,
  findStoredUserMessage,
  listStoredMessages,
} from "./queries.ts";

// Full drive of agent

/**
 * Full lifecycle smoke test for SQLite-backed agents.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "../test5-operations/operations-agent.ts");
const configuredDirectory = process.env.ACP_TEST8_DATA_DIR?.trim();
const ownsTemporaryDirectory = !configuredDirectory;
const directory = configuredDirectory
  ? resolve(configuredDirectory)
  : await mkdtemp(join(tmpdir(), "acp-agent-sqlite-smoke-"));
if (configuredDirectory) await mkdir(directory, { recursive: true });
const databasePath = join(directory, "agent.sqlite");

const adapters: Record<string, Adapter> = {
  codex: ADAPTERS.codex,
  test: {
    command: ["bun", fixture, "test8"],
    displayName: "Deterministic test agent",
  },
};
const adapterId = process.env.ACP_TEST8_ADAPTER?.trim() || "codex";
assert.ok(adapters[adapterId], `unknown ACP_TEST8_ADAPTER: ${adapterId}`);

const prompts = [
  "hi",
  "This is the second message in testing SQLite",
  "The answer to PWEAS is 3",
  "We need to work on adding the internal tools to the agent",
] as const;

type ExpectedMessage = {
  readonly role: "assistant" | "user";
  readonly content: string;
};

let firstAgent: Agent | undefined;
let reopenedAgent: Agent | undefined;
let thirdAgent: Agent | undefined;
let meteringAgent: Agent | undefined;

try {
  firstAgent = await openAgent();
  const conversation = await firstAgent.conversations.create();
  const conversationId = conversation.id;
  const expectedMessages: ExpectedMessage[] = [];

  for (const prompt of prompts) {
    const result = await conversation.prompt(prompt);
    assert.equal(result.status, "completed", `prompt failed: ${prompt}`);
    expectedMessages.push(
      { role: "user", content: prompt },
      ...result.messages.map((message) => ({
        role: "assistant" as const,
        content: message.text,
      })),
    );
  }

  assertSqliteHistory(conversationId, expectedMessages);
  console.log(
    `PASS initial agent=${firstAgent.id} conversation=${conversationId} messages=${expectedMessages.length}`,
  );


  // AGENT CLOSED - OPENED AGAIN

  await firstAgent.close();
  firstAgent = undefined;

  // Simulate a new process opening the same agent database and provider conversation.
  reopenedAgent = await openAgent();
  const reopened = await reopenedAgent.conversations.open(conversationId);
  assert.equal(reopened.providerSession, "loaded");
  assert.equal(reopened.conversation.id, conversationId);
  const conversationAfterReopening = reopened.conversation;

  const persisted = await reopenedAgent.persistence.messages.list(conversationId);
  assert.deepEqual(
    persisted.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    expectedMessages,
    "reopened agent did not expose the original conversation history",
  );

  assertSqliteHistory(conversationId, expectedMessages);

  const recallPrompt = "What is the answer to pweas? respond with just the answer or with 'DN' if you don't know";
  const result = await conversationAfterReopening.prompt(recallPrompt);
  assert.equal(result.status, "completed", "reopened conversation recall prompt failed");
  assert.equal(
    result.messages.map((message) => message.text).join("").trim(),
    "3",
    "reopened provider thread did not remember the PWEAS answer",
  );
  expectedMessages.push(
    { role: "user", content: recallPrompt },
    ...result.messages.map((message) => ({
      role: "assistant" as const,
      content: message.text,
    })),
  );

  const persistedAfterRecall = await reopenedAgent.persistence.messages.list(conversationId);
  assert.deepEqual(
    persistedAfterRecall.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    expectedMessages,
    "recall turn was not appended to the reopened conversation history",
  );
  assertSqliteHistory(conversationId, expectedMessages);
  console.log(
    `PASS reopened agent=${reopenedAgent.id} conversation=${conversationId} answer=3 messages=${persistedAfterRecall.messages.length}`,
  );


  const internalSessionId = conversationAfterReopening.internalSessionId;
  assert.ok(internalSessionId, "reopened conversation has no internal session id");
  console.log(`Adapter: ${adapterId}; internalSessionId: ${internalSessionId}`);
  await reopenedAgent.close();
  reopenedAgent = undefined;

  // 3rd AGENT OPEN - INTERNAL SESSION IS DELETED (GRACEFULL RECOVERY)
  const confirmation = await askToRunRecoveryCheck(internalSessionId);
  if (confirmation === "skip") {
    console.log("SKIP third opening graceful-recovery check");
  } else {
    assert.equal(confirmation, "y", "expected 'y' or 'skip'");

    thirdAgent = await openAgent();
    const thirdOpen = await thirdAgent.conversations.open(conversationId);
    assert.equal(thirdOpen.conversation.id, conversationId);

    const recoveryResult = await thirdOpen.conversation.prompt(recallPrompt);
    assert.equal(recoveryResult.status, "completed", "recovered conversation recall prompt failed");
    assert.equal(
      recoveryResult.messages.map((message) => message.text).join("").trim(),
      "3",
      "recovered provider thread did not reconstruct the PWEAS answer",
    );
    expectedMessages.push(
      { role: "user", content: recallPrompt },
      ...recoveryResult.messages.map((message) => ({
        role: "assistant" as const,
        content: message.text,
      })),
    );

    const persistedAfterRecovery = await thirdAgent.persistence.messages.list(conversationId);
    assert.deepEqual(
      persistedAfterRecovery.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      expectedMessages,
      "recovery turn was not appended to the conversation history",
    );
    assertSqliteHistory(conversationId, expectedMessages);
    console.log(
      `PASS third opening agent=${thirdAgent.id} conversation=${conversationId} answer=3 messages=${persistedAfterRecovery.messages.length}`,
    );
  }

  await thirdAgent?.close();
  thirdAgent = undefined;

  // 4th AGENT OPEN - METERING
  // The deterministic adapter reports usage. Verify both the complete operation record
  // and the bounded state needed to restore counters in a later process.
  meteringAgent = await openAgent("test");
  const meteringConversation = await meteringAgent.conversations.create({ adapterId: "test" });
  const metered = await meteringConversation.prompt("Return deterministic metering usage");
  assert.equal(metered.status, "completed", "metering prompt failed");
  assert.ok(metered.metering, "metering prompt returned no operation record");
  assert.equal(metered.metering.operationId, metered.operationId);
  assert.equal(metered.metering.usage.status, "metered", "test adapter usage was not metered");
  if (metered.metering.usage.status === "metered") {
    assert.equal(metered.metering.usage.reportedCumulative.inputTokens, 3);
    assert.equal(metered.metering.usage.reportedCumulative.outputTokens, 5);
  }

  const meteringPage = await meteringAgent.persistence.metering.list(meteringConversation.id);
  assert.equal(meteringPage.records.length, 1, "expected one persisted metering record");
  assert.deepEqual(
    meteringPage.records[0],
    metered.metering,
    "persisted metering record differs from the prompt result",
  );
  const meteringState = await meteringAgent.persistence.metering.state(meteringConversation.id);
  assert.ok(meteringState, "bounded metering state was not persisted");
  assert.deepEqual(
    meteringState.state,
    metered.metering.nextState,
    "persisted metering state cannot restore the completed operation",
  );
  assert.equal(meteringState.state.operationCount, 1);
  assert.equal(
    meteringState.state.activeBaseline?.internalSessionId,
    meteringConversation.internalSessionId,
    "metering state did not retain the active provider baseline",
  );
  assertSqliteMetering(meteringConversation.id, metered.metering);
  console.log(
    `PASS metering agent=${meteringAgent.id} conversation=${meteringConversation.id} operation=${metered.operationId}`,
  );

  // 5th AGENT OPEN - conversation driving (ACP) - Needs human
  // Do multiple operations:
  /**
   * 1. Review the
   * 2. Set config <-- assert it is recorded as ??
   * 3. close session, reopen session, assert session has config set
   */

} finally {
  await Promise.allSettled([
    firstAgent?.close(),
    reopenedAgent?.close(),
    thirdAgent?.close(),
    meteringAgent?.close(),
  ]);
  if (ownsTemporaryDirectory) {
    await rm(directory, { recursive: true, force: true });
  } else {
    console.log(`SQLite retained at ${databasePath}`);
  }
}

async function askToRunRecoveryCheck(internalSessionId: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await readline.question(
      `Delete internal provider session ${internalSessionId}, then enter 'y' to continue or 'skip' to stop: `,
    );
    return answer.trim().toLowerCase();
  } finally {
    readline.close();
  }
}

async function openAgent(defaultAdapterId = adapterId): Promise<Agent> {
  return await Agent.open({
    persistence: {
      kind: "sqlite",
      path: databasePath,
    },
    adapters,
    defaultAdapterId,
  });
}

function assertSqliteMetering(
  conversationId: AgentConversationId,
  expected: OperationMeteringRecord,
): void {
  const database = new Database(databasePath, { readonly: true });
  try {
    const storedRecord = findStoredMeteringRecord(database, conversationId, expected.operationId);
    assert.ok(storedRecord, "SQLite does not contain the metering operation marker");
    assert.ok(storedRecord.recordJson, "SQLite omitted the complete metering record");
    assert.deepEqual(JSON.parse(storedRecord.recordJson), expected);

    const storedState = findStoredMeteringState(database, conversationId);
    assert.ok(storedState, "SQLite does not contain bounded metering state");
    assert.equal(storedState.revision, 1);
    assert.deepEqual(JSON.parse(storedState.stateJson), expected.nextState);
  } finally {
    database.close();
  }
}

function assertSqliteHistory(
  conversationId: AgentConversationId,
  expectedMessages: readonly ExpectedMessage[],
): void {
  // Read through SQLite directly—not through library repositories—to prove that each
  // protocol message boundary was committed to the caller-selected database.
  const database = new Database(databasePath, { readonly: true });
  try {
    const first = findStoredUserMessage(database, conversationId, prompts[0]);
    assert.ok(first, "expected SQLite to contain the first user message");
    assert.equal(first.content, prompts[0]);

    const stored = listStoredMessages(database, conversationId);
    assert.deepEqual(
      stored.map(({ role, content }) => ({ role, content })),
      expectedMessages,
      "SQLite message history does not match the four prompt results",
    );
  } finally {
    database.close();
  }
}
