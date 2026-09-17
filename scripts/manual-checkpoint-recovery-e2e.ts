import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  ADAPTERS,
  Agent,
  type ConversationRecoveryProgress,
} from "../src/index.ts";

const directory = await mkdtemp(join(tmpdir(), "acp-checkpoint-recovery-e2e-"));
const databasePath = join(directory, "agent.sqlite");
const recoveryFact = "The answer to PWEAS is 3.";

const agentConfig = {
  persistence: { kind: "sqlite" as const, path: databasePath },
  adapters: { codex: ADAPTERS.codex },
  defaultAdapterId: "codex",
  conversationDefaults: { cwd: process.cwd(), metering: { pricing: false } },
  checkpointing: {
    schedule: { milestones: [1], everyAfterMilestones: 50 },
  },
};

let firstAgent: Agent | undefined;
let recoveredAgent: Agent | undefined;
try {
  firstAgent = await Agent.open(agentConfig);
  const conversation = await firstAgent.conversations.create();
  const conversationId = conversation.agentConversationId;
  const originalInternalSessionId = conversation.internalSessionId;
  assert.ok(originalInternalSessionId, "initial conversation has no provider session");

  const initial = await conversation.prompt(
    `${recoveryFact} Remember this for later and reply with only ACK.`,
  );
  assert.equal(initial.status, "completed", "initial provider prompt failed");
  const checkpoint = await waitForCheckpoint(firstAgent, conversationId);
  assert.ok(checkpoint.summary.trim(), "generated checkpoint summary is empty");
  assert.equal(checkpoint.coveredSequence, 2, "checkpoint did not cover the initial turn");
  console.log(
    `PASS checkpoint id=${checkpoint.checkpointId} inference=${checkpoint.generatorInternalInferenceId}`,
  );

  const agentSessionId = firstAgent.id;
  await firstAgent.close();
  firstAgent = undefined;

  // Simulate provider-side loss without deleting the real Codex rollout. Only this
  // temporary database is changed, so session/load targets an intentionally absent ID.
  const missingInternalSessionId = crypto.randomUUID();
  const database = new Database(databasePath, { readwrite: true, strict: true });
  try {
    const changed = database.query(
      `UPDATE provider_sessions SET internal_session_id = ?
       WHERE agent_conversation_id = ? AND deactivated_at IS NULL`,
    ).run(missingInternalSessionId, conversationId);
    assert.equal(changed.changes, 1, "could not replace the active provider session ID");
  } finally {
    database.close();
  }

  const progress: ConversationRecoveryProgress[] = [];
  recoveredAgent = await Agent.open({ ...agentConfig, id: agentSessionId });
  const opened = await recoveredAgent.conversations.open(conversationId, {
    onRecoveryProgress: (event) => {
      progress.push(event);
      console.log(`RECOVERY ${event.stage}${event.checkpointId ? ` ${event.checkpointId}` : ""}`);
    },
  });
  assert.equal(opened.providerSession, "recovered", "missing provider session was not recovered");
  assert.equal(opened.recovery?.checkpointId, checkpoint.checkpointId);
  assert.equal(opened.recovery?.previousInternalSessionId, missingInternalSessionId);
  assert.notEqual(opened.recovery?.newInternalSessionId, missingInternalSessionId);
  assert.deepEqual(progress.map(({ stage }) => stage), [
    "load_failed",
    "loading_checkpoint",
    "loading_checkpoint",
    "creating_session",
    "seeding",
    "completed",
  ]);
  console.log(
    `PASS recovery old=${missingInternalSessionId} new=${opened.recovery!.newInternalSessionId}`,
  );

  const recall = await opened.conversation.prompt(
    "What is the answer to PWEAS? Respond with only the answer or DN if you do not know.",
  );
  assert.equal(recall.status, "completed", "post-recovery recall prompt failed");
  const recalled = recall.messages.map((message) => message.text).join("").trim();
  assert.equal(recalled, "3", "fresh provider session did not receive checkpoint context");
  console.log(`PASS recall answer=${recalled}`);

  const verification = new Database(databasePath, { readonly: true, strict: true });
  try {
    const recoveryAction = verification.query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM conversation_records
       WHERE agent_conversation_id = ? AND kind = 'native_action'
         AND json_extract(payload_json, '$.action') = 'conversation_recovery'
         AND json_extract(payload_json, '$.state') = 'completed'`,
    ).get(conversationId);
    assert.equal(Number(recoveryAction?.count ?? 0), 1, "completed recovery action was not persisted");
    const recoveryMetering = verification.query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM metering_records
       WHERE agent_conversation_id = ? AND operation_kind = 'conversation_recovery'`,
    ).get(conversationId);
    assert.equal(Number(recoveryMetering?.count ?? 0), 1, "recovery metering was not persisted");
    assert.equal(
      verification.query<{ result: string }, []>("PRAGMA integrity_check").get()?.result,
      "ok",
    );
  } finally {
    verification.close();
  }
  console.log("PASS checkpoint-recovery manual E2E");
} finally {
  await Promise.allSettled([firstAgent?.close(), recoveredAgent?.close()]);
  console.log(`SQLite retained at ${databasePath}`);
}

async function waitForCheckpoint(agent: Agent, conversationId: `agc-${string}`) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const checkpoint = await agent.checkpointing!.latest(conversationId);
    if (checkpoint) return checkpoint;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for generated checkpoint");
}
