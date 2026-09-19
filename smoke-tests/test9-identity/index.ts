#!/usr/bin/env bun

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ADAPTERS, Agent, type Adapter } from "@qlairoslabs/acp-client";

const configuredDirectory = process.env.ACP_TEST9_DATA_DIR?.trim();
const ownsTemporaryDirectory = !configuredDirectory;
const directory = configuredDirectory
  ? resolve(configuredDirectory)
  : await mkdtemp(join(tmpdir(), "acp-identity-smoke-"));
if (configuredDirectory) await mkdir(directory, { recursive: true });
const databasePath = join(directory, "agent.sqlite");

const adapters: Record<string, Adapter> = {
  codex: ADAPTERS.codex,
  opencode: ADAPTERS.opencode,
};
const adapterId = process.env.ACP_TEST9_ADAPTER?.trim() || "codex";
assert.ok(adapters[adapterId], `unknown ACP_TEST9_ADAPTER: ${adapterId}`);

// A unique codeword avoids accidentally passing because of a previous run or model knowledge.
const codeword = `identity-${randomUUID().slice(0, 8)}`;
const answer = "731942";
let agent: Agent | undefined;

try {
  agent = await Agent.open({
    persistence: { kind: "sqlite", path: databasePath },
    adapters,
    defaultAdapterId: adapterId,
    conversationDefaults: { cwd: process.cwd(), metering: { pricing: false } },
    checkpointing: {
      // This smoke test isolates cross-conversation delivery of canonical messages.
      // Checkpoint-summary generation and recovery are exercised separately.
      schedule: { milestones: [1_000], everyAfterMilestones: 1_000 },
    },
    identity: { kind: "checkpoint-backed" },
    identityConsistency: "through-current",
  });

  const first = await agent.conversations.create({ title: "first participant" });
  const firstGreeting = await first.prompt("Hello. Reply with only READY.");
  assert.equal(firstGreeting.status, "completed", "first conversation did not start");

  const source = await agent.conversations.create({ title: "fact source" });
  const fact = `The answer to codeword ${codeword} is ${answer}. Reply with only ACK.`;
  const sourceResult = await source.prompt(fact);
  assert.equal(sourceResult.status, "completed", "source conversation did not store the fact");

  const recall = await first.prompt(
    `What is the answer to codeword ${codeword}? Reply with only the six-digit answer, or DN if you do not know.`,
  );
  assert.equal(recall.status, "completed", "cross-conversation recall prompt failed");
  assert.equal(recall.text.trim(), answer, "first conversation did not recall the fact from the source");
  assert.ok(first.internalSessionId, "first conversation has no provider context id");
  const firstCursor = await agent.persistence.identityDelivery!.get(
    first.id,
    first.internalSessionId,
    source.id,
  );
  assert.ok(firstCursor, "successful recall did not persist the source delivery cursor");
  console.log(`PASS cross-conversation recall first=${first.id} source=${source.id} answer=${recall.text.trim()}`);

  const newcomer = await agent.conversations.create({ title: "new participant" });
  const awareness = await newcomer.prompt(
    `Before this conversation, did anyone ask this agent for the answer to codeword ${codeword}? ` +
    "Reply with only YES or NO. Do not count this question itself.",
  );
  assert.equal(awareness.status, "completed", "new conversation awareness prompt failed");
  assert.equal(awareness.text.trim().toUpperCase(), "YES", "new conversation did not see the earlier question");
  assert.ok(newcomer.internalSessionId, "new conversation has no provider context id");
  const newcomerCursor = await agent.persistence.identityDelivery!.get(
    newcomer.id,
    newcomer.internalSessionId,
    first.id,
  );
  assert.ok(newcomerCursor, "new conversation did not persist its cursor for the earlier conversation");

  const storedSource = await agent.persistence.messages.list(source.id);
  assert.ok(
    storedSource.messages.some((message) => message.role === "user" && message.content === fact),
    "source fact is missing from the canonical SQLite transcript",
  );
  const storedFirst = await agent.persistence.messages.list(first.id);
  assert.ok(
    storedFirst.messages.some((message) => message.role === "user" && message.content.includes(`What is the answer to codeword ${codeword}?`)),
    "earlier question is missing from the canonical SQLite transcript",
  );
  console.log(`PASS new-conversation awareness newcomer=${newcomer.id} answer=${awareness.text.trim()}`);
  console.log(`PASS identity smoke agent=${agent.id} database=${databasePath}`);
} finally {
  await agent?.close();
  if (ownsTemporaryDirectory) {
    await rm(directory, { recursive: true, force: true });
  } else {
    console.log(`SQLite retained at ${databasePath}`);
  }
}
