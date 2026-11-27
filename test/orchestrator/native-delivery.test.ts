import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createAgentConversationId } from "../../src/index.ts";
import type { ConversationPermissionEvent } from "../../src/permissions/conversation.ts";
import { nativeRig, reply, type Step } from "../native/support.ts";
import { actor, waitFor } from "./delivery-support.ts";

const workerPeer = new URL("../fixtures/lifecycle-agent.ts", import.meta.url).pathname;
const scope = { use: true, scope: "all", redirect: true } as const;
const adapters = { main: { kind: "native" }, worker: { command: [process.execPath, workerPeer] } } as const;
const workers = { adapterId: "worker", limit: 1, idleStopMs: false } as const;

test("stdio worker aliases follow policy on reopen and keep historical names", async () => {
  const rig = await nativeRig();
  const call = (name: string, id: string): Step =>
    ({ content: null, calls: [{ id, name, arguments: {} }] });
  rig.script([
    call("list_workers", "before"), reply("First list."),
    call("workers_list", "after"), reply("Second list."),
  ]);
  async function open(list: string) {
    rig.harness.config = {
      version: 1, system: "Worker list test", model: { protocol: "scripted", script: join(rig.directory, "script.jsonl") },
      defaultPolicy: "owner", policies: { owner: { fallback: "deny", tools: { [list]: "allow" } } },
    };
    return rig.open({ adapters, orchestrator: { workers, toolNames: { list }, policies: { owner: { delegation: scope } } } });
  }
  try {
    const first = await open("list_workers");
    const conversation = await first.conversations.create({ title: "Worker aliases" });
    expect((await conversation.prompt("List workers")).text).toBe("First list.");
    expect(await first.nativeHarness!.toolInvocation("1:before")).toMatchObject({ tool: "list_workers", state: "succeeded" });
    await first.close();

    const reopened = await open("workers_list");
    const restored = await reopened.conversations.open(conversation.id);
    expect((await restored.conversation.prompt("List workers again")).text).toBe("Second list.");
    const host = reopened.nativeHarness!;
    const offeredNames = (await host.tools()).map(tool => tool.name);
    expect(offeredNames).toContain("workers_list");
    expect(offeredNames).not.toContain("list_workers");
    expect(await host.toolInvocation("1:before")).toMatchObject({ tool: "list_workers", state: "succeeded" });
    expect(await host.toolInvocation("2:after")).toMatchObject({ tool: "workers_list", state: "succeeded" });
  } finally {
    await rig.clean();
  }
}, 20_000);

test("stdio delegation redirects at an ACP tool boundary, forwards the ask, and delivers one composed notice", async () => {
  const rig = await nativeRig({
    defaultPolicy: "owner",
    policies: { owner: { fallback: "allow", tools: {} }, guest: { fallback: "allow", tools: {} } },
  });
  try {
    const boundary = join(rig.directory, "worker-release");
    const agent = await rig.open({
      adapters,
      conversationDefaults: { env: { LIFECYCLE_TOOL_GATE_FILE: boundary, LIFECYCLE_END_GATE_FILE: join(rig.directory, "hold-old-end") } },
      orchestrator: { workers, policies: { owner: { delegation: scope }, guest: { delegation: scope } } },
    });
    const host = agent.nativeHarness!;
    const alice = await agent.conversations.create({ title: "Alice" });
    const bob = await agent.conversations.create({ title: "Bob", answersPermissions: true });
    const delegated = (channelId: string, id: string, args: Record<string, unknown>) =>
      ({ channelId, content: null, calls: [{ id, name: "delegate", arguments: args }] });
    const steps: Array<Step & { channelId: string }> = [
      delegated(alice.id, "delegate", { text: "[lifecycle:tool] original" }),
      { channelId: alice.id, ...reply("Delegated.") },
      delegated(bob.id, "steer", { worker: "w1", text: "[lifecycle:permission] successor", redirect: true }),
      { channelId: bob.id, ...reply("Steered.") },
      { channelId: bob.id, ...reply("Read worker reply.") },
    ];
    rig.script(steps);
    await host.changeChannel(bob.id, { policy: "guest" });

    const boundaryReached = Promise.withResolvers<void>(), workerIdle = Promise.withResolvers<void>(), delivered = Promise.withResolvers<void>();
    const permission = Promise.withResolvers<Extract<ConversationPermissionEvent, { kind: "permission_requested" }>>();
    agent.events.subscribe(({ event }) => {
      if (event.record.kind === "tool_call" && event.record.state === "announced" &&
        event.record.agentConversationId !== alice.id && event.record.agentConversationId !== bob.id) boundaryReached.resolve();
    });
    bob.subscribe(({ event }) => {
      if (event.kind === "permission_requested" && event.source?.kind === "worker") permission.resolve(event);
      if (event.kind === "turn_completed" && event.result.text === "Read worker reply.") delivered.resolve();
    });
    const events: string[] = [];
    agent.events.subscribeWorkers(({ event }) => {
      events.push(event.kind);
      if (event.kind === "worker_idle") workerIdle.resolve();
    });

    expect((await alice.promptFrom({ participantId: "alice", text: "Delegate this" })).text).toBe("Delegated.");
    await waitFor(boundaryReached.promise, "ACP worker tool barrier");
    expect((await bob.promptFrom({ participantId: "bob", text: "Redirect this" })).text).toBe("Steered.");
    expect(events).not.toContain("worker_redirected");
    await writeFile(boundary, "");
    const ask = await waitFor(permission.promise, "worker permission forwarded to Bob");
    expect(ask.source).toMatchObject({ kind: "worker", handle: "w1" });
    expect(await bob.answerPermission(ask.id, "allow")).toEqual({ accepted: true });
    await waitFor(workerIdle.promise, "native worker delivery receipt");
    await waitFor(delivered.promise, "worker notice to wake Bob's channel");
    expect(events.filter(kind => kind === "worker_redirected")).toHaveLength(1);
    const repo = agent.persistence.workerDelivery!;
    const staged = await repo.readStaged("1:delegate");
    expect(staged).toMatchObject({ outcome: { kind: "result", text: "permission=selected" },
      delivery: { id: "worker-result:1:delegate", source: "w1", state: "delivered", policyNames: ["guest", "owner"],
        destination: { kind: "native", id: bob.id } } });
    expect(await repo.redirect("1:delegate", { kind: "native", id: alice.id })).toBe(false);
    expect(await repo.readStaged("1:delegate")).toEqual(staged);
    expect((await host.timeline()).events.filter(entry => entry.kind === "external_notice")).toMatchObject([
      { channel: bob.id, itemId: "worker-result:1:delegate", externalSource: "w1" },
    ]);
    expect((await host.reconcileChannel({ channel: bob.id, itemIds: ["worker-result:1:delegate"] })).items).toMatchObject([
      { kind: "external_notice", sender: "w1", policy: { inherited: ["guest", "owner"] } },
    ]);
  } finally { await rig.clean(); }
}, 40_000);

