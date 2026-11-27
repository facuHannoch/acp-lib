import { expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { AgentSession } from "../src/agent-session.ts";
import type { AgentConversationOwnerLifecycle } from "../src/agent-conversation-owner.ts";
import { createAgentConversationId } from "../src/agent-ids.ts";
import { Agent } from "../src/agent.ts";
import { noopLogger } from "../src/logger.ts";
import { acpPermissionArrivals, permissionArrival } from "../src/permissions/arrival.ts";
import { answerForwardedWorkerPermission, ConversationPermissions, readForwardedWorkerPermissions, type ConversationPermissionEvent } from "../src/permissions/conversation.ts";
import type { PermissionRequest } from "../src/types.ts";

const fixture = resolve(import.meta.dir, "fixtures/permission-agent.ts");

async function observeAcp(config: Partial<Parameters<typeof AgentSession.create>[0]> = {}) {
  const conversation = await AgentSession.create({ adapter: { command: ["bun", fixture] }, cwd: import.meta.dir, ...config });
  const events: ConversationPermissionEvent[] = [];
  const requested = Promise.withResolvers<Extract<ConversationPermissionEvent, { kind: "permission_requested" }>>();
  conversation.subscribe(({ event }) => {
    if (event.kind === "permission_requested" || event.kind === "permission_resolved") events.push(event);
    if (event.kind === "permission_requested") requested.resolve(event);
  });
  return { conversation, events, requested: requested.promise };
}

test("ACP permission events identify the turn, answer, and policy source", async () => {
  const { conversation, events } = await observeAcp({
    permissionRule: request => request.tool?.kind === "execute" ? "allow" : undefined,
  });
  try {
    const handled = conversation.prompt("reject-first", {
      onPermissionRequest: () => ({ outcome: "selected", optionId: "allow" }),
    });
    expect(JSON.parse((await handled).text).optionId).toBe("allow");
    const automatic = conversation.prompt("execute");
    expect(JSON.parse((await automatic).text).optionId).toBe("allow");
    expect(events).toEqual([
      expect.objectContaining({ kind: "permission_requested", id: expect.any(String), turnId: handled.id }),
      { kind: "permission_resolved", id: events[0]!.id, by: "handler", outcome: "approved" },
      expect.objectContaining({ kind: "permission_requested", id: expect.any(String), turnId: automatic.id,
        tool: { kind: "execute", rawInput: { command: "bun test" } } }),
      { kind: "permission_resolved", id: events[2]!.id, by: "default", outcome: "approved" },
    ]);
    expect(events[0]!.id).not.toBe(events[2]!.id);
  } finally {
    await conversation.stop();
  }
}, 10_000);

for (const stop of ["forceStop", "stop", "provider turn ends"] as const) {
  test(`ACP closes the pending permission once when ${stop}`, async () => {
    const { conversation, events, requested } = await observeAcp();
    const handled = Promise.withResolvers<void>();
    const late = Promise.withResolvers<{ outcome: "selected"; optionId: string }>();
    try {
      const result = conversation.prompt(stop === "provider turn ends" ? "end-while-asking" : "reject-first", {
        onPermissionRequest: () => { handled.resolve(); return late.promise; },
      }).then(() => undefined, () => undefined);
      const request = await requested;
      if (stop !== "provider turn ends") {
        await handled.promise;
        if (stop === "forceStop") await conversation.connection.forceStop();
        else await conversation.stop();
      }
      await result;
      late.resolve({ outcome: "selected", optionId: "allow" });
      expect(events).toEqual([
        request, { kind: "permission_resolved", id: request.id, by: "turn_ended", outcome: "cancelled" },
      ]);
    } finally {
      await conversation.stop();
    }
  }, 10_000);
}

test("an invalid runtime permissionRule result fails closed and closes its ACP event", async () => {
  const { conversation, events } = await observeAcp({
    permissionRule: () => "alow" as "allow",
  });
  try {
    expect(JSON.parse((await conversation.prompt("reject-first")).text)).toEqual({ outcome: "selected", optionId: "reject" });
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ kind: "permission_resolved", id: events[0]!.id, by: "default", outcome: "denied" });
  } finally {
    await conversation.stop();
  }
}, 10_000);

