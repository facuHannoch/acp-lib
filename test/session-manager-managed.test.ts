import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, SessionManagerModeError } from "../src/session-manager.ts";
import { FileAgentSessionStore } from "../src/persistence/file-registry-store.ts";
import { createAgentSessionCheckpoint } from "../src/persistence/checkpoint.ts";
import { internalSessionHistoryDigest, type AgentSessionRecord, type DeletionMaintenance } from "../src/persistence/registry.ts";
import type { SessionRecord, SessionStore } from "../src/session-store.ts";

const NOW = "2026-09-08T12:00:00.000Z";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("managed SessionManager", () => {
  test("opens over the strict registry and exposes metadata without retaining live sessions", async () => {
    const root = await temporaryRoot();
    const store = new FileAgentSessionStore({ root, now: () => NOW });
    const manager = await SessionManager.open({ root, store });
    await store.saveAgentSessionRecord(record(), { expectedRecordRevision: null, expectedIncarnationId: null });

    expect((await manager.getAgentSessionInfo("agent-1"))?.incarnationId).toBe("inc-1");
    expect((await manager.listAgentSessions()).sessions.map((item) => item.agentSessionId)).toEqual(["agent-1"]);
    expect(await manager.getSessionMaintenance("agent-1")).toBeNull();
  });

  test("manager defaults merge with per-session log choices and enforce constraints", async () => {
    const root = await temporaryRoot();
    const manager = await SessionManager.open({
      root,
      sessionDefaults: { transcript: { preset: "detailed" }, auditLog: {} },
      sessionConstraints: { auditLog: "required" },
    });
    const resolved = manager.resolveSessionPersistence({ transcript: { capture: { reasoning: "none" } } });
    expect(resolved.root).toBe(root);
    expect(resolved.transcript && resolved.transcript.preset).toBe("detailed");
    expect(resolved.transcript && resolved.transcript.capture.reasoning).toBe("none");
    expect(resolved.auditLog).not.toBe(false);
  });

  test("prepared deletion visibility and compatibility-mode errors are explicit", async () => {
    const root = await temporaryRoot();
    const store = new FileAgentSessionStore({ root, now: () => NOW });
    const manager = await SessionManager.open({ root, store });
    await store.saveAgentSessionRecord(record(), { expectedRecordRevision: null, expectedIncarnationId: null });
    const deletion: DeletionMaintenance = {
      kind: "deletion", incarnationId: "inc-1", baseRecordRevision: 1,
      operationId: "delete-1", requestDigest: "d".repeat(64), status: "prepared", startedAt: NOW,
      details: { deleteTranscript: false, transcriptPath: null, deleteAuditLog: false, auditLogPath: null, removeRegistryEntry: false },
    };
    await store.prepareMaintenance("agent-1", deletion, { expectedRecordRevision: 1 });
    expect(await manager.getAgentSessionInfo("agent-1")).toBeNull();
    expect((await manager.getAgentSessionInfo("agent-1", { includeDeleted: true }))?.lifecycle).toBe("maintenance_pending");
    expect((await manager.listSessionMaintenance()).maintenance).toHaveLength(1);

    const compatibility = new SessionManager(new EmptyLegacyStore());
    await expect(compatibility.listAgentSessions()).rejects.toBeInstanceOf(SessionManagerModeError);
  });
});

class EmptyLegacyStore implements SessionStore {
  async save(_record: SessionRecord): Promise<void> {}
  async get(_id: string): Promise<SessionRecord | null> { return null; }
  async list(): Promise<SessionRecord[]> { return []; }
  async delete(_id: string): Promise<void> {}
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acp-manager-")); roots.push(root); return root;
}

function record(): AgentSessionRecord {
  const sessionConfiguration = { adapterId: "opencode", schemaDigest: null, announcedConfigIds: [], restorationTargets: [], effective: {}, omittedConfigIds: [], restorationFidelity: "exact" as const, observedAt: NOW };
  const checkpoint = createAgentSessionCheckpoint({
    agentSessionId: "agent-1", incarnationId: "inc-1", stateRevision: 1, adapterId: "opencode",
    mode: "normal", internalSessionId: "provider-1", internalSessionActivatedAt: NOW,
    internalSessionHistoryRevision: 0, internalSessionHistoryDigest: internalSessionHistoryDigest([]),
    model: "model", sessionConfiguration, protocol: { name: "acp", version: 1 }, transcript: null,
    boundary: { status: "settled", lastSettledOperationId: null }, updatedAt: NOW,
  });
  return {
    agentSessionId: "agent-1", incarnationId: "inc-1", recordRevision: 1, checkpoint,
    adapterId: "opencode", mode: "normal", internalSessionId: "provider-1", internalSessionActivatedAt: NOW,
    internalSessionHistory: [], model: "model", sessionConfiguration, protocol: { name: "acp", version: 1 },
    transcript: null, auditLog: null, createdAt: NOW, updatedAt: NOW, lastOpenedAt: NOW,
  };
}