for (const state of ["pending", "blocked_policy", "missing", "retired"] as const) {
  test(`stdio orchestrator result handles native destination ${state}`, async () => {
    const rig = await nativeRig();
    try {
      rig.script([reply("Read worker result.")]);
      const config = { adapters, orchestrator: { workers } };
      let agent = await rig.open(config);
      let host = agent.nativeHarness!;
      const target = state === "missing" ? createAgentConversationId() : (await agent.conversations.create({ title: "Target" })).id;
      await host.start();
      if (state === "pending") await host.suspendChannel(target);
      if (state === "retired") await agent.conversations.delete(target);
      const idle = Promise.withResolvers<void>();
      agent.events.subscribeWorkers(({ event }) => { if (event.kind === "worker_idle") idle.resolve(); });
      const id = `native-${state}`;
      const policyNames = state === "blocked_policy" ? ["later-policy"] : ["open"];
      expect(await agent.orchestrator!.open({ ...actor(target, id, policyNames), destinationKind: "native" }, { text: "result" }))
        .toEqual({ status: "sent", handle: "w1" });
      await waitFor(idle.promise, "native delivery scan");
      let repo = agent.persistence.workerDelivery!;
      const status = state === "missing" || state === "retired" ? "failed_destination" : state;
      const staged = await repo.readStaged(id);
      expect(staged).toMatchObject({ outcome: { kind: "result", text: expect.stringContaining("result") },
        delivery: { state: status } });
      expect(await agent.workers!.check("w1")).toMatchObject({ deliveryState: status });
      expect(await agent.workers!.list()).toMatchObject([{ deliveryState: status }]);
      expect((await host.timeline()).events.filter(entry => entry.kind === "external_notice")).toHaveLength(0);
      if (state !== "blocked_policy") await expect(agent.workers!.retryDelivery("w1")).rejects.toThrow("no policy-blocked delivery");
      if (state === "pending") {
        expect(await repo.redirect(id, { kind: "native", id: createAgentConversationId() })).toBe(false);
        expect(await repo.readStaged(id)).toEqual(staged);
        await host.resumeChannel(target);
        await host.flushWorkerDelivery();
      } else if (state === "blocked_policy") {
        await agent.close();
        rig.harness.config = { version: 1, system: "Native integration test",
          model: { protocol: "scripted", script: join(rig.directory, "script.jsonl") }, defaultPolicy: "open",
          policies: { open: { fallback: "allow", tools: {} }, "later-policy": { fallback: "allow", tools: {} } } };
        agent = await rig.open(config);
        host = agent.nativeHarness!;
        repo = agent.persistence.workerDelivery!;
        await host.start();
        await host.flushWorkerDelivery();
        expect((await repo.readStaged(id))?.delivery.state).toBe("blocked_policy");
        await agent.workers!.retryDelivery("w1");
      }
      const delivered = state === "pending" || state === "blocked_policy";
      expect((await repo.readStaged(id))?.delivery.state).toBe(delivered ? "delivered" : status);
      expect((await host.timeline()).events.filter(entry => entry.kind === "external_notice")).toHaveLength(delivered ? 1 : 0);
      const summary = { latestOutcome: staged?.outcome, deliveryState: delivered ? "delivered" : status };
      expect(await agent.workers!.check("w1")).toMatchObject(summary);
      expect(await agent.workers!.list()).toMatchObject([summary]);
      await expect(agent.workers!.retryDelivery("w1")).rejects.toThrow("no policy-blocked delivery");
    } finally { await rig.clean(); }
  }, 35_000);
}

