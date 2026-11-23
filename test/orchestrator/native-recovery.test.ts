import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { AgentConversationId } from "../../src/index.ts";
import { nativeRig, reply } from "../native/support.ts";
import { assignmentId, waitFor } from "./delivery-support.ts";

const fixture = new URL("../fixtures/orchestrator-native-recovery.ts", import.meta.url).pathname;
const deliveryId = `worker-result:${assignmentId}`;

for (const boundary of ["final", "partial", "staged"] as const) {
  test(`stdio open recovers a native worker assignment after SIGKILL at ${boundary}`, async () => {
    const rig = await nativeRig({ policies: {
      open: { fallback: "allow", tools: {} }, guest: { fallback: "allow", tools: {} },
    } });
    rig.script([reply("Recovered worker notice")]);
    const child = Bun.spawn([process.execPath, fixture, rig.directory, boundary], {
      stdin: "ignore", stdout: "pipe", stderr: "inherit",
    });
    const reader = child.stdout.getReader();
    const readBarrier = async () => {
      const decoder = new TextDecoder();
      let line = "";
      while (!line.includes("\n")) {
        const item = await reader.read();
        if (item.done) throw new Error("Native recovery producer closed before its crash barrier");
        line += decoder.decode(item.value, { stream: true });
      }
      return JSON.parse(line.split("\n")[0]!) as { target: AgentConversationId; permissionId?: string };
    };
    try {
      const { target, permissionId } = await waitFor(readBarrier(), "native recovery crash barrier");
      child.kill("SIGKILL");
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
      const db = new Database(join(rig.directory, "agent.sqlite"), { readonly: true });
      try {
        expect(db.query("SELECT final_record_id, delivery_state FROM worker_assignments WHERE assignment_id = ?").get(assignmentId))
          .toMatchObject({ final_record_id: boundary === "partial" ? null : expect.any(String),
            delivery_state: boundary === "staged" ? "pending" : null });
      } finally { db.close(); }

      const agent = await rig.open({
        adapters: { main: { kind: "native" }, worker: { command: ["no-worker-redispatch-permitted"] } },
        orchestrator: { workers: { adapterId: "worker", limit: 1 } },
      });
      const host = agent.nativeHarness!;
      expect(await agent.workers!.list()).toMatchObject([{ handle: "w1", state: "offline" }]);
      const { conversation } = await agent.conversations.open(target, { runtime: { answersPermissions: true } });
      if (boundary === "partial") {
        expect(permissionId).toEqual(expect.any(String));
        expect(await conversation.answerPermission(permissionId!, "allow")).toEqual({ accepted: false });
      }
      const recovered = Promise.withResolvers<void>();
      conversation.subscribe(({ event }) => {
        if (event.kind === "turn_completed" && event.result.text === "Recovered worker notice") recovered.resolve();
      });
      await host.start();
      await host.flushWorkerDelivery();
      const repo = agent.persistence.workerDelivery!;
      const staged = await repo.readStaged(assignmentId);
      expect(staged).toMatchObject({
        outcome: boundary === "partial" ? { kind: "uncertain" } : { kind: "result", text: "Exact worker result" },
        delivery: { id: deliveryId, state: "delivered", destination: { id: target, kind: "native" } },
      });
      await waitFor(recovered.promise, "recovered native notice turn");
      await host.flushWorkerDelivery();
      expect((await host.timeline()).events.filter(entry => entry.kind === "external_notice")).toMatchObject([
        { itemId: deliveryId, channel: target, externalSource: "w1" },
      ]);
      expect(await repo.readStaged(assignmentId)).toEqual(staged);
      expect(await agent.workers!.check("w1")).toMatchObject({ state: "offline", latestOutcome: staged?.outcome });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
      reader.releaseLock();
      await rig.clean();
    }
  }, 35_000);
}
