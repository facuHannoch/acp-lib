import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/index.ts";
import type { WorkerEvent } from "../../src/orchestrator/contracts.ts";
import { actor, config, waitFor } from "./delivery-support.ts";

const lifecyclePeer = new URL("../fixtures/lifecycle-agent.ts", import.meta.url).pathname;
const allowed = ["continue", "redirect", "replace"] as const;
const refused = ["conflict", "hook_error"] as const;

for (const mode of [...allowed, ...refused]) {
  test(`a busy ACP successor ${mode} uses the durable assignment boundary`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "orchestrator-assignment-"));
    const toolGate = join(directory, "release-tool"), state = join(directory, "worker-history.json");
    const cfg = config(join(directory, "agent.sqlite"), [process.execPath, lifecyclePeer]);
    const agent = await Agent.open({ ...cfg, conversationDefaults: { env: {
      LIFECYCLE_STATE: state, LIFECYCLE_TOOL_GATE_FILE: toolGate, LIFECYCLE_END_GATE_FILE: join(directory, "hold-old-result"),
    } } });
    try {
      const original = await agent.conversations.create(), other = await agent.conversations.create();
      const originalActor = actor(original.id, "original", ["guest"]);
      const next = actor(mode === "continue" || mode === "replace" ? original.id : other.id, "next", ["owner"]);
      const tool = Promise.withResolvers<void>(), idle = Promise.withResolvers<void>();
      const events: WorkerEvent[] = [];
      agent.events.subscribe(({ event }) => {
        if (event.record.kind === "tool_call" && event.record.state === "announced") tool.resolve();
      });
      agent.events.subscribeWorkers(({ event }) => {
        events.push(event);
        if (event.kind === "worker_idle") idle.resolve();
      });
      const pool = agent.orchestrator!, repo = agent.persistence.workerDelivery!;
      expect(await pool.open(originalActor, { text: "[lifecycle:tool] old" })).toEqual({ status: "sent", handle: "w1" });
      await waitFor(tool.promise, "original worker to reach the tool barrier");
      const originalBinding = (await repo.readBinding("original"))!;
      expect(originalBinding).toMatchObject({ destination: { kind: "acp", id: original.id }, originatingPolicyNames: ["guest"] });
      if (mode === "conflict") {
        expect(await repo.reserve({ ...originalBinding, assignmentId: "next", messageId: "some-other-message" })).toBe("reserved");
      }
      if (mode === "hook_error") {
        const transaction = agent.persistence.transaction.bind(agent.persistence);
        agent.persistence.transaction = work => transaction(scope => {
          if (scope.workerDelivery) scope.workerDelivery.addContributingPolicies = async () => {
            throw new Error("private-hook-error");
          };
          return work(scope);
        });
      }
      const replace = mode === "replace" || mode === "conflict";
      expect(await pool.send(next, "w1", { text: "successor", redirect: true, ...(replace ? { assignment: "new" as const } : {}) }))
        .toEqual({ status: "steered" });
      expect(events.some(event => event.kind === "worker_redirected" || event.kind === "worker_failed")).toBe(false);
      expect((await repo.readBinding("original"))?.messageId).toBe(originalBinding.messageId);
      await writeFile(toolGate, "");
      await waitFor(idle.promise, "successor and its notices to settle");
      const failed = mode === "conflict" || mode === "hook_error";
      const old = (await repo.readStaged("original"))!;
      if (failed || replace) {
        expect(old).toMatchObject({ outcome: { kind: "interrupted", reason: "worker interrupted by steering" },
          delivery: { destination: { kind: "acp", id: original.id }, state: "delivered" } });
        expect(await agent.persistence.records.get("worker-result:original")).toMatchObject({
          agentConversationId: original.id, consumerMetadata: { kind: "worker_failed", errorKind: "interrupted" },
        });
      }
      const dispatched = Object.values(JSON.parse(await readFile(state, "utf8")) as Record<string, string[]>).flat();
      const redirected = events.filter(event => event.kind === "worker_redirected");
      if (failed) {
        expect(dispatched).toEqual(["[lifecycle:tool] old"]);
        expect(await repo.readBinding("original")).toMatchObject({ messageId: originalBinding.messageId,
          destination: { kind: "acp", id: original.id }, contributingPolicyNames: ["guest"] });
        expect(redirected).toHaveLength(0);
        expect(events.filter(event => event.kind === "worker_failed")).toMatchObject([{
          reason: "refused", cause: mode, destination: other.id,
        }]);
        const notices = (await agent.persistence.messages.list(other.id)).messages;
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ consumerMetadata: { kind: "worker_failed", reason: "refused", cause: mode, sender: "w1" } });
        expect(JSON.stringify(notices[0])).not.toContain("private-hook-error");
        expect((await agent.persistence.messages.list(original.id)).messages).toHaveLength(1);
      } else {
        expect(dispatched).toEqual(["[lifecycle:tool] old", "successor"]);
        const id = replace ? "next" : "original";
        expect(await repo.readBinding(id)).toMatchObject({
          originatingPolicyNames: replace ? ["owner"] : ["guest"],
          contributingPolicyNames: replace ? ["owner"] : ["guest", "owner"],
          destination: { kind: "acp", id: next.conversationId },
        });
        expect((await repo.readBinding(id))?.messageId).not.toBe(originalBinding.messageId);
        expect(await repo.readStaged(id)).toMatchObject({ outcome: { kind: "result", text: expect.stringContaining("successor") },
          delivery: { state: "delivered", destination: { kind: "acp", id: next.conversationId } } });
        expect(redirected).toHaveLength(mode === "redirect" ? 1 : 0);
        if (mode !== "replace") expect(await repo.readBinding("next")).toBeUndefined();
      }
    } finally {
      try { await agent.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 25_000);
}

test("a send after reopen reserves fresh work while an abandoned continuation conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-restart-"));
  const cfg = config(join(directory, "agent.sqlite"), [process.execPath, lifecyclePeer]);
  let agent = await Agent.open(cfg);
  try {
    const target = await agent.conversations.create(), worker = await agent.conversations.create({ adapterId: "worker", role: "worker" });
    await agent.persistence.workers!.create({ handle: "w1", openedBy: target.id, lastConversation: target.id,
      conversationId: worker.id, createdAt: new Date().toISOString() });
    await agent.persistence.workerDelivery!.reserve({ assignmentId: "old", workerConversationId: worker.id,
      workerHandle: "w1", messageId: "old-message", destination: { kind: "acp", id: target.id },
      originatingPolicyNames: ["guest"], contributingPolicyNames: [] });
    await agent.persistence.workerDelivery!.markSteered(worker.id, ["old-message"]);
    await agent.close();
    agent = await Agent.open(cfg);
    const repo = agent.persistence.workerDelivery!;
    expect(await repo.continueAssignment("old", "old-message", "unavailable")).toBe("conflict");
    expect(await repo.readStaged("old")).toBeUndefined();
    const idle = Promise.withResolvers<void>();
    agent.events.subscribeWorkers(({ event }) => { if (event.kind === "worker_idle") idle.resolve(); });
    expect(await agent.orchestrator!.send(actor(target.id, "fresh"), "w1", { text: "fresh work" })).toEqual({ status: "sent" });
    await waitFor(idle.promise, "new assignment after restart");
    expect(await repo.readBinding("old")).toMatchObject({ messageId: "old-message" });
    expect(await repo.readStaged("fresh")).toMatchObject({ outcome: { kind: "result", text: expect.stringContaining("fresh work") },
      delivery: { state: "delivered" } });
  } finally {
    try { await agent.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}, 20_000);
