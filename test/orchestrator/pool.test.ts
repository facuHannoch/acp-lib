import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, type AgentConversation } from "../../src/index.ts";

const actor = { kind: "consumer" } as const;

async function rig(limit: number, holds = true) {
  const directory = await mkdtemp(join(tmpdir(), "acp-worker-pool-"));
  const release = join(directory, "release");
  const fixture = resolve(import.meta.dir, holds ? "../fixtures/lifecycle-agent.ts" : "../fixtures/echo-prompt-agent.ts");
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
    adapters: { fixture: { command: ["bun", fixture] } },
    capture: { message: "content" },
    checkpointing: { enabled: false },
    orchestrator: { workers: { limit } },
    conversationDefaults: { env: { LIFECYCLE_TOOL_GATE_FILE: release, LIFECYCLE_STATE: join(directory, "provider-sessions.json") } },
  });
  return { agent, pool: agent.orchestrator!, release: () => writeFile(release, ""), async close() {
    try { await agent.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  } };
}

async function idle(conversation: AgentConversation) {
  if (!conversation.isBusy) return;
  const done = Promise.withResolvers<void>();
  const detach = conversation.subscribe(({ event }) => {
    if (event.kind === "state_changed" && event.state.phase === "idle") done.resolve();
  });
  const timer = setTimeout(() => done.reject(new Error("worker did not go idle")), 8_000);
  try { await done.promise; } finally { clearTimeout(timer); detach(); }
}

test("two opens racing for the last slot admit one, with the busy worker in the refusal", async () => {
  const { agent, pool, release, close } = await rig(1);
  try {
    const results = await Promise.all([pool.open(actor, { text: "[lifecycle:tool]", about: "first" }),
      pool.open(actor, { text: "[lifecycle:tool]", about: "second" })]);
    expect(results[0]).toEqual({ status: "sent", handle: "w1" });
    expect(results[1]).toMatchObject({ status: "no_worker_free", workers: [{ handle: "w1", state: "busy", about: "first" }] });
    expect(await pool.send(actor, "w1", { text: "unexpected second prompt" })).toMatchObject({ status: "busy" });
    const worker = await pool.check("w1");
    const { conversation } = await agent.conversations.open(worker.conversationId);
    const settled = idle(conversation);
    await release();
    await settled;
    expect(await pool.check("w1")).toMatchObject({ state: "idle" });
    expect(await pool.list()).toHaveLength(1);
  } finally {
    await close();
  }
}, 20_000);

test("idle eviction is least-recently used and send reloads the same conversation", async () => {
  const { agent, pool, release, close } = await rig(2, false);
  try {
    await release();
    for (const handle of ["w1", "w2"]) {
      expect(await pool.open(actor, { text: "[lifecycle:tool]" })).toMatchObject({ handle });
      const row = await pool.check(handle);
      const { conversation } = await agent.conversations.open(row.conversationId);
      await idle(conversation);
    }
    expect(await pool.send(actor, "w1", { text: "[lifecycle:tool]", about: "recent" })).toEqual({ status: "sent" });
    const recent = await pool.check("w1");
    await idle((await agent.conversations.open(recent.conversationId)).conversation);
    const older = await pool.check("w2");
    const original = (await agent.conversations.open(older.conversationId)).conversation;

    expect(await pool.open(actor, { text: "[lifecycle:tool]" })).toMatchObject({ handle: "w3" });
    expect(original.state.phase).toBe("stopped");
    expect(await pool.check("w2")).toMatchObject({ state: "offline" });
    const newest = await pool.check("w3");
    await idle((await agent.conversations.open(newest.conversationId)).conversation);

    expect(await pool.send(actor, "w2", { text: "[lifecycle:tool]", about: "reopened" })).toEqual({ status: "sent" });
    const reopened = await pool.check("w2");
    expect(reopened).toMatchObject({ conversationId: older.conversationId, about: "reopened" });
    const replacement = (await agent.conversations.open(reopened.conversationId)).conversation;
    expect(replacement).not.toBe(original);
    await idle(replacement);
    expect(await pool.check("w1")).toMatchObject({ state: "offline", about: "recent" });
    expect(await pool.list()).toHaveLength(3);
  } finally {
    await close();
  }
}, 20_000);
