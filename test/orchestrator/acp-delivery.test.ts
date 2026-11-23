import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, createAgentConversationId, type AgentConversationId } from "../../src/index.ts";
import { actor, assignmentId, config, peer, waitFor } from "./delivery-support.ts";

const fixture = new URL("../fixtures/orchestrator-delivery-process.ts", import.meta.url).pathname;
const deliveryId = `worker-result:${assignmentId}`;

for (const boundary of ["final", "append"] as const) {
  test(`ACP delivery recovers once after SIGKILL at the ${boundary} boundary`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "orchestrator-delivery-"));
    const path = join(directory, "agent.sqlite");
    const child = Bun.spawn([process.execPath, fixture, path, boundary], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
    const reader = child.stdout.getReader();
    const getBarrier = async () => {
      const decoder = new TextDecoder();
      let line = "";
      while (!line.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Worker process closed before its crash barrier");
        line += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(line.split("\n")[0]!) as { target: AgentConversationId; boundary: string };
    };
    try {
      const barrier = await waitFor(getBarrier(), "ACP crash barrier");
      expect(barrier.boundary).toBe(boundary);
      child.kill("SIGKILL");
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
      const db = new Database(path, { readonly: true });
      try {
        expect(db.query("SELECT delivery_state, final_record_id FROM worker_assignments WHERE assignment_id = ?").get(assignmentId))
          .toMatchObject({ delivery_state: boundary === "final" ? null : "pending", final_record_id: expect.any(String) });
        expect(db.query("SELECT count(*) AS count FROM conversation_records WHERE record_id = ?").get(deliveryId))
          .toEqual({ count: boundary === "final" ? 0 : 1 });
      } finally { db.close(); }
      for (let attempt = 0; attempt < 2; attempt++) {
        const agent = await Agent.open(config(path));
        try {
          const repo = agent.persistence.workerDelivery!;
          expect(await repo.readStaged(assignmentId)).toMatchObject({
            outcome: { kind: "result", text: "Exact worker result" },
            delivery: { id: deliveryId, state: "delivered", destination: { kind: "acp", id: barrier.target }, policyNames: ["guest"] },
          });
          const records = await agent.persistence.records.list(barrier.target);
          expect(records.records.filter(record => record.recordId === deliveryId)).toMatchObject([{
            kind: "message", role: "assistant", consumerMetadata: { kind: "worker_reply", sender: "w1" },
          }]);
          if (attempt === 1) {
            const { conversation } = await agent.conversations.open(barrier.target);
            const result = await conversation.prompt("next prompt");
            expect(result.text).toContain("Exact worker result");
            expect(result.text?.match(/Exact worker result/g)).toHaveLength(1);
          }
        } finally { await agent.close(); }
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
      reader.releaseLock();
      await rm(directory, { recursive: true, force: true });
    }
  }, 35_000);
}

for (const mode of ["blank", "fail", "deleted"] as const) {
  test(`ACP delivery handles a ${mode} outcome and keeps it in the worker summary`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "orchestrator-acp-"));
    const path = join(directory, "agent.sqlite"), target = createAgentConversationId();
    const agent = await Agent.open(config(path, peer(path, mode === "deleted" ? "final" : mode, target)));
    try {
      await agent.persistence.conversations.create({ agentSessionId: agent.id, agentConversationId: target, controllerKind: "acp" });
      if (mode === "deleted") await agent.conversations.delete(target);
      const idle = Promise.withResolvers<void>();
      agent.events.subscribeWorkers(({ event }) => { if (event.kind === "worker_idle") idle.resolve(); });
      expect(await agent.orchestrator!.open(actor(target), { text: "assignment result" })).toEqual({ status: "sent", handle: "w1" });
      await waitFor(idle.promise, "worker delivery to settle");
      const staged = (await agent.persistence.workerDelivery!.readStaged(assignmentId))!;
      if (mode === "deleted") {
        expect(staged).toMatchObject({ outcome: { kind: "result", text: "Exact worker result" }, delivery: { state: "failed_destination" } });
        expect(await agent.persistence.records.get(deliveryId)).toBeNull();
      } else {
        const reason = mode === "blank" ? "worker produced no saved result" : "worker failed";
        expect(staged).toMatchObject({ outcome: { kind: "failed", reason }, delivery: { state: "delivered" } });
        expect(await agent.persistence.records.get(deliveryId)).toMatchObject({
          kind: "message", consumerMetadata: { kind: "worker_failed", errorKind: "failed", reason, sender: "w1" },
        });
        expect(staged.delivery.text).not.toContain("fake-secret");
      }
      expect(await agent.workers!.check("w1")).toMatchObject({ latestOutcome: staged.outcome });
      expect(await agent.workers!.list()).toMatchObject([{ latestOutcome: staged.outcome }]);
    } finally {
      try { await agent.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 20_000);
}
