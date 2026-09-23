#!/usr/bin/env bun

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ADAPTERS,
  Agent,
  createAgentConversationId,
  type Adapter,
  type ConversationRecord,
} from "@qlairoslabs/acp-client";

const configuredDirectory = process.env.ACP_TEST10_DATA_DIR?.trim();
const ownsTemporaryDirectory = !configuredDirectory;
const directory = configuredDirectory
  ? resolve(configuredDirectory)
  : await mkdtemp(join(tmpdir(), "acp-events-smoke-"));
if (configuredDirectory) await mkdir(directory, { recursive: true });
const databasePath = join(directory, "agent.sqlite");

const adapters: Record<string, Adapter> = {
  codex: ADAPTERS.codex,
  opencode: ADAPTERS.opencode,
};
const adapterId = process.env.ACP_TEST10_ADAPTER?.trim() || "codex";
assert.ok(adapters[adapterId], `unknown ACP_TEST10_ADAPTER: ${adapterId}`);

let agent: Agent | undefined;

try {
  agent = await Agent.open({
    persistence: { kind: "sqlite", path: databasePath },
    adapters,
    defaultAdapterId: adapterId,
    conversationDefaults: { cwd: process.cwd(), metering: { pricing: false } },
    // Milestone 1 forces a checkpoint after the first completed turn, which exercises the
    // internal-inference artifact path through the bus.
    checkpointing: { schedule: { milestones: [1], everyAfterMilestones: 50 } },
  });

  const conversation = await agent.conversations.create();
  const conversationId = conversation.id;

  // Subscribe before the first prompt: the bus has no replay, so anything before a
  // subscription is only available by reading history.
  const all: ConversationRecord[] = [];
  const messagesOnly: ConversationRecord[] = [];
  const unknownConversation: ConversationRecord[] = [];
  agent.events.subscribe((notification) => all.push(notification.event.record), {
    conversationIds: [conversationId],
  });
  agent.events.subscribe((notification) => messagesOnly.push(notification.event.record), {
    conversationIds: [conversationId],
    recordKinds: ["message"],
  });
  agent.events.subscribe((notification) => unknownConversation.push(notification.event.record), {
    conversationIds: [createAgentConversationId()],
  });

  const result = await conversation.prompt("Reply with only ACK.");
  assert.equal(result.status, "completed", "prompt failed");
  const checkpoint = await waitForCheckpoint(agent, conversationId);

  // 1. Every emitted record is the exact persisted record: same id, sequence, and kind.
  const persisted = (await agent.persistence.records.list(conversationId, { limit: 1_000 })).records;
  const byId = new Map(persisted.map((record) => [record.recordId, record]));
  for (const record of all) {
    const stored = byId.get(record.recordId);
    assert.ok(stored, `bus emitted ${record.recordId}, which is not persisted`);
    assert.equal(stored.sequence, record.sequence, `sequence mismatch for ${record.recordId}`);
    assert.equal(stored.kind, record.kind, `kind mismatch for ${record.recordId}`);
  }
  assert.ok(all.some((record) => record.kind === "message" && record.role === "user"), "no user message event");
  assert.ok(
    all.some((record) => record.kind === "message" && record.role === "assistant" && record.status === "completed"),
    "no completed assistant message event",
  );
  assert.ok(all.some((record) => record.kind === "metering"), "no metering reference event");
  console.log(`PASS reconcile records=${all.length} against ${persisted.length} persisted`);

  // 2. A checkpoint completion artifact reaches the bus (the internal-inference path).
  const checkpointEvent = all.find(
    (record): record is Extract<ConversationRecord, { kind: "native_action" }> =>
      record.kind === "native_action" && record.action === "conversation_checkpoint",
  );
  assert.ok(checkpointEvent, "checkpoint completion record did not reach the bus");
  assert.equal(checkpointEvent.state, "completed", "checkpoint event is not completed");
  assert.equal(
    checkpointEvent.recordId,
    `${checkpoint.generatorInternalInferenceId}:checkpoint`,
    "checkpoint event does not match the generated checkpoint",
  );
  console.log(`PASS checkpoint-event ${checkpointEvent.recordId}`);

  // 3. recordKinds filtering is exact.
  assert.ok(messagesOnly.length > 0, "message filter received nothing");
  assert.ok(messagesOnly.every((record) => record.kind === "message"), "message filter leaked another kind");
  console.log(`PASS kind-filter messages=${messagesOnly.length}`);

  // 4. An unknown conversation id matches nothing.
  assert.equal(unknownConversation.length, 0, "unknown conversation id received records");
  console.log("PASS conversation-filter");

  // 5. A throwing subscriber cannot fail a prompt and does not stop its siblings.
  let siblingDeliveries = 0;
  agent.events.subscribe(() => {
    throw new Error("intentional subscriber failure");
  });
  agent.events.subscribe((notification) => {
    if (notification.event.record.agentConversationId === conversationId) siblingDeliveries += 1;
  });
  const survived = await conversation.prompt("Reply with only ACK again.");
  assert.equal(survived.status, "completed", "a throwing subscriber failed the prompt");
  assert.ok(siblingDeliveries > 0, "a sibling subscriber stopped receiving after a throw");
  console.log(`PASS listener-isolation delivered=${siblingDeliveries}`);

  // 6. A consumer-direct append is outside the Agent bus.
  const beforeDirect = all.length;
  await agent.persistence.records.append({
    recordId: "direct-append",
    agentSessionId: agent.id,
    agentConversationId: conversationId,
    kind: "message",
    timestamp: new Date().toISOString(),
    role: "user",
    content: "written outside the Agent",
    status: "completed",
  });
  assert.equal(all.length, beforeDirect, "a consumer-direct append was observed");
  console.log("PASS consumer-direct-append-unobserved");

  // 7. Closing the Agent clears subscriptions.
  const synthetic: ConversationRecord = {
    recordId: "post-close",
    agentSessionId: agent.id,
    agentConversationId: conversationId,
    sequence: 1,
    kind: "message",
    timestamp: new Date().toISOString(),
    role: "assistant",
    content: "after close",
    status: "completed",
  };
  const beforeClose = all.length;
  await agent.close();
  agent.publishCommittedRecords([synthetic]);
  assert.equal(all.length, beforeClose, "the bus delivered after close");
  console.log("PASS close-clears-subscriptions");

  console.log(`PASS test10-events smoke (adapter=${adapterId})`);
} finally {
  await agent?.close();
  if (ownsTemporaryDirectory) {
    await rm(directory, { recursive: true, force: true });
  } else {
    console.log(`SQLite retained at ${databasePath}`);
  }
}

async function waitForCheckpoint(agent: Agent, conversationId: ReturnType<typeof createAgentConversationId>) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const checkpoint = await agent.checkpointing!.latest(conversationId);
    if (checkpoint) return checkpoint;
    await Bun.sleep(100);
  }
  throw new Error("timed out waiting for a generated checkpoint");
}
