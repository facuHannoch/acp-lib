import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAgentPersistence } from "../src/persistence/sqlite-backend.ts";

for (const version of [16, 17]) test(`worker repository upgrades schema ${version} and recovers only abandoned work`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "worker-delivery-"));
  const path = join(dir, "agent.sqlite");
  let backend = await SqliteAgentPersistence.open({ path });
  try {
    await backend.close();
    const db = new Database(path);
    try {
      db.exec("DROP TABLE worker_assignments");
      db.query("DELETE FROM schema_migrations WHERE version > ?").run(version);
      db.query("INSERT OR IGNORE INTO schema_migrations VALUES (?, ?)").run(version, new Date().toISOString());
    } finally { db.close(); }
    backend = await SqliteAgentPersistence.open({ path });
    const repo = backend.workerDelivery!;
    const binding = { assignmentId: "assignment", workerConversationId: "worker", operationId: "operation",
      destination: "original", originatingPolicyNames: ["guest"], contributingPolicyNames: [] };
    await expect(SqliteAgentPersistence.open({ path })).rejects.toThrow();
    expect(await repo.reserve(binding)).toBe("reserved");
    expect(await repo.reserve(binding)).toBe("existing");
    expect(await repo.reserve({ ...binding, destination: "different" })).toBe("conflict");
    expect(await repo.stage(binding.assignmentId)).toBeUndefined();
    await expect(backend.transaction(async scope => {
      await scope.workerDelivery!.redirect(binding.assignmentId, "rollback");
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await repo.readBinding(binding.assignmentId))?.destination).toBe("original");
    expect(await repo.redirect(binding.assignmentId, "next")).toBe(true);
    expect(await repo.addContributingPolicies(binding.assignmentId, ["owner", "guest"])).toBe(true);
    await backend.close();
    backend = await SqliteAgentPersistence.open({ path });
    const reopened = backend.workerDelivery!;
    const result = await reopened.stage(binding.assignmentId);
    expect(result).toMatchObject({ outcome: { kind: "uncertain" },
      delivery: { destination: "next", source: "worker", policyNames: ["guest", "owner"], state: "pending" } });
    expect(await reopened.stage(binding.assignmentId)).toEqual(result);
    expect(await reopened.redirect(binding.assignmentId, "later")).toBe(false);
    const { id } = result!.delivery;
    expect(await reopened.transitionDelivery(id, { from: "pending", to: "blocked_policy" })).toBe(true);
    expect(await reopened.transitionDelivery(id, { from: "pending", to: "delivered" })).toBe(false);
    expect(await reopened.transitionDelivery(id, { from: "blocked_policy", to: "pending", explicitRetry: true })).toBe(true);
    expect(await reopened.transitionDelivery(id, { from: "pending", to: "delivered" })).toBe(true);
    expect(await reopened.transitionDelivery(id, { from: "pending", to: "failed_destination" })).toBe(false);
    expect((await reopened.readStaged(binding.assignmentId))?.delivery).toEqual({ ...result!.delivery, state: "delivered" });
  } finally {
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});
