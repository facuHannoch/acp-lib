// Manual end-to-end check of the provider-attachment lifecycle against a real adapter.
//
// Fixtures prove the ordering and the database writes, but they cannot prove the two things
// that actually matter here: that a harness-issued `session/new` id is genuinely loadable on
// a later `session/load`, and that two processes of the same adapter coexist during a
// transition. This drives both against Codex.
//
// Run: bun run scripts/manual-provider-attachment-e2e.ts
import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, Agent } from "../src/index.ts";

const directory = await mkdtemp(join(tmpdir(), "acp-attachment-e2e-"));
const databasePath = join(directory, "agent.sqlite");

const config = {
  persistence: { kind: "sqlite" as const, path: databasePath },
  adapters: { codex: ADAPTERS.codex },
  defaultAdapterId: "codex",
  conversationDefaults: { cwd: process.cwd(), metering: { pricing: false as const } },
};

let agent: Agent | undefined;
try {
  agent = await Agent.open(config);
  const agentSessionId = agent.id;

  // 1-3. Create without prompting: the thread is live but not selected for a later open.
  const conversation = await agent.conversations.create();
  const id = conversation.agentConversationId;
  const createdId = conversation.internalSessionId;
  assert.ok(createdId, "created conversation has no live provider session id");
  assert.equal(
    await agent.persistence.providerSessions.active(id),
    null,
    "an unprompted conversation recorded an active provider mapping",
  );
  console.log(`PASS create live=${createdId} active=null`);

  // 4-5. Stop and reopen: a fresh thread, not a load of the discarded id.
  await conversation.stop();
  const reopenedFresh = await agent.conversations.open(id);
  assert.equal(reopenedFresh.providerSession, "new", "unprompted conversation did not open fresh");
  assert.notEqual(
    reopenedFresh.conversation.internalSessionId,
    createdId,
    "unprompted conversation tried to continue the discarded thread",
  );
  assert.equal(await agent.persistence.providerSessions.active(id), null);
  console.log(`PASS reopen-unprompted fresh=${reopenedFresh.conversation.internalSessionId}`);

  // 6-7. First completed turn records the live thread exactly once.
  const first = await reopenedFresh.conversation.prompt("Reply with only ACK.");
  assert.equal(first.status, "completed", "first provider prompt failed");
  const recorded = reopenedFresh.conversation.internalSessionId;
  const active = await agent.persistence.providerSessions.active(id);
  assert.equal(active?.internalSessionId, recorded, "first completed turn did not record the thread");
  assert.equal((await agent.persistence.providerSessions.list(id)).length, 1);
  console.log(`PASS first-turn recorded=${recorded} rows=1`);

  // 8. Reopen: `session/load` uses the recorded id and does not rotate the mapping.
  await reopenedFresh.conversation.stop();
  const reopenedLoaded = await agent.conversations.open(id);
  assert.equal(reopenedLoaded.providerSession, "loaded", "recorded conversation did not load");
  assert.equal(reopenedLoaded.conversation.internalSessionId, recorded);
  assert.equal((await agent.persistence.providerSessions.list(id)).length, 1);
  console.log(`PASS reopen-recorded loaded=${recorded} rows=1`);

  // Stage 2: a promptless same-adapter reset spawns a second provider process and defers
  // recording the target until a turn completes on it. The source stays the restart fallback.
  const beforeReset = await agent.persistence.providerSessions.active(id);
  const reset = await reopenedLoaded.conversation.reset();
  assert.equal(reset.providerAttachment, "runtime_only", "promptless reset claimed a recorded target");
  const targetId = reopenedLoaded.conversation.internalSessionId;
  assert.notEqual(targetId, recorded, "reset did not move to a fresh thread");
  const afterReset = await agent.persistence.providerSessions.active(id);
  assert.equal(
    afterReset?.internalSessionId,
    beforeReset?.internalSessionId,
    "promptless reset superseded the previous mapping before a turn confirmed it",
  );
  console.log(`PASS reset runtime_only target=${targetId} fallback=${afterReset?.internalSessionId}`);

  const second = await reopenedLoaded.conversation.prompt("Reply with only ACK.");
  assert.equal(second.status, "completed", "post-reset provider prompt failed");
  const afterPrompt = await agent.persistence.providerSessions.active(id);
  assert.equal(afterPrompt?.internalSessionId, targetId, "post-reset turn did not record the target");
  assert.equal((await agent.persistence.providerSessions.list(id)).length, 2);
  console.log(`PASS reset-confirmed active=${afterPrompt?.internalSessionId} rows=2`);

  // Stage 2: a same-adapter handoff seeds its target while the source is still live, then
  // records the target. This is the concurrent-process path.
  const handoff = await reopenedLoaded.conversation.handoff({
    continuation: { kind: "provided", content: "Continue the conversation. Reply with only ACK." },
  });
  assert.equal(handoff.providerAttachment, "recorded", "seeded handoff did not record its target");
  const handoffActive = await agent.persistence.providerSessions.active(id);
  assert.equal(
    handoffActive?.internalSessionId,
    reopenedLoaded.conversation.internalSessionId,
    "seeded handoff did not activate its target",
  );
  assert.equal(handoffActive?.transitionId, handoff.handoffId);
  console.log(`PASS handoff recorded=${handoff.toInternalSessionId} transition=${handoff.handoffId}`);

  console.log(`PASS provider-attachment manual E2E (agent=${agentSessionId})`);
  console.log(`SQLite retained at ${databasePath}`);
} finally {
  await agent?.close();
}
