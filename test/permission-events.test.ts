import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { AgentSession } from "../src/agent-session.ts";
import type { ConversationPermissionEvent } from "../src/permissions/conversation.ts";

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
