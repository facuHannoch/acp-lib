import { AgentAuditRuntime, resolveAgentAuditLogConfig } from "../../src/audit/index.ts";
import type { AuditOutboxPersistence, PersistenceBackend } from "../../src/persistence/backend.ts";
import { SqliteAgentPersistence } from "../../src/persistence/sqlite-backend.ts";

const databasePath = process.argv[2];
const auditDirectory = process.argv[3];
const readyPath = process.argv[4];
if (!databasePath || !auditDirectory || !readyPath) throw new Error("expected database, audit, and ready paths");

const backend = await SqliteAgentPersistence.open({ path: databasePath });
const config = resolveAgentAuditLogConfig({
  directory: auditDirectory,
  retry: { initialDelayMs: 60_000, maxDelayMs: 60_000 },
  shutdownGraceMs: 0,
});
const state = await backend.auditOutbox.initialize("audit-crash-log", config.captureFingerprint);
const outbox = new Proxy(backend.auditOutbox, {
  get(target, property) {
    if (property === "acknowledge") {
      return async () => { throw new Error("hold at append-before-ack crash boundary"); };
    }
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as AuditOutboxPersistence;
const persistence = new Proxy(backend, {
  get(target, property, receiver) {
    if (property === "auditOutbox") return outbox;
    return Reflect.get(target, property, receiver);
  },
}) as PersistenceBackend;
const runtime = await AgentAuditRuntime.open({
  persistence,
  agentSessionId: backend.identityRecord.agentSessionId,
  config,
  auditState: state,
});
await backend.auditOutbox.enqueue({
  outboxId: "crash-outbox-1",
  sourceObservationId: "crash-source-1",
  occurredAt: "2026-09-19T00:00:00.000Z",
  kind: "agent_lifecycle",
  captureLevel: "metadata",
  captureFingerprint: config.captureFingerprint,
  payload: { state: "crash-boundary" },
  createdAt: "2026-09-19T00:00:00.000Z",
});
runtime.notifyPending();
while ((await runtime.status()).state !== "backoff") await Bun.sleep(10);
await Bun.write(readyPath, "ready");
await new Promise<void>(() => {});
