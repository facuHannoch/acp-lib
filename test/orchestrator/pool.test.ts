import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, createAgentConversationId, type AgentConversation, type WorkerEvent } from "../../src/index.ts";
import { WorkerPool } from "../../src/orchestrator/pool.ts";

const actor = { kind: "consumer" } as const;

async function rig(limit: number, holds = true, idleStopMs?: number | false) {
  const directory = await mkdtemp(join(tmpdir(), "acp-worker-pool-"));
  const release = join(directory, "release");
  const providerState = join(directory, "provider-sessions.json");
  const fixture = resolve(import.meta.dir, holds ? "../fixtures/lifecycle-agent.ts" : "../fixtures/echo-prompt-agent.ts");
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
    adapters: { fixture: { command: ["bun", fixture] } },
    capture: { message: "content" },
    checkpointing: { enabled: false },
    orchestrator: { workers: { limit, idleStopMs } },
    conversationDefaults: { env: { LIFECYCLE_TOOL_GATE_FILE: release, LIFECYCLE_STATE: providerState } },
  });
  return { agent, pool: agent.orchestrator!, providerState, release: () => writeFile(release, ""), hold: () => rm(release), async close() {
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
    expect(await pool.send({ kind: "conversation", conversationId: createAgentConversationId(), sender: "other", invocationId: "other", policyNames: ["trusted"], workerPermissions: [],
      policy: { use: true, scope: "all", redirect: false } },
      "w1", { text: "unexpected second prompt" })).toMatchObject({ status: "busy" });
    const worker = await pool.check(actor, "w1");
    const { conversation } = await agent.conversations.open(worker.conversationId);
    const settled = idle(conversation);
    await release();
    await settled;
    expect(await pool.check(actor, "w1")).toMatchObject({ state: "idle" });
    expect(await pool.list(actor)).toHaveLength(1);
  } finally {
    await close();
  }
}, 20_000);

test("idle eviction is least-recently used and send reloads the same conversation", async () => {
  const { agent, pool, release, close } = await rig(2, false);
  const events: WorkerEvent[] = [];
  agent.events.subscribeWorkers(({ event }) => events.push(event));
  try {
    await release();
    for (const handle of ["w1", "w2"]) {
      expect(await pool.open(actor, { text: "[lifecycle:tool]" })).toMatchObject({ handle });
      const row = await pool.check(actor, handle);
      const { conversation } = await agent.conversations.open(row.conversationId);
      await idle(conversation);
    }
    expect(await pool.send(actor, "w1", { text: "[lifecycle:tool]", about: "recent" })).toEqual({ status: "sent" });
    const recent = await pool.check(actor, "w1");
    await idle((await agent.conversations.open(recent.conversationId)).conversation);
    const older = await pool.check(actor, "w2");
    const original = (await agent.conversations.open(older.conversationId)).conversation;

    expect(await pool.open(actor, { text: "[lifecycle:tool]" })).toMatchObject({ handle: "w3" });
    expect(original.state.phase).toBe("stopped");
    expect(await pool.check(actor, "w2")).toMatchObject({ state: "offline" });
    const newest = await pool.check(actor, "w3");
    await idle((await agent.conversations.open(newest.conversationId)).conversation);

    expect(await pool.send(actor, "w2", { text: "[lifecycle:tool]", about: "reopened" })).toEqual({ status: "sent" });
    const reopened = await pool.check(actor, "w2");
    expect(reopened).toMatchObject({ conversationId: older.conversationId, about: "reopened" });
    const replacement = (await agent.conversations.open(reopened.conversationId)).conversation;
    expect(replacement).not.toBe(original);
    await idle(replacement);
    expect(await pool.check(actor, "w1")).toMatchObject({ state: "offline", about: "recent" });
    expect(await pool.list(actor)).toHaveLength(3);
    expect(events).toContainEqual(expect.objectContaining({ kind: "worker_stopped", handle: "w2", reason: "eviction" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "worker_reloaded", handle: "w2", conversationId: older.conversationId }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "worker_replied", handle: "w2" }));
    await agent.conversations.delete(recent.conversationId);
    await expect(pool.send(actor, "w1", { text: "gone" })).rejects.toThrow("worker conversation is unavailable");
    expect((await agent.persistence.workers!.get("w1"))?.droppedAt).toBeDefined();
    expect(await pool.check(actor, "w2")).toMatchObject({ state: "idle" });
    expect(await pool.check(actor, "w3")).toMatchObject({ state: "idle" });
  } finally {
    await close();
  }
}, 20_000);

