import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileAgentSessionStore } from "../src/persistence/file-registry-store.ts";
import { MaintenanceAlreadyCompletedError } from "../src/persistence/registry.ts";
import { SessionManager } from "../src/session-manager.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionManager persistence maintenance", () => {
  test("replaces a transcript generation and remains loadable", async () => {
    const { root, manager } = await setup();
    const session = await manager.createAgentSession(createConfig());
    await session.setConfig("model", "beta");
    await session.prompt("establish the recorded thread");
    await session.stop();
    const info = (await manager.getAgentSessionInfo("managed-agent"))!;
    const authority = (await manager.getAgentSessionCheckpoint("managed-agent"))!;
    const path = join(root, "transcripts", "managed-agent.jsonl");

    const request = {
      reconfigurationId: "replace-transcript",
      expectedIncarnationId: info.incarnationId,
      expectedRecordRevision: info.recordRevision,
      transcript: {
        action: "replace",
        config: { path, preset: "conversation" },
        checkpoint: authority.checkpoint,
        acknowledgeContinuationLoss: true,
      },
    } as const;
    const changed = await manager.reconfigureAgentSessionPersistence("managed-agent", request);
    expect(changed.transcriptAvailable).toBe(true);
    const record = await manager.getAgentSessionCheckpoint("managed-agent");
    expect(record?.checkpoint.transcript?.generation).toBe(1);
    expect(record?.checkpoint.transcript?.transcriptId)
      .not.toBe(authority.checkpoint.transcript?.transcriptId);
    await expect(manager.reconfigureAgentSessionPersistence("managed-agent", request))
      .rejects.toBeInstanceOf(MaintenanceAlreadyCompletedError);

    const opened = await manager.loadAgentSession("managed-agent", runtimeConfig());
    try {
      expect(opened.session.model).toBe("beta");
    } finally {
      await opened.session.stop();
    }
  }, 20_000);

  test("explicitly disables and deletes transcript authority", async () => {
    const { manager } = await setup();
    const session = await manager.createAgentSession(createConfig());
    await session.stop();
    const info = (await manager.getAgentSessionInfo("managed-agent"))!;
    const authority = (await manager.getAgentSessionCheckpoint("managed-agent"))!;
    const changed = await manager.reconfigureAgentSessionPersistence("managed-agent", {
      reconfigurationId: "disable-transcript",
      expectedIncarnationId: info.incarnationId,
      expectedRecordRevision: info.recordRevision,
      transcript: {
        action: "disable",
        checkpoint: authority.checkpoint,
        deleteExistingLog: true,
        acknowledgeContinuationLoss: true,
      },
    });
    expect(changed.transcriptAvailable).toBe(false);
    const checkpoint = await manager.getAgentSessionCheckpoint("managed-agent");
    expect(checkpoint).toMatchObject({ source: "registry_projection", authoritative: true });
    expect(checkpoint?.checkpoint.transcript).toBeNull();
  }, 20_000);

  test("replaces and then explicitly disables an audit generation", async () => {
    const { root, manager } = await setup();
    const session = await manager.createAgentSession({
      ...createConfig(),
      agentSessionId: "audited",
      creationId: "audited-creation",
      persistence: { auditLog: {} },
    });
    await session.stop();
    const before = (await manager.getAgentSessionInfo("audited"))!;
    const path = join(root, "audit-logs", "audited.jsonl");
    const replaced = await manager.reconfigureAgentSessionPersistence("audited", {
      reconfigurationId: "replace-audit",
      expectedIncarnationId: before.incarnationId,
      expectedRecordRevision: before.recordRevision,
      auditLog: {
        action: "replace",
        config: { path, capture: { tools: "metadata" } },
        acknowledgeAuditGap: true,
      },
    });
    expect(replaced.auditLogAvailable).toBe(true);
    const disabled = await manager.reconfigureAgentSessionPersistence("audited", {
      reconfigurationId: "disable-audit",
      expectedIncarnationId: replaced.incarnationId,
      expectedRecordRevision: replaced.recordRevision,
      auditLog: {
        action: "disable",
        deleteExistingLog: true,
        acknowledgeAuditGap: true,
      },
    });
    expect(disabled.auditLogAvailable).toBe(false);
  }, 20_000);
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "acp-managed-reconfigure-"));
  roots.push(root);
  const store = new FileAgentSessionStore({ root });
  return { root, manager: await SessionManager.open({ root, store }) };
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
