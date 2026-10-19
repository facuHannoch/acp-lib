// Manual end-to-end check of the conversation error-record flow against a real adapter.
//
// It records a real provider thread, then points the active mapping at an id that does not
// exist to simulate provider-side loss, and asserts that reopening persists a sanitized
// `error` record, publishes it through `agent.events`, throws a structured
// `ProviderSessionError`, and leaves the failed mapping in place as evidence.
//
// Run: ACP_ERROR_E2E_ADAPTER=opencode bun run scripts/manual-error-record-e2e.ts
import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  ADAPTERS,
  Agent,
  ProviderSessionError,
  type Adapter,
  type ConversationRecord,
} from "../src/index.ts";

const directory = await mkdtemp(join(tmpdir(), "acp-error-record-e2e-"));
const databasePath = join(directory, "agent.sqlite");

const adapters: Record<string, Adapter> = {
  codex: ADAPTERS.codex,
  opencode: ADAPTERS.opencode,
};
const adapterId = process.env.ACP_ERROR_E2E_ADAPTER?.trim() || "codex";
const selected = adapters[adapterId];
assert.ok(selected, `unknown ACP_ERROR_E2E_ADAPTER: ${adapterId}`);

const config = {
  persistence: { kind: "sqlite" as const, path: databasePath },
  adapters: { [adapterId]: selected },
  defaultAdapterId: adapterId,
  conversationDefaults: { cwd: process.cwd(), metering: { pricing: false as const } },
};

let first: Agent | undefined;
let second: Agent | undefined;
try {
  first = await Agent.open(config);
  const conversation = await first.conversations.create();
  const conversationId = conversation.agentConversationId;
  const recorded = conversation.internalSessionId;
  assert.ok(recorded, "created conversation has no provider session id");
  const result = await conversation.prompt("Reply with only ACK.");
  assert.equal(result.status, "completed", "provider prompt failed");
  const agentSessionId = first.id;
  await first.close();
  first = undefined;

  // Simulate provider-side loss without deleting the real rollout: point the recorded
  // mapping at an id the harness will not find.
  const missing = crypto.randomUUID();
  const database = new Database(databasePath, { readwrite: true, strict: true });
  try {
    const changed = database.query(
      `UPDATE provider_sessions SET internal_session_id = ?
       WHERE agent_conversation_id = ? AND deactivated_at IS NULL`,
    ).run(missing, conversationId);
    assert.equal(changed.changes, 1, "could not replace the active provider session id");
  } finally {
    database.close();
  }

  second = await Agent.open({ ...config, id: agentSessionId });
  const events: ConversationRecord[] = [];
  second.events.subscribe((notification) => events.push(notification.event.record), {
    conversationIds: [conversationId],
  });

  const caught = await second.conversations.open(conversationId)
    .then(() => null, (error: unknown) => error);
  assert.ok(caught instanceof ProviderSessionError, "open did not throw ProviderSessionError");
  assert.equal(caught.code, "provider_session_missing", "unexpected classification");
  assert.equal(caught.recoverability, "recoverable");
  assert.equal(caught.source, "provider_session");
  assert.equal(caught.agentConversationId, conversationId);
  assert.equal(caught.internalSessionId, missing);
  assert.match(caught.attemptId, /^provider-load-/);
  assert.equal(caught.recordId, `${caught.attemptId}:error`);
  console.log(`PASS structured error code=${caught.code} attempt=${caught.attemptId}`);

  const records = (await second.persistence.records.list(conversationId, { kinds: ["error"] })).records;
  assert.equal(records.length, 1, "expected exactly one error record");
  const record = records[0]!;
  assert.equal(record.kind, "error");
  assert.equal(record.recordId, caught.recordId);
  assert.equal(record.kind === "error" ? record.code : "", "provider_session_missing");
  assert.equal(record.kind === "error" ? record.internalSessionId : "", missing);
  console.log(`PASS persisted error sequence=${record.sequence}`);

  assert.ok(events.some((event) => event.recordId === record.recordId), "error did not reach agent.events");
  console.log("PASS published through agent.events");

  const active = await second.persistence.providerSessions.active(conversationId);
  assert.equal(active?.internalSessionId, missing, "failed mapping was not retained");
  console.log("PASS failed mapping retained");

  console.log(`PASS conversation-error manual E2E (adapter=${adapterId})`);
  console.log(`SQLite retained at ${databasePath}`);
} finally {
  await Promise.allSettled([first?.close(), second?.close()]);
}