test("the consumer lists, interrupts and drops workers while worker events stay distinct from records", async () => {
  const { agent, pool, close } = await rig(2);
  const events: WorkerEvent[] = [];
  const recordKinds: string[] = [];
  const workAtProvider = Promise.withResolvers<void>();
  const accesses = new Set<string>();
  agent.events.subscribeWorkers(({ event }) => events.push(event));
  agent.events.subscribe(({ event }) => {
    recordKinds.push(event.kind);
    const record = event.record;
    if (record.kind !== "tool_call" || record.state !== "announced") return;
    accesses.add(record.agentConversationId);
    if (accesses.size === 2) workAtProvider.resolve();
  });
  try {
    const workers = agent.workers!;
    await pool.open(actor, { text: "[lifecycle:tool]" });
    await pool.open(actor, { text: "[lifecycle:tool]" });
    await workAtProvider.promise;
    const listed = await workers.list();
    expect(listed.map(worker => [worker.handle, worker.state])).toEqual([["w1", "busy"], ["w2", "busy"]]);
    await Promise.all(listed.map(worker => workers.stop(worker.handle)));
    expect((await workers.check("w1")).state).toBe("idle");
    expect((await workers.check("w2")).state).toBe("idle");
    await workers.delete("w1");
    expect((await workers.list()).map(worker => worker.handle)).toEqual(["w2"]);
    expect(await agent.persistence.workers!.get("w1")).toMatchObject({ droppedAt: expect.any(String) });
    expect((await agent.conversations.get(listed[0]!.conversationId))?.deletedAt).toBeDefined();

    expect(events.filter(event => event.handle === "w1").map(event => event.kind))
      .toEqual(["worker_opened", "worker_busy", "worker_idle", "worker_stopped", "worker_dropped"]);
    expect(events.find(event => event.kind === "worker_stopped")).toMatchObject({ reason: "requested" });
    expect(new Set(recordKinds)).toEqual(new Set(["conversation_record_committed"]));
  } finally {
    await close();
  }
}, 15_000);

test("worker failure notifications expose a fixed reason and the worker returns idle", async () => {
  const { agent, pool, close } = await rig(1, false);
  const idleEvent = Promise.withResolvers<void>();
  const events: WorkerEvent[] = [];
  agent.events.subscribeWorkers(({ event }) => {
    events.push(event);
    if (event.kind === "worker_idle") idleEvent.resolve();
  });
  try {
    await pool.open(actor, { text: "FAIL_TURN sensitive provider details" });
    await idleEvent.promise;
    expect(events.map(event => event.kind)).toEqual(["worker_opened", "worker_busy", "worker_failed", "worker_idle"]);
    expect(events[2]).toMatchObject({ reason: "worker failed" });
    expect((await agent.workers!.check("w1")).state).toBe("idle");
  } finally {
    await close();
  }
}, 15_000);

