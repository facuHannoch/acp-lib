import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionCheckpoint } from "../src/persistence/checkpoint.ts";
import {
  AgentSessionRegistryCursorError,
  AgentSessionRegistryLockError,
  FileAgentSessionStore,
  MaintenanceOutcomeUnknownError,
} from "../src/persistence/file-registry-store.ts";
import {
  AgentSessionStoreConflictError,
  SessionMaintenanceInProgressError,
  internalSessionHistoryDigest,
  type AgentSessionRecord,
  type CreationMaintenance,
  type DeletionMaintenance,
} from "../src/persistence/registry.ts";

const roots: string[] = [];
const NOW = "2026-09-08T12:00:00.000Z";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("FileAgentSessionStore", () => {
  test("creates and updates records with incarnation-aware CAS", async () => {
    const store = await makeStore();
    const first = record("a", 1);
    await store.saveAgentSessionRecord(first, { expectedRecordRevision: null, expectedIncarnationId: null });
    expect((await store.getAgentSessionRecord("a"))?.recordRevision).toBe(1);
    await expect(store.saveAgentSessionRecord(record("a", 2), {
      expectedRecordRevision: 1,
      expectedIncarnationId: "wrong",
    })).rejects.toBeInstanceOf(AgentSessionStoreConflictError);
    await store.saveAgentSessionRecord(record("a", 2), {
      expectedRecordRevision: 1,
      expectedIncarnationId: "inc-a",
    });
    expect((await store.getAgentSessionRecord("a"))?.recordRevision).toBe(2);
  });

  test("two store instances do not lose independent writes", async () => {
    const root = await temporaryRoot();
    const a = new FileAgentSessionStore({ root, lockRetryMs: 1 });
    const b = new FileAgentSessionStore({ root, lockRetryMs: 1 });
    await Promise.all([
      a.saveAgentSessionRecord(record("a", 1), { expectedRecordRevision: null, expectedIncarnationId: null }),
      b.saveAgentSessionRecord(record("b", 1), { expectedRecordRevision: null, expectedIncarnationId: null }),
    ]);
    expect((await a.listAgentSessions()).sessions.map((item) => item.agentSessionId).sort()).toEqual(["a", "b"]);
  });

  test("maintenance fences ordinary writes and finalizes idempotently with a receipt", async () => {
    const store = await makeStore();
    const maintenance = creation("a");
    expect((await store.prepareMaintenance("a", maintenance, { expectedRecordRevision: null })).status).toBe("prepared");
    expect((await store.prepareMaintenance("a", maintenance, { expectedRecordRevision: null })).status).toBe("already_prepared");
    await expect(store.saveAgentSessionRecord(record("a", 1), {
      expectedRecordRevision: null,
      expectedIncarnationId: null,
    })).rejects.toBeInstanceOf(SessionMaintenanceInProgressError);

    const stagedRecord = record("a", 1);
    const continued: CreationMaintenance = {
      ...maintenance,
      details: {
        ...maintenance.details,
        stagedContinuation: {
          adapterId: stagedRecord.adapterId,
          mode: stagedRecord.mode,
          internalSessionId: stagedRecord.internalSessionId,
          internalSessionActivatedAt: stagedRecord.internalSessionActivatedAt,
          model: stagedRecord.model,
          sessionConfiguration: stagedRecord.sessionConfiguration,
          protocol: stagedRecord.protocol,
        },
      },
    };
    await expect(store.updateMaintenance("a", "inc-a", "create-a", {
      ...continued,
      details: { ...continued.details, stagedRecord },
    })).rejects.toBeInstanceOf(AgentSessionStoreConflictError);
    await store.updateMaintenance("a", "inc-a", "create-a", continued);
    const staged: CreationMaintenance = {
      ...continued,
      details: { ...continued.details, stagedRecord },
    };
    await store.updateMaintenance("a", "inc-a", "create-a", staged);
    expect((await store.getMaintenance("a") as CreationMaintenance).details.stagedRecord?.recordRevision).toBe(1);

    await store.finalizeMaintenance("a", "inc-a", "create-a", "a".repeat(64), { save: stagedRecord });
    await expect(store.finalizeMaintenance("a", "inc-a", "create-a", "a".repeat(64), { save: record("a", 1) })).resolves.toBeUndefined();
    expect((await store.prepareMaintenance("a", maintenance, { expectedRecordRevision: null })).status).toBe("already_completed");
    await expect(store.finalizeMaintenance("a", "inc-a", "unknown", "a".repeat(64), { deleteRecord: true }))
      .rejects.toBeInstanceOf(MaintenanceOutcomeUnknownError);
  });

  test("recovers visibly from the backup and preserves it during the repair mutation", async () => {
    const root = await temporaryRoot();
    const notices: number[] = [];
    const store = new FileAgentSessionStore({ root, onRecovery: (notice) => notices.push(notice.recoveredRevision) });
    await store.saveAgentSessionRecord(record("a", 1), { expectedRecordRevision: null, expectedIncarnationId: null });
    await store.saveAgentSessionRecord(record("a", 2), { expectedRecordRevision: 1, expectedIncarnationId: "inc-a" });
    await writeFile(store.path, "{broken", "utf8");
    expect((await store.getAgentSessionRecord("a"))?.recordRevision).toBe(1);
    await store.saveAgentSessionRecord(record("a", 2), { expectedRecordRevision: 1, expectedIncarnationId: "inc-a" });
    expect(JSON.parse(await readFile(store.backupPath, "utf8")).revision).toBe(1);
    expect(notices.length).toBeGreaterThanOrEqual(2);
  });

  test("pagination is deterministic and rejects a cursor after registry mutation", async () => {
    const store = await makeStore();
    await store.saveAgentSessionRecord(record("a", 1), { expectedRecordRevision: null, expectedIncarnationId: null });
    await store.saveAgentSessionRecord(record("b", 1), { expectedRecordRevision: null, expectedIncarnationId: null });
    const page = await store.listAgentSessions({ limit: 1, order: "created_asc" });
    expect(page.sessions).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    await store.saveAgentSessionRecord(record("c", 1), { expectedRecordRevision: null, expectedIncarnationId: null });
    await expect(store.listAgentSessions({ cursor: page.nextCursor!, limit: 1, order: "created_asc" }))
      .rejects.toBeInstanceOf(AgentSessionRegistryCursorError);
  });

  test("recovers only a provably dead lock and never steals a live one by age", async () => {
    const root = await temporaryRoot();
    const store = new FileAgentSessionStore({ root, lockRetryMs: 5, lockTimeoutMs: 100, now: () => NOW });
    const lockPath = `${store.path}.lock`;
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "dead", createdAt: NOW }), "utf8");
    await store.saveAgentSessionRecord(record("a", 1), { expectedRecordRevision: null, expectedIncarnationId: null });

    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "live", createdAt: "2000-01-01T00:00:00.000Z" }), "utf8");
    await expect(store.saveAgentSessionRecord(record("b", 1), { expectedRecordRevision: null, expectedIncarnationId: null }))
      .rejects.toBeInstanceOf(AgentSessionRegistryLockError);
    expect(JSON.parse(await readFile(lockPath, "utf8")).token).toBe("live");
  });

  test("a delayed hard-deletion retry cannot delete a reused logical ID", async () => {
    const store = await makeStore();
    await store.saveAgentSessionRecord(record("a", 1), { expectedRecordRevision: null, expectedIncarnationId: null });
    const deletion: DeletionMaintenance = {
      kind: "deletion",
      incarnationId: "inc-a",
      baseRecordRevision: 1,
      operationId: "delete-old-a",
      requestDigest: "d".repeat(64),
      status: "prepared",
      startedAt: NOW,
      details: { deleteTranscript: false, transcriptPath: null, deleteAuditLog: false, auditLogPath: null, removeRegistryEntry: true },
    };
    await store.prepareMaintenance("a", deletion, { expectedRecordRevision: 1 });
    await store.finalizeMaintenance("a", "inc-a", "delete-old-a", "d".repeat(64), { deleteRecord: true });
    await store.saveAgentSessionRecord(record("a", 1, "inc-new"), { expectedRecordRevision: null, expectedIncarnationId: null });

    await expect(store.finalizeMaintenance("a", "inc-a", "delete-old-a", "d".repeat(64), { deleteRecord: true })).resolves.toBeUndefined();
    expect((await store.getAgentSessionRecord("a"))?.incarnationId).toBe("inc-new");
  });
});

