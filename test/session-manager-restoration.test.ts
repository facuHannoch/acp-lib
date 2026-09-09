import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileAgentSessionStore } from "../src/persistence/file-registry-store.ts";
import { AgentSessionRestorationError } from "../src/persistence/restoration.ts";
import { SessionManager } from "../src/session-manager.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionManager.restoreAgentSession", () => {
  test("reactivates a tombstone with its retained transcript and reports continuation", async () => {
    const { manager } = await setup();
    const created = await manager.createAgentSession(createConfig());
    await created.setConfig("model", "beta");
    await created.stop();
    const active = (await manager.getAgentSessionInfo("managed-agent"))!;
    await manager.deleteAgentSession("managed-agent", {
      deletionId: "delete-managed",
      expectedIncarnationId: active.incarnationId,
      expectedRecordRevision: active.recordRevision,
    });
    const deleted = (await manager.getAgentSessionInfo("managed-agent", { includeDeleted: true }))!;

    const restored = await manager.restoreAgentSession("managed-agent", {
      ...runtimeConfig(),
      restorationId: "restore-managed",
      expectedIncarnationId: deleted.incarnationId,
      expectedRecordRevision: deleted.recordRevision,
    });
    try {
      expect(restored.continuation.outcome.kind).toBe("loaded");
      expect(restored.session.agentSessionId).toBe("managed-agent");
      expect(restored.session.internalSessionId).toBe("config-session");
      expect(restored.session.model).toBe("beta");
      expect(await manager.getAgentSessionInfo("managed-agent")).toMatchObject({
        lifecycle: "active",
        transcriptAvailable: true,
      });
      await restored.session.setConfig("model", "alpha");
      expect((await manager.getAgentSessionInfo("managed-agent"))?.model).toBe("alpha");
    } finally {
      await restored.session.stop();
    }
  }, 20_000);

  test("does not treat an active session as restorable", async () => {
    const { manager } = await setup();
    const created = await manager.createAgentSession(createConfig());
    await created.stop();
    const info = (await manager.getAgentSessionInfo("managed-agent"))!;
    await expect(manager.restoreAgentSession("managed-agent", {
      ...runtimeConfig(),
      restorationId: "restore-active",
      expectedIncarnationId: info.incarnationId,
      expectedRecordRevision: info.recordRevision,
    })).rejects.toBeInstanceOf(AgentSessionRestorationError);
  }, 20_000);

  test("resumes a staged restoration after registry finalization fails", async () => {
    const { manager, store } = await setup();
    const created = await manager.createAgentSession(createConfig());
    await created.stop();
    const active = (await manager.getAgentSessionInfo("managed-agent"))!;
    await manager.deleteAgentSession("managed-agent", {
      deletionId: "delete-managed",
      expectedIncarnationId: active.incarnationId,
      expectedRecordRevision: active.recordRevision,
    });
    const deleted = (await manager.getAgentSessionInfo("managed-agent", { includeDeleted: true }))!;
    const request = {
      ...runtimeConfig(),
      restorationId: "restore-retry",
      expectedIncarnationId: deleted.incarnationId,
      expectedRecordRevision: deleted.recordRevision,
    } as const;
    const finalize = store.finalizeMaintenance.bind(store);
    let fail = true;
    store.finalizeMaintenance = async (...args) => {
      if (fail && args[2] === "restore-retry") {
        fail = false;
        throw new Error("simulated restoration finalization failure");
      }
      return await finalize(...args);
    };
    await expect(manager.restoreAgentSession("managed-agent", request))
      .rejects.toThrow("simulated restoration finalization failure");
    expect((await manager.getSessionMaintenance("managed-agent"))?.kind).toBe("restoration");

    const restored = await manager.restoreAgentSession("managed-agent", request);
    try {
      expect(restored.continuation.outcome.kind).toBe("loaded");
      expect((await manager.getAgentSessionInfo("managed-agent"))?.lifecycle).toBe("active");
    } finally {
      await restored.session.stop();
    }
  }, 20_000);

  test("restores a retained transcript and audit log together", async () => {
    const { manager } = await setup();
    const created = await manager.createAgentSession({
      ...createConfig(),
      agentSessionId: "audited",
      creationId: "audited-creation",
      persistence: { auditLog: {} },
    });
    await created.stop();
    const active = (await manager.getAgentSessionInfo("audited"))!;
    await manager.deleteAgentSession("audited", {
      deletionId: "delete-audited",
      expectedIncarnationId: active.incarnationId,
      expectedRecordRevision: active.recordRevision,
    });
    const deleted = (await manager.getAgentSessionInfo("audited", { includeDeleted: true }))!;
    const restored = await manager.restoreAgentSession("audited", {
      ...runtimeConfig(), restorationId: "restore-audited",
      expectedIncarnationId: deleted.incarnationId,
      expectedRecordRevision: deleted.recordRevision,
    });
    await restored.session.stop();
    expect(await manager.getAgentSessionInfo("audited")).toMatchObject({
      lifecycle: "active", transcriptAvailable: true, auditLogAvailable: true,
    });
  }, 20_000);

  test("can explicitly restore after deleted logs as registry-only authority", async () => {
    const { manager } = await setup();
    const created = await manager.createAgentSession({
      ...createConfig(),
      agentSessionId: "logs-deleted",
      creationId: "logs-deleted-creation",
      persistence: { auditLog: {} },
    });
    await created.stop();
    const active = (await manager.getAgentSessionInfo("logs-deleted"))!;
    await manager.deleteAgentSession("logs-deleted", {
      deletionId: "delete-logs",
      expectedIncarnationId: active.incarnationId,
      expectedRecordRevision: active.recordRevision,
      deleteTranscript: true,
      deleteAuditLog: true,
    });
    const deleted = (await manager.getAgentSessionInfo("logs-deleted", { includeDeleted: true }))!;
    const restored = await manager.restoreAgentSession("logs-deleted", {
      ...runtimeConfig(), restorationId: "restore-without-logs",
      expectedIncarnationId: deleted.incarnationId,
      expectedRecordRevision: deleted.recordRevision,
      replacementTranscript: false,
      replacementAuditLog: false,
    });
    try {
      expect(restored.continuation.recordedConversationAvailability).toBe("not_captured");
      expect(await manager.getAgentSessionInfo("logs-deleted")).toMatchObject({
        lifecycle: "active", transcriptAvailable: false, auditLogAvailable: false,
      });
    } finally {
      await restored.session.stop();
    }
  }, 20_000);

  test("installs explicit replacement generations for deleted artifacts", async () => {
    const { root, manager } = await setup();
    const created = await manager.createAgentSession({
      ...createConfig(),
      agentSessionId: "replace-deleted",
      creationId: "replace-deleted-creation",
      persistence: { auditLog: {} },
    });
    await created.setConfig("model", "beta");
    await created.stop();
    const active = (await manager.getAgentSessionInfo("replace-deleted"))!;
    await manager.deleteAgentSession("replace-deleted", {
      deletionId: "delete-before-replace",
      expectedIncarnationId: active.incarnationId,
      expectedRecordRevision: active.recordRevision,
      deleteTranscript: true,
      deleteAuditLog: true,
    });
    const deleted = (await manager.getAgentSessionInfo("replace-deleted", { includeDeleted: true }))!;
    const restored = await manager.restoreAgentSession("replace-deleted", {
      ...runtimeConfig(), restorationId: "restore-replacements",
      expectedIncarnationId: deleted.incarnationId,
      expectedRecordRevision: deleted.recordRevision,
      replacementTranscript: {
        path: join(root, "replacement", "conversation.jsonl"),
        preset: "conversation",
      },
      replacementAuditLog: {
        path: join(root, "replacement", "audit.jsonl"),
      },
    });
    try {
      expect(restored.session.model).toBe("beta");
      expect(await manager.getAgentSessionInfo("replace-deleted")).toMatchObject({
        lifecycle: "active", transcriptAvailable: true, auditLogAvailable: true,
      });
      const authority = await manager.getAgentSessionCheckpoint("replace-deleted");
      expect(authority?.checkpoint.transcript?.path).toBe(
        join(root, "replacement", "conversation.jsonl"),
      );
    } finally {
      await restored.session.stop();
    }
  }, 20_000);
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "acp-managed-restore-"));
  roots.push(root);
  const store = new FileAgentSessionStore({ root });
  return { root, store, manager: await SessionManager.open({ root, store }) };
}

function runtimeConfig() {
  return {
    adapter: { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] },
    adapterId: "fake",
  } as const;
}

function createConfig(): Parameters<SessionManager["createAgentSession"]>[0] {
  return {
    ...runtimeConfig(),
    agentSessionId: "managed-agent",
    creationId: "managed-creation",
  };
}
