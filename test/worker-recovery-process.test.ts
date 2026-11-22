import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fixture = new URL("./fixtures/worker-recovery-process.ts", import.meta.url).pathname;

for (const mode of ["produce", "partial"] as const) test(`replacement acp-client checks assignment evidence after SIGKILL (${mode})`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-worker-recovery-"));
  const launch = (mode: string, key?: string) => Bun.spawn([process.execPath, fixture, mode, dir, ...(key ? [key] : [])],
    { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const producer = launch(mode);
  try {
    const reader = producer.stdout.getReader();
    let line = "";
    try {
      while (!line.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Producer exited before committing its final record");
        line += new TextDecoder().decode(chunk.value);
      }
    } finally { reader.releaseLock(); }
    expect(JSON.parse(line.trim())).toEqual(mode === "produce" ? { finalWorkerRecordCommitted: true } : { partialWorkerOutputSeen: true });
    expect(producer.exitCode).toBeNull();
    producer.kill("SIGKILL");
    expect(await producer.exited).not.toBe(0);

    // Inspect the disk before starting the replacement. Only the worker
    // conversation holds result bytes, and the proof creates no delivery records.
    const db = new Database(join(dir, "agent.sqlite"), { readonly: true });
    try {
      const persisted = db.query<{ record_id: string; role: string; status: string; consumer_metadata_json: string | null }, []>(
        "SELECT r.record_id, m.role, m.status, m.consumer_metadata_json FROM conversation_records r " +
        "JOIN conversation_messages m ON m.record_row_id = r.row_id ORDER BY r.sequence").all();
      const assignment = persisted.filter(record => record.consumer_metadata_json !== null);
      expect(assignment).toHaveLength(1);
      expect(JSON.parse(assignment[0]!.consumer_metadata_json!)).toEqual({
        assignmentId: "assignment-42", destination: "owner-channel", policyNames: ["guest"],
      });
      const operation = assignment[0]!.record_id.replace(/:user$/, "");
      expect(persisted.some(record => record.record_id === `${operation}:assistant:1` && record.status === "completed"))
        .toBe(mode === "produce");
      expect(db.query("SELECT assignment_id FROM worker_assignments").all()).toEqual([]);
    } finally { db.close(); }

    const recover = async (id: string) => {
      const replacement = launch("recover", id);
      const output = await new Response(replacement.stdout).text();
      expect(await replacement.exited).toBe(0);
      return JSON.parse(output);
    };
    const result = await recover("assignment-42");
    expect(result).toHaveLength(1);
    if (mode === "partial") {
      expect(result[0]).toMatchObject({ provenance: { assignmentId: "assignment-42", destination: "owner-channel", policyNames: ["guest"] },
        output: [] });
      expect(result[0].outcome).not.toBe("completed");
      expect(await recover("assignment-42")).toEqual(result);
      return;
    }
    expect(result[0]).toMatchObject({
      provenance: { assignmentId: "assignment-42", destination: "owner-channel", policyNames: ["guest"] },
      outcome: "completed", output: [{ content: '{"prompt":"assignment result"}' }],
      recordKinds: ["message", "message", "metering", "message"],
    });
    expect(result[0].output[0].id).toBe(`${result[0].operationId}:assistant:1`);
    expect(await recover("other-assignment")).toEqual([]);
    expect(await recover("assignment-42")).toEqual(result);
  } finally {
    if (producer.exitCode === null && producer.signalCode === null) producer.kill("SIGKILL");
    await producer.exited;
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
