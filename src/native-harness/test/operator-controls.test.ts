import { modelScenario } from "./helpers/scenario.ts";
import { expect, test } from "bun:test";
import { createInProcessHarness } from "../src/testing.ts";
import { spawnHarness } from "./helpers/stdio.ts";
import type { ChannelEvent } from "../src/contracts/events.ts";

for (const transport of ["in-process", "stdio"] as const) {
  test(`${transport}: observe pending approval and page the same live message positions`, async () => {
    const harness = transport === "stdio" ? spawnHarness() : createInProcessHarness();
    const { client } = harness;
    const events: ChannelEvent["event"][] = [];
    client.onChannelEvent(({ event }) => events.push(event));
    async function event<T extends ChannelEvent["event"]["type"]>(type: T) {
      for (let i = 0; i < 300; i++) {
        const found = events.find(event => event.type === type);
        if (found) return found as Extract<ChannelEvent["event"], { type: T }>;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Missing event ${type}`);
    }
    try {
      const init = await client.initialize({ protocolVersion: 1, host: { name: "test", version: "0" }, callbacks: [], approval: true,
        subscription: { text: "final", tools: "full" } });
      expect(init.description.capabilities.methods).not.toContain("session/load");
      expect(init.description.capabilities.methods).not.toContain("session/messages");
      const ready = await client.createSession({ sessionId: "s", participants: [], channels: {}, config: {
        version: 1, system: "test", model: { protocol: "scripted", script: new URL("./fixtures/echo-scenario.jsonl", import.meta.url).pathname },
        defaultPolicy: "ask", policies: { ask: { fallback: "ask", tools: {} } },
      } });
      expect(ready).toMatchObject({ sessionId: "s", lifecycle: "running", revision: expect.any(Number) });
      await client.push({ channel: "a", item: { id: "item", kind: "user_message", sender: "alice", content: [{ type: "text", text: "original" }] } });
      const approval = await event("approval_requested");
      const view = await client.request("channel/observe", { channel: "a" });
      expect(view).toMatchObject({ sessionLifecycle: "running", channel: { pendingCount: 0, waitingForResume: false },
        approvals: [{ requestId: approval.requestId }] });
      await client.respondApproval(approval.requestId, "allow_once");
      expect(await event("approval_closed")).toMatchObject({ requestId: approval.requestId, reason: "dispatched" });
      await event("turn_ended");
      const take = events.find(event => event.type === "turn_started");
      const completion = await event("message_completed");
      if (take?.type !== "turn_started") throw new Error("Missing take");
      const page = await client.request("channel/messages", { channel: "a" });
      expect(page.messages[0]).toMatchObject({ ...take.messages?.[0], itemId: "item", parts: [{ text: "original" }] });
      expect(take.messages?.[0]?.position).toBe(page.messages[0]?.position as string);
      expect(completion.position).toBe(page.messages.find(message => message.messageId === completion.messageId)?.position);
      await expect(client.request("channel/messages", { channel: "b", after: page.messages[0]!.position, throughRevision: view.revision }))
        .rejects.toMatchObject({ code: "invalid_params" });
      const tracked = await client.request("channel/reconcile", { channel: "a", itemIds: ["item", "unknown"], turnIds: [approval.turnId] });
      expect(tracked).toMatchObject({ unknownItemIds: ["unknown"], turns: [{ turnId: approval.turnId, state: "completed" }] });
      expect(tracked.replies.map(reply => reply.messageId)).toContain(completion.messageId!);
      expect((await client.request("channel/observe", { channel: "a" })).approvals).toEqual([]);
    } finally { await harness.close(); }
  });
}

test("focused startup and observation do not request a full storage snapshot", async () => {
  const { createMemoryStorageAdapter } = await import("../src/state/storage/memory.ts");
  const { createSession } = await import("../src/index.ts");
  const { createProtocolServer } = await import("../src/interfaces/protocol/server.ts");
  const { HarnessClient, createInProcessTransport } = await import("../src/client.ts");
  const storage = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "s", compatibilityKey: "" } });
  if (!storage.ok) throw new Error(storage.error.message);
  const owner = storage.value;
  const accepted = owner.acceptItem({ kind: "participant_message", channelId: "a", senderId: "u", itemId: "i", text: "test" });
  if (!accepted.ok) throw new Error(accepted.error.message);
  const turn = owner.beginTurn("a");
  if (!turn.ok || !turn.value) throw new Error("Failed to seed turn");
  const turnId = turn.value.turn.turnId;
  const reply = owner.appendMessage(turnId, { role: "assistant", content: "old reply", calls: [] });
  const oversized = owner.appendMessage(turnId, { role: "assistant", content: "x".repeat(1024 * 1024 + 1), calls: [] });
  if (!oversized.ok) throw new Error(oversized.error.message);
  if (!reply.ok || !owner.finishTurn(turnId, { status: "completed" }).ok) throw new Error("Failed to seed reply");
  let snapshots = 0;
  owner.snapshot = () => { snapshots++; throw new Error("Unexpected full storage read"); };
  const server = createProtocolServer(async () => ({
    session: createSession({ systemPrompt: "test", storage: owner, configureTurn() { throw new Error("Unexpected inference"); } }),
    close() { owner.close(); },
  }), { durable: true });
  const client = new HarnessClient(createInProcessTransport(server));
  try {
    await client.initialize();
    expect(await client.openSession({ sessionId: "s", channelChanges: [{ channel: "a", changeId: "1", displayName: "Alice" }] }))
      .toMatchObject({ sessionId: "s", channelChanges: [{ outcome: "applied" }] });
    expect(await client.observeChannel({ channel: "a" })).toMatchObject({ channel: { displayName: "Alice", pendingCount: 0 } });
    expect(await client.reconcileChannel({ channel: "a", turnIds: [String(turnId)], itemIds: ["i"] }))
      .toMatchObject({ turns: [{ state: "completed" }], items: [{ id: "i" }], replies: [{ messageId: String(reply.value.seq) }, { messageId: String(oversized.value.seq) }] });
    const newest = await client.timeline({ limit: 1 });
    expect(newest.events).toMatchObject([{ omitted: true, messageId: String(oversized.value.seq) }]);
    const older = await client.timeline({ cursor: newest.next!, limit: 1 });
    expect(older.events).toMatchObject([{ messageId: String(reply.value.seq) }]);
    const latest = await client.channelMessages({ channel: "a", limit: 1 });
    expect(latest.messages).toMatchObject([{ reference: true, messageId: String(oversized.value.seq) }]);
    const foreignPosition = Buffer.from(JSON.stringify(["other-session", "a", reply.value.seq])).toString("base64url");
    await expect(client.channelMessages({ channel: "a", after: foreignPosition, throughRevision: oversized.revision }))
      .rejects.toMatchObject({ code: "invalid_params" });
    expect(snapshots).toBe(0);
  } finally { client.close(); server.dispose(); }
});

for (const denied of [false, true]) test(denied ? "stdio policy deny prevents notify_channel dispatch" : "stdio offers notify_channel by default and a notice wakes an unattached channel", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "operator-notice-"));
  const script = join(directory, "script.jsonl");
  writeFileSync(script, modelScenario([
    { content: null, calls: [{ id: "notice", name: "notify_channel", arguments: { channelId: "bob", text: "wake" } }] },
    { content: "done" },
  ]));
  const harness = spawnHarness();
  const events: ChannelEvent[] = [];
  harness.client.onChannelEvent(event => events.push(event));
  try {
    await harness.client.initialize();
    await harness.client.createSession({ sessionId: "notice", participants: [], channels: {}, config: {
      version: 1, system: "test", model: { protocol: "scripted", script }, defaultPolicy: denied ? "receiver" : "allow",
      policies: { allow: { fallback: "allow", tools: {} }, receiver: { fallback: "allow", tools: { notify_channel: "deny" } } },
    }, channelChanges: [{ channel: "bob", changeId: "1", policy: "receiver" }] });
    await harness.client.push({ channel: "alice", item: { id: "wake", kind: "user_message", sender: "alice", content: [{ type: "text", text: "notify Bob" }] } });
    const target = denied ? "alice" : "bob";
    for (let i = 0; i < 300 && !events.some(event => event.channel === target && event.event.type === "turn_ended"); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(events.some(event => event.channel === target && event.event.type === "turn_ended" && event.event.outcome === "completed")).toBe(true);
    const activity = (await harness.client.timeline()).events;
    if (denied) {
      expect(activity.some(event => event.kind === "channel_notice")).toBe(false);
      expect(events.some(({ event }) => event.type === "tool_call" && event.status === "started")).toBe(false);
    } else expect(activity).toContainEqual(expect.objectContaining({
      kind: "channel_notice", sourceChannel: "alice", channel: "bob", actor: { kind: "agent", id: "alice" },
    }));
  } finally { await harness.close(); rmSync(directory, { recursive: true, force: true }); }
}, 15000);