test.each([["direct", false], ["after redirect", true]] as const)(
  "an idle native model answers an eligible worker ask without a UI responder (%s)", async (_case, redirect) => {
  const rig = await nativeRig();
  const permissionGate = join(rig.directory, "allow-worker-ask");
  const workerGate = join(rig.directory, "worker-tool-boundary");
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const { messages } = await request.json() as { messages: { role: string; content?: string }[] };
    const last = messages.at(-1);
    const text = last?.content ?? "";
    const approval = last?.role === "user" && text.includes("worker_approval")
      ? /"request":"([a-f0-9-]+)"/.exec(text)?.[1] : undefined;
    const tool = (name: string, args: object) => ({
      delta: { tool_calls: [{ index: 0, id: name, function: { name, arguments: JSON.stringify(args) } }] },
      finish_reason: "tool_calls",
    });
    const choice = approval ? tool("answer_worker", { request: approval, option: "allow_once" })
      : last?.role === "user" && text.includes("Take over read")
        ? tool("delegate", { worker: "w1", redirect: true, text: "[lifecycle:readpermission] read" })
        : last?.role === "user" && text.includes("Delegate read")
          ? tool("delegate", { text: redirect ? "[lifecycle:tool] original" : "[lifecycle:readpermission] read" })
          : { delta: { content: "Ready." }, finish_reason: "stop" };
    return new Response(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  } });
  rig.harness.config = {
    version: 1, system: "Worker model approval fixture", defaultPolicy: "owner",
    policies: { owner: { fallback: "deny", tools: { delegate: "allow", answer_worker: "allow" } } },
    model: { protocol: "openai-compatible", providerId: "fixture", baseUrl: `http://127.0.0.1:${provider.port}/v1`, model: "fixture" },
  };
  try {
    const agent = await rig.open({
      adapters,
      conversationDefaults: { env: {
        LIFECYCLE_PERMISSION_GATE_FILE: permissionGate, LIFECYCLE_TOOL_GATE_FILE: workerGate,
        LIFECYCLE_END_GATE_FILE: join(rig.directory, "hold-old-end"),
      } },
      orchestrator: { workers, workerApprovals: "model", toolNames: { answer: "answer_worker" }, policies: {
        owner: { delegation: scope, modelApproval: { rules: { "kind:read": "allow" }, shareReadPaths: ["README.md"] } },
      } },
    });
    const first = await agent.conversations.create({ title: "Alice", answersPermissions: false });
    const conversation = redirect ? await agent.conversations.create({ title: "Bob", answersPermissions: false }) : first;
    const boundary = Promise.withResolvers<void>();
    agent.events.subscribe(({ event }) => {
      if (event.record.kind === "tool_call" && event.record.state === "announced" &&
        event.record.agentConversationId !== first.id && event.record.agentConversationId !== conversation.id) boundary.resolve();
    });
    const accepted = Promise.withResolvers<void>(), idle = Promise.withResolvers<void>();
    conversation.subscribe(({ event }) => {
      if (event.kind === "permission_resolved" && event.by === "delegator" && event.outcome === "approved") accepted.resolve();
    });
    agent.events.subscribeWorkers(({ event }) => { if (event.kind === "worker_idle") idle.resolve(); });
    expect((await first.prompt("Delegate read")).text).toContain("Ready.");
    if (redirect) {
      await waitFor(boundary.promise, "worker's original tool boundary");
      expect((await conversation.prompt("Take over read")).text).toContain("Ready.");
      await writeFile(workerGate, "");
    }
    await writeFile(permissionGate, "");
    await waitFor(accepted.promise, "approval answered by the model");
    await waitFor(idle.promise, "worker completed after approval");
    const staged = await agent.persistence.workerDelivery!.readStaged("1:delegate");
    expect(staged?.outcome).toMatchObject({ kind: "result", text: "permission=selected" });
    expect(staged?.delivery.destination).toEqual({ kind: "native", id: conversation.id });
  } finally {
    await rig.clean();
    await provider.stop(true);
  }
}, 20_000);
