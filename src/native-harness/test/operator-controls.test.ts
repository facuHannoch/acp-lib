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
      await expect(client.loadSession({ sessionId: "s" })).rejects.toMatchObject({ code: "method_not_found" });
      const ready = await client.createSession({ sessionId: "s", participants: [], channels: {}, config: {
        version: 1, system: "test", model: { protocol: "scripted", script: new URL("./fixtures/echo-scenario.json", import.meta.url).pathname },
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
