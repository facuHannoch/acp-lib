import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "../../src/index.ts";
import { contentText } from "../../src/media/content.ts";
import type { WorkerActor } from "../../src/orchestrator/contracts.ts";
import type { PermissionLevel } from "../../src/permissions/matcher.ts";
import type { ConversationPermissionEvent } from "../../src/permissions/conversation.ts";

async function rig(level: PermissionLevel, options: { answers?: boolean; timeoutMs?: number; owner?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "acp-worker-permissions-"));
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path: join(root, "agent.sqlite") },
    adapters: {
      giver: { command: ["bun", resolve(import.meta.dir, "../fixtures/echo-prompt-agent.ts")] },
      worker: { command: ["bun", resolve(import.meta.dir, "../fixtures/permission-agent.ts")] },
    },
    defaultAdapterId: "giver",
    permissions: { default: "allow" },
    capture: { message: "content" },
    checkpointing: { enabled: false },
    orchestrator: { workers: { adapterId: "worker", limit: 1 } },
  });
  try {
    const giver = await agent.conversations.create({ answersPermissions: options.answers, permissionTimeoutMs: options.timeoutMs });
    const actor: WorkerActor = {
      kind: "conversation", conversationId: giver.id, sender: "giver", invocationId: "ask",
      policyNames: ["trusted"], policy: { use: true, scope: "all", redirect: false },
      workerPermissions: [{ default: level }], isOwner: options.owner,
    };
    const events: ConversationPermissionEvent[] = [];
    const requested = Promise.withResolvers<Extract<ConversationPermissionEvent, { kind: "permission_requested" }>>();
    giver.subscribe(({ event }) => {
      if (event.kind === "permission_requested") { events.push(event); requested.resolve(event); }
      if (event.kind === "permission_resolved") events.push(event);
    });
    const idle = Promise.withResolvers<void>();
    agent.events.subscribeWorkers(({ event }) => { if (event.kind === "worker_idle") idle.resolve(); });
    async function outcome() {
      await idle.promise;
      const worker = await agent.workers!.check("w1");
      const { messages } = await agent.persistence.messages.list(worker.conversationId);
      const response = messages.findLast(message => message.role === "assistant");
      return JSON.parse(contentText(response?.content));
    }
    return { agent, giver, actor, events, requested: requested.promise, outcome, async close() {
      try { await agent.close(); }
      finally { await rm(root, { recursive: true, force: true }); }
    } };
  } catch (error) {
    await agent.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

for (const level of ["allow", "deny"] as const) {
  test(`worker ${level} resolves on ACP without involving the giver`, async () => {
    const testRig = await rig(level, { answers: true });
    try {
      await testRig.agent.orchestrator!.open(testRig.actor, { text: "reject-first" });
      expect(await testRig.outcome()).toEqual({ outcome: "selected", optionId: level === "allow" ? "allow" : "reject" });
      expect(testRig.events).toEqual([]);
    } finally { await testRig.close(); }
  }, 15_000);
}

test("a worker ask surfaces on the giving conversation and uses its public answer method", async () => {
  const { agent, giver, actor, events, requested, outcome, close } = await rig("ask", { answers: true });
  try {
    await agent.orchestrator!.open(actor, { text: "reject-first" });
    const request = await requested;
    const worker = await agent.workers!.check("w1");
    expect(request).toMatchObject({ source: { kind: "worker", handle: "w1", conversationId: worker.conversationId },
      expiresAt: expect.any(Number) });
    expect(request.turnId).toBeUndefined();
    expect(giver.isBusy).toBe(false);
    expect(await giver.answerPermission(request.id, "allow")).toEqual({ accepted: true });
    expect(await outcome()).toEqual({ outcome: "selected", optionId: "allow" });
    expect(await giver.answerPermission(request.id, "allow")).toEqual({ accepted: false });
    expect(events).toEqual([request, { kind: "permission_resolved", id: request.id, by: "consumer", outcome: "approved" }]);
  } finally { await close(); }
}, 15_000);

for (const answers of [true, false]) {
  test(`a worker ask is refused on ${answers ? "consumer timeout" : "a headless giver"}`, async () => {
    const { agent, actor, events, requested, outcome, close } = await rig("ask", { answers, timeoutMs: 35 });
    try {
      await agent.orchestrator!.open(actor, { text: "reject-first" });
      const request = await requested;
      expect(typeof request.expiresAt).toBe(answers ? "number" : "undefined");
      expect(await outcome()).toEqual({ outcome: "selected", optionId: "reject" });
      expect(events).toEqual([request, { kind: "permission_resolved", id: request.id, by: answers ? "timeout" : "default", outcome: "denied" }]);
    } finally { await close(); }
  }, 15_000);
}

test("stopping the giver closes its forwarded permission and the worker receives cancellation", async () => {
  const { agent, giver, actor, requested, events, outcome, close } = await rig("ask", { answers: true });
  try {
    await agent.orchestrator!.open(actor, { text: "reject-first" });
    const request = await requested;
    await giver.stop();
    expect(await outcome()).toEqual({ outcome: "cancelled" });
    expect(await giver.answerPermission(request.id, "allow")).toEqual({ accepted: false });
    expect(events).toEqual([request, { kind: "permission_resolved", id: request.id, by: "turn_ended", outcome: "cancelled" }]);
  } finally { await close(); }
}, 15_000);

for (const owner of [false, true]) {
  test(`allow_always is ${owner ? "offered to the owner" : "hidden and rejected for a non-owner"}`, async () => {
    const { agent, giver, actor, requested, outcome, close } = await rig("ask", { answers: true, owner });
    try {
      await agent.orchestrator!.open(actor, { text: "reject-first" });
      const request = await requested;
      expect(request.options.some(option => option.kind === "allow_always")).toBe(owner);
      expect(await giver.answerPermission(request.id, "always")).toEqual({ accepted: owner });
      if (!owner) expect(await giver.answerPermission(request.id, "allow")).toEqual({ accepted: true });
      expect(await outcome()).toEqual({ outcome: "selected", optionId: owner ? "always" : "allow" });
    } finally { await close(); }
  }, 15_000);
}

test("automatic worker allow falls back to allow_always when the provider offers no allow_once", async () => {
  const { agent, actor, events, outcome, close } = await rig("allow", { answers: true, owner: false });
  try {
    await agent.orchestrator!.open(actor, { text: "always-only" });
    expect(await outcome()).toEqual({ outcome: "selected", optionId: "always" });
    expect(events).toEqual([]);
  } finally { await close(); }
}, 15_000);
