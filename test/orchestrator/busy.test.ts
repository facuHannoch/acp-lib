import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, createAgentConversationId } from "../../src/index.ts";
import { noopLogger } from "../../src/logger.ts";
import type { AssignmentPlan } from "../../src/orchestrator/assignments.ts";
import type { SendWorkerInput, WorkerActor, WorkerEvent } from "../../src/orchestrator/contracts.ts";
import { Orchestrator } from "../../src/orchestrator/orchestrator.ts";
import { WORKER_SEND_DESCRIPTION } from "../../src/orchestrator/tool-descriptions.ts";

const fixture = resolve(import.meta.dir, "../fixtures/lifecycle-agent.ts");

for (const scenario of ["continue", "redirect", "replace", "take over with new assignment"] as const) {
  test(`busy worker can ${scenario} at a real ACP tool boundary`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-busy-"));
    const boundary = join(directory, "release-tool");
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { fixture: { command: ["bun", fixture] } },
      capture: { message: "content" },
      checkpointing: { enabled: false },
      conversationDefaults: { env: { LIFECYCLE_TOOL_GATE_FILE: boundary, LIFECYCLE_END_GATE_FILE: join(directory, "hold-end") } },
    });
    const planned: Array<{ plan: AssignmentPlan; messageId: string }> = [];
    const events: WorkerEvent[] = [];
    const tool = Promise.withResolvers<void>();
    const successor = Promise.withResolvers<void>();
    agent.events.subscribe(({ event }) => {
      if (event.record.kind === "tool_call" && event.record.state === "announced") tool.resolve();
    });
    const orchestrator = new Orchestrator(agent.persistence.workers!, agent.conversations, { limit: 1 }, noopLogger,
      event => events.push(event), {
        async beforeDispatch(_row, plan, messageId) {
          planned.push({ plan, messageId });
          if (planned.length === 2) successor.resolve();
        },
      });
    const giver: WorkerActor = { kind: "conversation", conversationId: createAgentConversationId(), sender: "giver", invocationId: "first" };
    const other: WorkerActor = { kind: "conversation", conversationId: createAgentConversationId(), sender: "other", invocationId: "next" };
    try {
      expect(await orchestrator.open(giver, { text: "[lifecycle:tool]" })).toEqual({ status: "sent", handle: "w1" });
      await tool.promise;
      expect(await orchestrator.send(other, "w1", { text: "must not queue", assignment: "new" })).toMatchObject({
        status: "busy", worker: { lastConversation: giver.conversationId, sender: "giver", state: "busy" },
      });
      expect(planned).toHaveLength(1);
      const takeover = scenario === "redirect" || scenario === "take over with new assignment";
      const replace = scenario === "replace" || scenario === "take over with new assignment";
      const sender = takeover ? other : { ...giver, invocationId: "next" };
      const input: SendWorkerInput = { text: "successor", about: scenario, ...(takeover ? { redirect: true } : {}),
        ...(replace ? { assignment: "new" } : {}) };
      expect(await orchestrator.send(sender, "w1", input)).toEqual({ status: "steered" });
      await writeFile(boundary, "");
      await successor.promise;
      expect(planned.map(entry => entry.plan)).toEqual([
        { kind: "start", assignment: { id: "first", destination: giver.conversationId } },
        {
          kind: replace ? "replace" : "continue",
          previous: { id: "first", destination: giver.conversationId },
          assignment: { id: replace ? "next" : "first", destination: sender.conversationId },
        },
      ]);
      expect(new Set(planned.map(entry => entry.messageId)).size).toBe(2);
      expect(await orchestrator.check("w1")).toMatchObject({ lastConversation: sender.conversationId, about: scenario });
      expect(events.filter(event => event.kind === "worker_redirected")).toHaveLength(takeover ? 1 : 0);
    } finally {
      try { await agent.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 20_000);
}

test("worker tool guidance explains how a busy send starts a separate assignment", () => {
  expect(WORKER_SEND_DESCRIPTION).toContain('assignment to "new"');
  expect(WORKER_SEND_DESCRIPTION).toContain("interrupt that assignment");
});