async function makeStore(): Promise<FileAgentSessionStore> {
  return new FileAgentSessionStore({ root: await temporaryRoot(), lockRetryMs: 1, now: () => NOW });
}
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acp-registry-")); roots.push(root); return root;
}

function record(id: string, revision: number, incarnationId = `inc-${id}`): AgentSessionRecord {
  const input = {
    agentSessionId: id,
    incarnationId,
    stateRevision: revision,
    adapterId: "opencode",
    mode: "normal" as const,
    internalSessionId: `provider-${id}`,
    internalSessionActivatedAt: NOW,
    internalSessionHistoryRevision: 0,
    internalSessionHistoryDigest: internalSessionHistoryDigest([]),
    model: "model",
    sessionConfiguration: { adapterId: "opencode", schemaDigest: null, announcedConfigIds: [], restorationTargets: [], effective: {}, omittedConfigIds: [], restorationFidelity: "exact" as const, observedAt: NOW },
    protocol: { name: "acp" as const, version: 1 },
    transcript: null,
    boundary: { status: "settled" as const, lastSettledOperationId: null },
    updatedAt: NOW,
  };
  return { agentSessionId: id, incarnationId, recordRevision: revision, checkpoint: createAgentSessionCheckpoint(input), adapterId: "opencode", mode: "normal", internalSessionId: `provider-${id}`, internalSessionActivatedAt: NOW, internalSessionHistory: [], model: "model", sessionConfiguration: input.sessionConfiguration, protocol: input.protocol, transcript: null, auditLog: null, createdAt: NOW, updatedAt: NOW, lastOpenedAt: NOW };
}

function creation(id: string): CreationMaintenance {
  return { kind: "creation", incarnationId: `inc-${id}`, baseRecordRevision: null, operationId: `create-${id}`, requestDigest: "a".repeat(64), status: "prepared", startedAt: NOW, details: { transcriptPath: null, auditLogPath: null } };
}
