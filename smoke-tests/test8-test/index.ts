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
  type AgentConversationId,
} from "@qlairoslabs/acp-client";
import { findStoredUserMessage, listStoredMessages } from "./queries.ts";

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
} finally {
  await Promise.allSettled([
    firstAgent?.close(),
    reopenedAgent?.close(),
  ]);
  if (ownsTemporaryDirectory) {
    await rm(directory, { recursive: true, force: true });
  } else {
    console.log(`SQLite retained at ${databasePath}`);
  }
}

async function openAgent(): Promise<Agent> {
  return await Agent.open({
    persistence: {
      kind: "sqlite",
      path: databasePath,
    },
    adapters,
    defaultAdapterId: adapterId,
  });
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