test("an ACP event listener can claim one offered answer while the turn is waiting", async () => {
  const { conversation, events, requested } = await observeAcp({ answersPermissions: true });
  const answers = Promise.withResolvers<Array<{ accepted: boolean }>>();
  try {
    conversation.subscribe(({ event }) => {
      if (event.kind !== "permission_requested") return;
      answers.resolve(Promise.all([
        conversation.answerPermission(event.id, "missing"),
        conversation.answerPermission(event.id, "allow"),
        conversation.answerPermission(event.id, "reject"),
      ]));
    });
    const result = conversation.prompt("reject-first");
    const request = await requested;
    expect(request.expiresAt).toBeGreaterThan(Date.now() + 290_000);
    expect(await answers.promise).toEqual([{ accepted: false }, { accepted: true }, { accepted: false }]);
    expect(JSON.parse((await result).text)).toEqual({ outcome: "selected", optionId: "allow" });
    expect(await conversation.answerPermission(request.id, "allow")).toEqual({ accepted: false });
    expect(events).toEqual([request, { kind: "permission_resolved", id: request.id, by: "consumer", outcome: "approved" }]);
  } finally {
    await conversation.stop();
  }
}, 10_000);

test("an ACP consumer timeout refuses and rejects later answers", async () => {
  const { conversation, events, requested } = await observeAcp({ answersPermissions: true, permissionTimeoutMs: 50 });
  try {
    const result = conversation.prompt("reject-first");
    const request = await requested;
    expect(typeof request.expiresAt).toBe("number");
    expect(JSON.parse((await result).text)).toEqual({ outcome: "selected", optionId: "reject" });
    expect(await conversation.answerPermission(request.id, "allow")).toEqual({ accepted: false });
    expect(events).toEqual([request, { kind: "permission_resolved", id: request.id, by: "timeout", outcome: "denied" }]);
  } finally {
    await conversation.stop();
  }
}, 10_000);

test("handler-owned requests expose no deadline and bypass answerPermission", async () => {
  const { conversation, events, requested } = await observeAcp({ answersPermissions: true, permissionTimeoutMs: 1 });
  const handled = Promise.withResolvers<void>();
  const decision = Promise.withResolvers<{ outcome: "selected"; optionId: string }>();
  try {
    const work = conversation.prompt("reject-first", {
      onPermissionRequest: () => { handled.resolve(); return decision.promise; },
    });
    const request = await requested;
    await handled.promise;
    expect(request.expiresAt).toBeUndefined();
    expect(await conversation.answerPermission(request.id, "reject")).toEqual({ accepted: false });
    decision.resolve({ outcome: "selected", optionId: "allow" });
    expect(JSON.parse((await work).text).optionId).toBe("allow");
    expect(events[1]).toEqual({ kind: "permission_resolved", id: request.id, by: "handler", outcome: "approved" });
  } finally {
    await conversation.stop();
  }
}, 10_000);

test("an unattended ACP ask is refused even when default is allow", async () => {
  const { conversation, events, requested } = await observeAcp({
    permissions: { default: "allow", rules: { "kind:execute": "ask" } },
  });
  try {
    const result = conversation.prompt("execute");
    const request = await requested;
    expect(request.expiresAt).toBeUndefined();
    expect(JSON.parse((await result).text).optionId).toBe("reject");
    expect(events[1]).toEqual({ kind: "permission_resolved", id: request.id, by: "default", outcome: "denied" });
  } finally {
    await conversation.stop();
  }
}, 10_000);