test("conversation policy enforces use, scope, redirect, other-giver stop/drop and maxOpen", async () => {
  const { agent, pool, close } = await rig(2);
  const giver = {
    kind: "conversation", conversationId: createAgentConversationId(), sender: "giver", invocationId: "give", policyNames: ["trusted"], workerPermissions: [],
    policy: { use: true, scope: "none", redirect: false, maxOpen: 1 },
  } as const;
  const other = { ...giver, conversationId: createAgentConversationId(), sender: "other", invocationId: "other", policy: { ...giver.policy, scope: "all" as const } };
  const noUse = { ...other, policy: { ...other.policy, use: false } };
  const hidden = { ...other, policy: { ...other.policy, scope: "none" as const } };
  const tool = Promise.withResolvers<void>();
  agent.events.subscribe(({ event }) => {
    if (event.record.kind === "tool_call" && event.record.state === "announced") tool.resolve();
  });
  try {
    await expect(pool.open(noUse, { text: "no" })).rejects.toMatchObject({ rule: "use" });
    expect(await pool.open(giver, { text: "[lifecycle:tool]" })).toEqual({ status: "sent", handle: "w1" });
    await tool.promise;
    await expect(pool.send(noUse, "w1", { text: "no" })).rejects.toMatchObject({ rule: "use" });
    expect(await pool.list(hidden)).toEqual([]);
    await expect(pool.check(hidden, "unknown")).rejects.toMatchObject({ rule: "scope" });
    await expect(pool.send(hidden, "w1", { text: "hidden" })).rejects.toMatchObject({ rule: "scope" });
    await expect(pool.send(other, "w1", { text: "take it", redirect: true })).rejects.toMatchObject({ rule: "redirect" });
    await expect(pool.send(other, "w1", { text: "take it", redirect: true, assignment: "new" })).rejects.toMatchObject({ rule: "redirect" });
    await expect(pool.stop(other, "w1")).rejects.toMatchObject({ rule: "redirect" });
    await expect(pool.drop(giver, "w1")).rejects.toMatchObject({ rule: "redirect" });
    expect(await pool.check(giver, "w1")).toMatchObject({ state: "busy", lastConversation: giver.conversationId });
    await pool.stop(giver, "w1");
    await expect(pool.open(giver, { text: "second" })).rejects.toMatchObject({ rule: "maxOpen" });
    expect(await pool.check(giver, "w1")).toMatchObject({ state: "idle" });
    await pool.drop({ ...other, policy: { ...other.policy, redirect: true } }, "w1");
    expect(await pool.open(giver, { text: "after drop" })).toEqual({ status: "sent", handle: "w2" });
    expect((await agent.workers!.list()).map(worker => worker.handle)).toEqual(["w2"]);
  } finally {
    await close();
  }
}, 20_000);

for (const providerSupportsDelete of [true, false]) {
  test(`drop reports provider cleanup when deletion is ${providerSupportsDelete ? "supported" : "unsupported"}`, async () => {
    const { agent, pool, close, providerState } = await rig(1, providerSupportsDelete);
    const finished = Promise.withResolvers<void>();
    agent.events.subscribeWorkers(({ event }) => { if (event.kind === "worker_idle") finished.resolve(); });
    try {
      await pool.open(actor, { text: "register a provider session" });
      await finished.promise;
      const worker = await agent.workers!.check("w1");
      const thread = (await agent.persistence.providerSessions.active(worker.conversationId))!.internalSessionId;
      if (providerSupportsDelete) expect(JSON.parse(await readFile(providerState, "utf8"))).toHaveProperty(thread);
      expect(await agent.workers!.delete("w1")).toMatchObject({
        providerDeleted: providerSupportsDelete ? true : "unsupported",
      });
      if (providerSupportsDelete) expect(JSON.parse(await readFile(providerState, "utf8"))).not.toHaveProperty(thread);
      expect((await agent.conversations.get(worker.conversationId))?.deletedAt).toBeDefined();
      expect((await agent.persistence.workers!.get("w1"))?.droppedAt).toBeDefined();
    } finally { await close(); }
  }, 20_000);
}

for (const op of ["check", "list"] as const) {
  test(`worker ${op} reconciles a directly deleted or missing conversation once`, async () => {
    const { agent, pool, close } = await rig(1, false);
    const dropped: string[] = [];
    agent.events.subscribeWorkers(({ event }) => { if (event.kind === "worker_dropped") dropped.push(event.handle); });
    try {
      await pool.open(actor, { text: "work" });
      const worker = await agent.workers!.check("w1");
      if (op === "check") {
        await agent.conversations.delete(worker.conversationId);
        await expect(agent.workers!.check("w1")).rejects.toThrow("worker conversation is unavailable");
      } else {
        const storeGet = agent.conversations.get.bind(agent.conversations);
        const spy = spyOn(agent.conversations, "get").mockImplementation(id =>
          id === worker.conversationId ? Promise.resolve(null) : storeGet(id));
        try { expect(await agent.workers!.list()).toEqual([]); }
        finally { spy.mockRestore(); }
      }
      expect(await agent.workers!.list()).toEqual([]);
      expect((await agent.persistence.workers!.get("w1"))?.droppedAt).toBeDefined();
      expect(dropped).toEqual(["w1"]);
    } finally { await close(); }
  }, 20_000);
}

