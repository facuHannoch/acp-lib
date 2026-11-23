import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, createAgentConversationId } from "../../src/index.ts";
import { SqliteAgentPersistence } from "../../src/persistence/sqlite-backend.ts";

for (const version of [16, 18]) test(`worker rows migrate from schema ${version} and survive reopen`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-workers-"));
  const path = join(dir, "agent.sqlite");
  let backend = await SqliteAgentPersistence.open({ path });
  try {
    const conversationId = createAgentConversationId();
    const origin = createAgentConversationId();
    await backend.conversations.create({ agentSessionId: backend.identityRecord.agentSessionId, agentConversationId: conversationId });
    await backend.close();
    {
      using db = new Database(path);
      db.exec("DROP TABLE workers; ALTER TABLE conversations DROP COLUMN role");
      if (version === 16) db.exec("DROP TABLE worker_assignment_continuations; DROP TABLE worker_assignments; DROP TABLE native_channel_intents; DROP TABLE native_channel_intent_clock; ALTER TABLE conversations DROP COLUMN controller_kind");
      db.query("DELETE FROM schema_migrations WHERE version > ?").run(version);
      db.query("INSERT OR IGNORE INTO schema_migrations VALUES (?, ?)").run(version, new Date().toISOString());
    }
    backend = await SqliteAgentPersistence.open({ path });
    const worker = { handle: "w1", conversationId, openedBy: origin, createdAt: "2026-11-22T00:00:00.000Z" };
    await expect(backend.transaction(async scope => {
      await scope.workers!.create(worker);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await backend.workers.get(worker.handle)).toBeUndefined();
    await backend.workers.create(worker);
    expect(await backend.workers.update(worker.handle, { about: "task", lastConversation: origin })).toBe(true);
    await backend.close();

    backend = await SqliteAgentPersistence.open({ path });
    expect(await backend.workers.list()).toEqual([{ ...worker, about: "task", lastConversation: origin }]);
    expect(await backend.workers.drop(worker.handle, worker.createdAt)).toBe(true);
    expect(await backend.workers.update(worker.handle, { about: "late" })).toBe(false);
    expect(await backend.workers.get(worker.handle)).toMatchObject({ droppedAt: worker.createdAt, about: "task" });
    {
      using db = new Database(path, { readonly: true });
      expect(db.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 20 });
    }
    expect(backend.capabilities.workerDelivery).toBe(true);
  } finally {
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const refusal of ["workers", "workerDelivery", "capture"] as const) {
  test(`Agent refuses orchestrator without ${refusal}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-workers-refusal-"));
    const backend = await SqliteAgentPersistence.open({ path: join(dir, "agent.sqlite") });
    try {
      const capabilities = refusal === "capture" ? backend.capabilities : { ...backend.capabilities, [refusal]: false };
      const custom = new Proxy(backend, { get(target, key) {
        if (key === "capabilities") return capabilities;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      await expect(Agent.open({
        persistence: { kind: "custom", backend: custom },
        capture: { message: refusal === "capture" ? "metadata" : "content" },
        adapters: { fixture: { command: ["bun", "unused-fixture.ts"] } },
        orchestrator: { workers: { limit: 1 } },
      })).rejects.toThrow(refusal === "capture" ? 'requires message capture "content"' : refusal);
    } finally {
      await backend.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