test("an already-expired request keeps its ingress deadline when delivered late", async () => {
  const events: ConversationPermissionEvent[] = [];
  const coordinator = new ConversationPermissions(event => {
    if (event.kind === "permission_requested" || event.kind === "permission_resolved") events.push(event);
  }, () => noopLogger);
  const request: PermissionRequest = {
    toolCallId: "held", options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ], raw: {},
  };
  const arrival = permissionArrival();
  acpPermissionArrivals.set(request, { wallTime: arrival.wallTime - 5_000, monotonicTime: arrival.monotonicTime - 5_000 });
  const record = Promise.withResolvers<void>();
  const resolved = coordinator.request("held-turn", request,
    { answersPermissions: true, permissionTimeoutMs: 1_000 }, undefined, undefined, () => record.promise);
  expect(events[0]).toMatchObject({ kind: "permission_requested", expiresAt: arrival.wallTime - 4_000 });
  expect(await coordinator.answer(events[0]!.id, "allow")).toEqual({ accepted: false });
  expect(await resolved).toMatchObject({ by: "timeout", outcome: { outcome: "selected", optionId: "deny" } });
  record.resolve();
});

test("Agent conversation permission options inherit and explicit false disables the wait", async () => {
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path: ":memory:" },
    adapters: { permission: { command: ["bun", fixture] } },
    conversationDefaults: { answersPermissions: true, permissionTimeoutMs: 1_000 },
  });
  try {
    await expect(agent.conversations.create({ runtime: { permissionTimeoutMs: 0 } })).rejects.toThrow("permissionTimeoutMs");
    expect((await agent.conversations.list()).conversations).toHaveLength(0);
    const conversation = await agent.conversations.create({ answersPermissions: false });
    const notices: ConversationPermissionEvent[] = [];
    conversation.subscribe(({ event }) => {
      if (event.kind === "permission_requested" || event.kind === "permission_resolved") notices.push(event);
    });
    expect(JSON.parse((await conversation.prompt("reject-first")).text).optionId).toBe("reject");
    expect(notices[0]).toMatchObject({ kind: "permission_requested" });
    expect(notices[0]).not.toHaveProperty("expiresAt");
    expect(notices[1]).toMatchObject({ kind: "permission_resolved", by: "default" });
  } finally {
    await agent.close();
  }
}, 10_000);

test("a consumer expiry reaches the ACP agent while requested-record persistence is held", async () => {
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path: ":memory:" },
    adapters: { permission: { command: ["bun", fixture] } },
    capture: { permission: "content" },
  });
  const release = Promise.withResolvers<void>();
  try {
    const conversation = await agent.conversations.create({ answersPermissions: true, permissionTimeoutMs: 50 });
    const lifecycle = (conversation as unknown as { ownerLifecycle: AgentConversationOwnerLifecycle }).ownerLifecycle;
    const record = lifecycle.record!.bind(lifecycle);
    const writingRequested = Promise.withResolvers<void>();
    spyOn(lifecycle, "record").mockImplementation(async (entry, parts) => {
      if (entry.kind === "permission" && entry.state === "requested") {
        writingRequested.resolve();
        await release.promise;
      }
      await record(entry, parts);
    });
    const response = Promise.withResolvers<string>();
    const work = conversation.prompt("reject-first", { onChunk: chunk => response.resolve(chunk) });
    await writingRequested.promise;
    expect(JSON.parse(await response.promise)).toEqual({ outcome: "selected", optionId: "reject" });
    release.resolve();
    await work;
    const { records } = await agent.persistence.records.list(conversation.id, { kinds: ["permission"] });
    expect(records).toEqual([
      expect.objectContaining({ kind: "permission", state: "requested" }),
      expect.objectContaining({ kind: "permission", state: "resolved", outcome: "denied" }),
    ]);
  } finally {
    release.resolve();
    await agent.close();
  }
}, 10_000);

