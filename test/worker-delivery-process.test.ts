import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAgentPersistence } from "../src/persistence/sqlite-backend.ts";

const fixture = new URL("./fixtures/worker-delivery-process.ts", import.meta.url).pathname;
const assignmentId = "assignment-42";

for (const mode of ["final", "partial"] as const) test(`production worker delivery recovers after ${mode} SIGKILL`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-delivery-process-"));
  const path = join(directory, "agent.sqlite");
  const launch = (mode: string, id = assignmentId) => Bun.spawn(
    [process.execPath, fixture, path, mode, id], { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
  );
  const producer = launch(mode);
  const reader = producer.stdout.getReader();
  const deadline = setTimeout(() => producer.kill("SIGKILL"), 10_000);
  try {
    const decoder = new TextDecoder();
    let line = "";
    while (!line.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Worker process exited before its crash barrier");
      line += decoder.decode(chunk.value, { stream: true });
    }
    expect(JSON.parse(line.split("\n")[0]!)).toEqual(mode === "final" ? { finalized: true } : { partial: true });
    producer.kill("SIGKILL");
    await producer.exited;
    expect(producer.signalCode).toBe("SIGKILL");
    const disk = new Database(path, { readonly: true });
    try {
      expect(disk.query(`SELECT a.assignment_id, a.destination, a.originating_policies, m.search_text AS final_text,
        a.staged_json, a.delivery_id, r.record_id FROM worker_assignments a
        LEFT JOIN conversation_records r ON a.worker_id = r.agent_conversation_id
          AND a.operation_id = r.operation_id AND a.final_record_id = r.record_id
        LEFT JOIN conversation_messages m ON m.record_row_id = r.row_id`).get())
        .toEqual({ assignment_id: assignmentId, destination: "owner-channel", originating_policies: '["guest"]',
          final_text: mode === "final" ? "Exact worker result" : null, staged_json: null, delivery_id: null,
          record_id: mode === "final" ? expect.stringMatching(/:assistant:1$/) : null });
    } finally { disk.close(); }

    async function recover(id = assignmentId) {
      const replacement = launch("recover", id);
      try {
        const response = await new Response(replacement.stdout).text();
        expect(await replacement.exited).toBe(0);
        return JSON.parse(response);
      } finally {
        if (replacement.exitCode === null && replacement.signalCode === null) replacement.kill("SIGKILL");
        await replacement.exited;
      }
    }
    const recovered = await recover();
    expect(recovered).toMatchObject({ binding: { assignmentId, destination: "owner-channel", originatingPolicyNames: ["guest"] },
      staged: { assignmentId, outcome: { kind: mode === "final" ? "result" : "uncertain" },
        delivery: { id: `worker-result:${assignmentId}`, destination: "owner-channel", policyNames: ["guest"], state: "pending" } } });
    expect(recovered.staged.delivery.source).toBe(recovered.binding.workerConversationId);
    if (mode === "final") expect(recovered.staged.outcome.text).toBe("Exact worker result");
    else expect(recovered.staged.delivery.text).toContain(assignmentId);
    expect(await recover()).toEqual(recovered);
    expect(await recover("other-assignment")).toEqual({});
    const backend = await SqliteAgentPersistence.open({ path });
    try {
      const repository = backend.workerDelivery!;
      if (mode === "partial") {
        await backend.transaction(async scope => {
          await scope.records.appendMany([{
            recordId: "late-assistant", kind: "message", role: "assistant", status: "completed",
            agentSessionId: backend.identityRecord.agentSessionId,
            agentConversationId: recovered.binding.workerConversationId,
            operationId: "late-operation",
            timestamp: new Date().toISOString(), content: "Late output",
          }]);
          await scope.workerDelivery!.recordFinal(
            recovered.binding.workerConversationId, "late-operation", [recovered.binding.messageId],
          );
        });
        expect(await repository.readStaged(assignmentId)).toEqual(recovered.staged);
      }
      if (mode === "final") {
        const workerConversationId = recovered.binding.workerConversationId;
        const operationId = "folded-operation";
        for (const name of ["guest", "owner", "unrelated"]) {
          expect(await repository.reserve({
            assignmentId: name, workerConversationId, messageId: `${name}-message`,
            destination: `${name}-channel`, originatingPolicyNames: [name], contributingPolicyNames: [],
          })).toBe("reserved");
        }
        await backend.transaction(async scope => {
          await scope.records.append({
            recordId: "folded-assistant", kind: "message", role: "assistant", status: "completed",
            agentSessionId: backend.identityRecord.agentSessionId, agentConversationId: workerConversationId,
            operationId, timestamp: new Date().toISOString(), content: "Shared folded result",
          });
          await scope.workerDelivery!.recordFinal(workerConversationId, operationId, ["guest-message", "owner-message"]);
        });
        await repository.recordFailure(workerConversationId, operationId, ["owner-message"],
          { kind: "failed", reason: "worker failed", possiblePartialEffects: true });
        for (const name of ["guest", "owner"]) {
          expect(await repository.stage(name)).toMatchObject({
            outcome: { kind: "result", finalRecordId: "folded-assistant", text: "Shared folded result" },
            delivery: { id: `worker-result:${name}`, destination: `${name}-channel`, policyNames: ["guest", "owner"] },
          });
        }
        expect(await repository.stage("unrelated")).toBeUndefined();
      }
      expect(await repository.transitionDelivery(recovered.staged.delivery.id, { from: "pending", to: "delivered" })).toBe(true);
      expect((await repository.stage(assignmentId))?.delivery).toEqual({ ...recovered.staged.delivery, state: "delivered" });
    } finally { await backend.close(); }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
    if (producer.exitCode === null && producer.signalCode === null) producer.kill("SIGKILL");
    await producer.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

for (const mode of ["fail", "interrupt"] as const) test(`live ACP ${mode} stages a safe notice before closing the owner`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-delivery-failed-"));
  const child = Bun.spawn([process.execPath, fixture, join(directory, "agent.sqlite"), mode, assignmentId],
    { stdout: "pipe", stderr: "inherit" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output).not.toContain("fake-secret");
    const { staged, repeated } = JSON.parse(output);
    expect(staged).toMatchObject({
      outcome: { kind: mode === "fail" ? "failed" : "interrupted",
        reason: mode === "fail" ? "worker failed" : "worker interrupted by request", possiblePartialEffects: true },
      delivery: { id: `worker-result:${assignmentId}`, state: "pending", policyNames: ["guest"] },
    });
    expect(repeated).toEqual(staged);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