test("idle timeout releases the provider slot and the next send reloads its conversation", async () => {
  const { agent, pool, release, hold, close } = await rig(1, true, 30);
  const stopped = Promise.withResolvers<WorkerEvent>();
  const reloaded = Promise.withResolvers<WorkerEvent>();
  agent.events.subscribeWorkers(({ event }) => {
    if (event.kind === "worker_stopped" && event.reason === "idle") stopped.resolve(event);
    if (event.kind === "worker_reloaded") reloaded.resolve(event);
  });
  try {
    await pool.open(actor, { text: "[lifecycle:tool]" });
    const worker = await agent.workers!.check("w1");
    const original = (await agent.conversations.open(worker.conversationId)).conversation;
    expect(original.connection.isConnected).toBe(true);
    await release();
    expect(await stopped.promise).toMatchObject({ handle: "w1", conversationId: worker.conversationId, reason: "idle" });
    expect(original.connection.isConnected).toBe(false);
    expect((await agent.workers!.check("w1")).state).toBe("offline");

    await hold();
    expect(await pool.send(actor, "w1", { text: "[lifecycle:tool]" })).toEqual({ status: "sent" });
    expect(await reloaded.promise).toMatchObject({ handle: "w1", conversationId: worker.conversationId });
    const replacement = (await agent.conversations.open(worker.conversationId)).conversation;
    expect(replacement).not.toBe(original);
    expect(replacement.connection.isConnected).toBe(true);
    expect(replacement.internalSessionId).toBe(original.internalSessionId);
    await release();
  } finally { await close(); }
}, 20_000);

test("idle timers can be disabled, are cleared by a new send and stay closed at shutdown", async () => {
  const { agent, close } = await rig(1, false);
  try {
    const conversation = await agent.conversations.create({ role: "worker" });
    const row = { handle: "timer", conversationId: conversation.id, openedBy: "consumer", createdAt: new Date().toISOString() } as const;
    const ignore = () => {};
    const disabled = new WorkerPool(1, false);
    const inactive = disabled.attach(row, conversation);
    disabled.armIdle(inactive, ignore, ignore);
    expect(inactive.idleTimer).toBeUndefined();

    const enabled = new WorkerPool(1, 600_000);
    const live = enabled.attach(row, conversation);
    try {
      enabled.armIdle(live, ignore, ignore);
      expect(live.idleTimer).toBeDefined();
      const work = enabled.start(live, { id: "new" });
      expect(live.idleTimer).toBeUndefined();
      enabled.finish(live, work);
      enabled.armIdle(live, ignore, ignore);
      expect(live.idleTimer).toBeDefined();
      enabled.closeIdleTimers();
      enabled.armIdle(live, ignore, ignore);
      expect(live.idleTimer).toBeUndefined();
    } finally { enabled.closeIdleTimers(); }
  } finally { await close(); }
}, 15_000);


test("drop succeeds for a directly deleted worker before another operation reconciles it", async () => {
  const { agent, pool, close } = await rig(1, false);
  const dropped: string[] = [];
  agent.events.subscribeWorkers(({ event }) => { if (event.kind === "worker_dropped") dropped.push(event.handle); });
  try {
    await pool.open(actor, { text: "work" });
    const worker = await agent.workers!.check("w1");
    await agent.conversations.delete(worker.conversationId);
    expect(await agent.workers!.delete("w1")).toEqual({ providerDeleted: false, checkpointsDeleted: 0 });
    expect((await agent.persistence.workers!.get("w1"))?.droppedAt).toBeDefined();
    expect(dropped).toEqual(["w1"]);
  } finally { await close(); }
}, 20_000);