test("an unanswered ACP ask can be cancelled by the conversation setting", async () => {
  const { conversation, events } = await observeAcp({ permissions: { default: "ask", unanswered: "cancel" } });
  try {
    const result = await conversation.prompt("reject-first");
    expect(JSON.parse(result.text)).toEqual({ outcome: "cancelled" });
    expect(events[1]).toEqual({ kind: "permission_resolved", id: events[0]!.id, by: "default", outcome: "cancelled" });
    expect(await conversation.prompt("stop-on-cancel")).toMatchObject({ status: "cancelled", text: "" });
  } finally {
    await conversation.stop();
  }
}, 10_000);

for (const first of ["consumer", "delegator"] as const) {
  test(`worker approval is claimed once when ${first} answers first`, async () => {
    const giving = {}, other = {};
    const policy = () => ({ answersPermissions: true });
    const coordinator = new ConversationPermissions(() => {}, () => noopLogger, giving, policy);
    new ConversationPermissions(() => {}, () => noopLogger, other, policy);
    const source = { kind: "worker", handle: "w1", conversationId: createAgentConversationId() } as const;
    const action = { kind: "read", details: { path: "private-file.ts" } };
    const delivered = Promise.withResolvers<string>();
    const request: PermissionRequest = {
      toolCallId: "read", options: [
        { optionId: "safe", name: "Allow", kind: "allow_once" },
        { optionId: "persistent", name: "Always allow", kind: "allow_always" },
      ], raw: {},
    };
    const resolved = coordinator.request(undefined, request, { answersPermissions: true }, undefined, undefined,
      undefined, source, { mode: "both", action, authorize: policies => policies.includes("owner"),
        async deliver(id) { delivered.resolve(id); return true; } });
    const id = await delivered.promise;
    expect(readForwardedWorkerPermissions(giving, ["owner"])).toMatchObject([
      { request: id, worker: "w1", action, choices: ["allow_once"] },
    ]);
    expect(readForwardedWorkerPermissions(giving, ["guest"])).toEqual([]);
    expect(readForwardedWorkerPermissions(other, ["owner"])).toEqual([]);
    expect(await answerForwardedWorkerPermission(other, id, "allow_once", ["owner"])).toBe(false);
    expect(await coordinator.answerAsModel(id, "persistent", ["owner"])).toBe(false);
    expect(await coordinator.answerAsModel(id, "allow_once", ["guest"])).toBe(false);
    const consumer = () => coordinator.answer(id, "safe").then(result => result.accepted);
    const model = () => coordinator.answerAsModel(id, "allow_once", ["owner"]);
    expect(await Promise.all(first === "consumer" ? [consumer(), model()] : [model(), consumer()])).toEqual([true, false]);
    expect(await resolved).toMatchObject({ by: first, outcome: { outcome: "selected", optionId: "safe" } });
    expect(readForwardedWorkerPermissions(giving, ["owner"])).toEqual([]);
  });
}

test("failed model notice falls back only to an enabled consumer", async () => {
  for (const answersPermissions of [true, false]) {
    let id: string | undefined;
    const delivered = Promise.withResolvers<void>();
    const coordinator = new ConversationPermissions(event => {
      if (event.kind === "permission_requested") id = event.id;
    }, () => noopLogger);
    const request: PermissionRequest = {
      toolCallId: "read", options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ], raw: {},
    };
    const result = coordinator.request(undefined, request, { answersPermissions }, undefined, undefined,
      undefined, undefined, { mode: "both", action: { kind: "read", details: { path: "README.md" } }, authorize: () => true,
        async deliver() { delivered.resolve(); return false; } });
    await delivered.promise;
    if (answersPermissions) {
      expect(await coordinator.answer(id!, "allow")).toEqual({ accepted: true });
      expect(await result).toMatchObject({ by: "consumer", outcome: { optionId: "allow" } });
    } else {
      expect(id).toBeUndefined();
      expect(await result).toMatchObject({ by: "default", outcome: { optionId: "deny" } });
    }
  }
});
