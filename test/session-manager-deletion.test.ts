import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSessionDeletionError } from "../src/persistence/deletion.ts";
import { createAgentSessionCheckpoint } from "../src/persistence/checkpoint.ts";
import { DEFAULT_AUDIT_LOG_CAPTURE, DEFAULT_PERSISTENCE_LIMITS, TRANSCRIPT_PRESETS } from "../src/persistence/config.ts";
import { FileAgentSessionStore } from "../src/persistence/file-registry-store.ts";
import { AgentSessionStoreConflictError, internalSessionHistoryDigest, type AgentSessionRecord } from "../src/persistence/registry.ts";
import { SessionManager } from "../src/session-manager.ts";

const roots: string[] = [];
const CREATED = "2026-09-09T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionManager.deleteAgentSession", () => {
  test("tombstones by default while retaining independently discoverable artifacts", async () => {
    const fixture = await setup();
    await fixture.manager.deleteAgentSession("agent-1", deletion());

    expect(await fixture.manager.getAgentSessionInfo("agent-1")).toBeNull();
    expect(await readFile(fixture.transcriptPath, "utf8")).toBe("transcript\n");
    expect(await readFile(fixture.auditPath, "utf8")).toBe("audit\n");
    expect(await fixture.manager.getSessionMaintenance("agent-1")).toBeNull();
    expect(await fixture.manager.getAgentSessionInfo("agent-1", { includeDeleted: true })).toMatchObject({
      lifecycle: "deleted",
      recordRevision: 2,
      transcriptAvailable: true,
      auditLogAvailable: true,
    });
  });

  test("deletes selected artifacts and resumes after finalization failure", async () => {
    const fixture = await setup();
    const finalize = fixture.store.finalizeMaintenance.bind(fixture.store);
    let fail = true;
    fixture.store.finalizeMaintenance = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error("simulated registry finalization failure");
      }
      return await finalize(...args);
    };

    const options = deletion({ deleteTranscript: true });
    await expect(fixture.manager.deleteAgentSession("agent-1", options)).rejects.toThrow(
      "simulated registry finalization failure",
    );
    expect(await exists(fixture.transcriptPath)).toBe(false);
    expect(await exists(fixture.auditPath)).toBe(true);
    expect((await fixture.manager.getSessionMaintenance("agent-1"))?.kind).toBe("deletion");

    await fixture.manager.deleteAgentSession("agent-1", options);
    expect(await fixture.manager.getSessionMaintenance("agent-1")).toBeNull();
    expect(await fixture.manager.getAgentSessionInfo("agent-1", { includeDeleted: true })).toMatchObject({
      transcriptAvailable: false,
      auditLogAvailable: true,
    });
  });

  test("hard removal requires every retained artifact and has an idempotent lost-return retry", async () => {
    const fixture = await setup();
    await expect(fixture.manager.deleteAgentSession("agent-1", deletion({
      deleteTranscript: true,
      removeRegistryEntry: true,
    }))).rejects.toBeInstanceOf(AgentSessionDeletionError);
    expect(await exists(fixture.transcriptPath)).toBe(true);

    const options = deletion({
      deleteTranscript: true,
      deleteAuditLog: true,
      removeRegistryEntry: true,
    });
    await fixture.manager.deleteAgentSession("agent-1", options);
    expect(await fixture.manager.getAgentSessionInfo("agent-1", { includeDeleted: true })).toBeNull();
    expect(await exists(fixture.transcriptPath)).toBe(false);
    expect(await exists(fixture.auditPath)).toBe(false);
    await expect(fixture.manager.deleteAgentSession("agent-1", options)).resolves.toBeUndefined();
  });

  test("incarnation and revision mismatches fail before deleting anything", async () => {
    const fixture = await setup();
    await expect(fixture.manager.deleteAgentSession("agent-1", {
      ...deletion({ deleteTranscript: true }),
      expectedIncarnationId: "another-incarnation",
    })).rejects.toBeInstanceOf(AgentSessionStoreConflictError);
    expect(await exists(fixture.transcriptPath)).toBe(true);
    expect(await fixture.manager.getSessionMaintenance("agent-1")).toBeNull();
  });
});

function deletion(
  overrides: Partial<Parameters<SessionManager["deleteAgentSession"]>[1]> = {},
): Parameters<SessionManager["deleteAgentSession"]>[1] {
  return {
    deletionId: "delete-agent-1",
    expectedIncarnationId: "inc-1",
    expectedRecordRevision: 1,
    ...overrides,
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "acp-managed-deletion-"));
  roots.push(root);
  const transcriptPath = join(root, "transcripts", "agent-1.jsonl");
  const auditPath = join(root, "audit", "agent-1.jsonl");
  await mkdir(join(root, "transcripts"), { recursive: true });
  await mkdir(join(root, "audit"), { recursive: true });
  await writeFile(transcriptPath, "transcript\n");
  await writeFile(auditPath, "audit\n");

  const store = new FileAgentSessionStore({ root });
  const manager = await SessionManager.open({ root, store });
  await store.saveAgentSessionRecord(record(transcriptPath, auditPath), {
    expectedRecordRevision: null,
    expectedIncarnationId: null,
  });
  return { root, transcriptPath, auditPath, store, manager };
}

function record(transcriptPath: string, auditPath: string): AgentSessionRecord {
  const sessionConfiguration = {
    adapterId: "opencode",
    schemaDigest: null,
    announcedConfigIds: [],
    restorationTargets: [],
    effective: {},
    omittedConfigIds: [],
    restorationFidelity: "exact" as const,
    observedAt: CREATED,
  };
  const checkpoint = createAgentSessionCheckpoint({
    agentSessionId: "agent-1",
    incarnationId: "inc-1",
    stateRevision: 1,
    adapterId: "opencode",
    mode: "normal",
    internalSessionId: "provider-1",
    internalSessionActivatedAt: CREATED,
    internalSessionHistoryRevision: 0,
    internalSessionHistoryDigest: internalSessionHistoryDigest([]),
    model: "model",
    sessionConfiguration,
    protocol: { name: "acp", version: 1 },
    transcript: { transcriptId: "transcript-1", generation: 1, path: transcriptPath, coveredSequence: 2 },
    boundary: { status: "settled", lastSettledOperationId: null },
    updatedAt: CREATED,
  });
  return {
    agentSessionId: "agent-1",
    incarnationId: "inc-1",
    recordRevision: 1,
    checkpoint,
    adapterId: "opencode",
    mode: "normal",
    internalSessionId: "provider-1",
    internalSessionActivatedAt: CREATED,
    internalSessionHistory: [],
    model: "model",
    sessionConfiguration,
    protocol: { name: "acp", version: 1 },
    transcript: {
      path: transcriptPath,
      transcriptId: "transcript-1",
      generation: 1,
      preset: "activity",
      effectivePolicy: TRANSCRIPT_PRESETS.activity,
      effectiveLimits: DEFAULT_PERSISTENCE_LIMITS,
      includeTruncationDigests: false,
    },
    auditLog: {
      path: auditPath,
      auditLogId: "audit-1",
      generation: 1,
      effectivePolicy: DEFAULT_AUDIT_LOG_CAPTURE,
      effectiveLimits: DEFAULT_PERSISTENCE_LIMITS,
      includeTruncationDigests: false,
    },
    createdAt: CREATED,
    updatedAt: CREATED,
    lastOpenedAt: CREATED,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
