import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MaintenanceAlreadyCompletedError, ManagedAgentSessionCreationError } from "../src/persistence/managed-creation.ts";
import { FileAgentSessionStore } from "../src/persistence/file-registry-store.ts";
import { scanTranscriptContinuation } from "../src/persistence/transcript-scanner.ts";
import { SessionManager } from "../src/session-manager.ts";
import { AuditLogReader } from "../src/persistence/audit-log-reader.ts";
import type { AgentSessionOpenStage } from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionManager.createAgentSession", () => {
  test("reports managed creation progress through durable readiness", async () => {
    const { manager } = await setup();
    const events: AgentSessionOpenStage[] = [];
    const session = await manager.createAgentSession({
      ...config(),
      onOpenProgress: (event) => events.push(event),
    });
    try {
      expect(events.map((event) => event.stage)).toEqual([
        "initializing",
        "initialized",
        "internal_session_acquired",
        "ready",
      ]);
      expect(events[1]).toMatchObject({
        stage: "initialized",
        capabilities: { agent: { loadSession: true } },
      });
      expect(events[2]).toEqual({
        stage: "internal_session_acquired",
        internalSessionId: "config-session",
        disposition: "created",
      });
      expect(events[3]).toEqual({ stage: "ready", promptability: session.promptability });
      expect(await manager.getSessionMaintenance(session.agentSessionId)).toBeNull();
    } finally {
      await session.stop();
    }
  }, 20_000);

  test("progress-listener failures do not fail managed creation", async () => {
    const { manager } = await setup();
    const session = await manager.createAgentSession({
      ...config(),
      onOpenProgress() {
        throw new Error("consumer progress failure");
      },
    });
    expect(session.internalSessionId).toBe("config-session");
    await session.stop();
  }, 20_000);

  test("creates under maintenance and publishes later transcript checkpoints to the registry", async () => {
    const { root, manager } = await setup();
    const session = await manager.createAgentSession(config());
    try {
      expect(session.agentSessionId).toBe("managed-agent");
      const initial = await manager.getAgentSessionInfo("managed-agent");
      expect(initial).toMatchObject({
        incarnationId: "managed-creation",
        recordRevision: 1,
        adapterId: "fake",
        model: "alpha",
        transcriptAvailable: true,
        lifecycle: "active",
      });
      expect(await manager.getSessionMaintenance("managed-agent")).toBeNull();
      expect(session.transcriptPath).toBe(join(root, "transcripts", "managed-agent.jsonl"));

      await session.setConfig("model", "beta");
      const updated = await manager.getAgentSessionInfo("managed-agent");
      expect(updated?.recordRevision).toBe(3);
      expect(updated?.model).toBe("beta");
    } finally {
      await session.stop();
    }
  }, 20_000);

  test("does not reserve an identity when its destination is already initialized", async () => {
    const { root, manager } = await setup();
    const path = join(root, "transcripts", "managed-agent.jsonl");
    await mkdir(join(root, "transcripts"), { recursive: true });
    await writeFile(path, "unrelated bytes\n");
    await expect(manager.createAgentSession(config())).rejects.toBeInstanceOf(
      ManagedAgentSessionCreationError,
    );
    expect(await manager.getSessionMaintenance("managed-agent")).toBeNull();
    expect(await manager.getAgentSessionInfo("managed-agent", { includeDeleted: true })).toBeNull();
  });

  test("a retry finalizes staged creation and loads its existing provider thread", async () => {
    const { manager, store } = await setup();
    const finalize = store.finalizeMaintenance.bind(store);
    let fail = true;
    store.finalizeMaintenance = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error("simulated creation finalization failure");
      }
      return await finalize(...args);
    };
    await expect(manager.createAgentSession(config())).rejects.toThrow(
      "simulated creation finalization failure",
    );
    const pending = await manager.getSessionMaintenance("managed-agent");
    expect(pending?.kind).toBe("creation");
    expect(pending?.kind === "creation" && pending.details.stagedContinuation?.internalSessionId)
      .toBe("config-session");
    expect(pending?.kind === "creation" && pending.details.stagedRecord?.recordRevision).toBe(1);

    const resumed = await manager.createAgentSession(config());
    try {
      expect(resumed.internalSessionId).toBe("config-session");
      expect(await manager.getSessionMaintenance("managed-agent")).toBeNull();
      expect((await manager.getAgentSessionInfo("managed-agent"))?.recordRevision).toBe(1);
    } finally {
      await resumed.stop();
    }

    await expect(manager.createAgentSession(config())).rejects.toBeInstanceOf(
      MaintenanceAlreadyCompletedError,
    );
  }, 20_000);

  test("a retry reuses staged continuation when record staging previously failed", async () => {
    const { manager, store } = await setup();
    const update = store.updateMaintenance.bind(store);
    let calls = 0;
    store.updateMaintenance = async (...args) => {
      calls++;
      if (calls === 2) throw new Error("simulated staged-record failure");
      return await update(...args);
    };
    await expect(manager.createAgentSession(config())).rejects.toThrow("simulated staged-record failure");
    const pending = await manager.getSessionMaintenance("managed-agent");
    expect(pending?.kind === "creation" && pending.details.stagedContinuation?.internalSessionId)
      .toBe("config-session");
    expect(pending?.kind === "creation" && pending.details.stagedRecord).toBeUndefined();

    const resumed = await manager.createAgentSession(config());
    try {
      expect(resumed.internalSessionId).toBe("config-session");
      expect(await manager.getSessionMaintenance("managed-agent")).toBeNull();
      expect((await manager.getAgentSessionInfo("managed-agent"))?.lifecycle).toBe("active");
    } finally {
      await resumed.stop();
    }
  }, 20_000);

  test("creates registry-only sessions and publishes operation checkpoints", async () => {
    const { manager } = await setup();
    const session = await manager.createAgentSession({
      ...config(),
      agentSessionId: "registry-only",
      creationId: "registry-only-creation",
      persistence: { transcript: false },
    });
    try {
      expect(session.transcriptPath).toBeUndefined();
      expect(await manager.getAgentSessionInfo("registry-only")).toMatchObject({
        transcriptAvailable: false,
        recovery: "clean",
      });
      await session.setConfig("model", "beta");
      const checkpoint = await manager.getAgentSessionCheckpoint("registry-only");
      expect(checkpoint).toMatchObject({ source: "registry_projection", authoritative: true });
      expect(checkpoint?.checkpoint.model).toBe("beta");
      expect(checkpoint?.checkpoint.boundary.status).toBe("settled");
    } finally {
      await session.stop();
    }
  }, 20_000);

  test("creates an independent audit log with explicit audit projections", async () => {
    const { root, manager } = await setup();
    const session = await manager.createAgentSession({
      ...config(),
      agentSessionId: "audited",
      creationId: "audited-creation",
      persistence: { auditLog: {} },
    });
    await session.setConfig("model", "beta");
    await session.prompt("not copied into audit messages");
    await session.stop();
    expect(await manager.getAgentSessionInfo("audited")).toMatchObject({
      transcriptAvailable: true,
      auditLogAvailable: true,
    });
    const page = await new AuditLogReader(join(root, "audit-logs", "audited.jsonl"))
      .readPage({ limit: 100 });
    expect(page.items.some((item) => item.t === "operation")).toBe(true);
    expect(page.items.some((item) => item.t === "configuration")).toBe(true);
    expect(page.items.some((item) => (item as { t: string }).t === "message")).toBe(false);
  }, 20_000);

  test("registry pre-dispatch failure aborts locally and blocks the live session", async () => {
    const { manager, store } = await setup();
    const session = await manager.createAgentSession(config());
    const save = store.saveAgentSessionRecord.bind(store);
    let fail = true;
    store.saveAgentSessionRecord = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error("simulated registry checkpoint failure");
      }
      return await save(...args);
    };
    try {
      await expect(session.setConfig("model", "beta")).rejects.toThrow(
        "simulated registry checkpoint failure",
      );
      expect(session.model).toBe("alpha");
      expect(session.promptability).toEqual({
        promptable: false,
        blockers: ["persistence_unhealthy"],
      });
      const scan = await scanTranscriptContinuation(session.transcriptPath!);
      expect(scan.reduction.recovery).toEqual({ kind: "clean" });
      expect(scan.reduction.checkpoint.boundary.status).toBe("settled");
    } finally {
      await session.stop();
    }
  }, 20_000);
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "acp-managed-creation-"));
  roots.push(root);
  const store = new FileAgentSessionStore({ root });
  const manager = await SessionManager.open({ root, store });
  return { root, store, manager };
}

function config(): Parameters<SessionManager["createAgentSession"]>[0] {
  return {
    adapter: { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] },
    adapterId: "fake",
    agentSessionId: "managed-agent",
    creationId: "managed-creation",
    persistence: { transcript: { preset: "activity" } },
  };
}
