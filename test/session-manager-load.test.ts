import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AdapterMismatchError } from "../src/agent-session.ts";
import { FileAgentSessionStore } from "../src/persistence/file-registry-store.ts";
import {
  ManagedAgentSessionDeletedError,
  ManagedAgentSessionNotFoundError,
} from "../src/persistence/managed-load.ts";
import { SessionManager } from "../src/session-manager.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionManager.loadAgentSession", () => {
  test("loads the recorded provider thread and continues publishing checkpoints", async () => {
    const { manager } = await setup();
    const created = await manager.createAgentSession(createConfig());
    await created.setConfig("model", "beta");
    const before = await manager.getAgentSessionInfo("managed-agent");
    await created.stop();

    const opened = await manager.loadAgentSession("managed-agent", loadConfig());
    try {
      expect(opened.continuation.outcome.kind).toBe("loaded");
      expect(opened.session.agentSessionId).toBe("managed-agent");
      expect(opened.session.internalSessionId).toBe("config-session");
      expect(opened.session.model).toBe("beta");
      const loaded = await manager.getAgentSessionInfo("managed-agent");
      expect(loaded!.recordRevision).toBeGreaterThan(before!.recordRevision);

      await opened.session.setConfig("model", "alpha");
      expect((await manager.getAgentSessionInfo("managed-agent"))?.model).toBe("alpha");
    } finally {
      await opened.session.stop();
    }
  }, 20_000);

  test("repairs a stale registry projection from transcript authority", async () => {
    const { manager, store } = await setup();
    const created = await manager.createAgentSession(createConfig());
    const stale = await store.getAgentSessionRecord("managed-agent");
    await created.setConfig("model", "beta");
    await created.stop();
    const current = await store.getAgentSessionRecord("managed-agent");
    await store.saveAgentSessionRecord({
      ...stale!,
      recordRevision: current!.recordRevision + 1,
      updatedAt: current!.updatedAt,
      lastOpenedAt: current!.lastOpenedAt,
    }, {
      expectedRecordRevision: current!.recordRevision,
      expectedIncarnationId: current!.incarnationId,
    });

    const opened = await manager.loadAgentSession("managed-agent", loadConfig());
    try {
      expect(opened.session.model).toBe("beta");
      expect((await store.getAgentSessionRecord("managed-agent"))?.checkpoint.stateRevision)
        .toBeGreaterThan(stale!.checkpoint.stateRevision);
    } finally {
      await opened.session.stop();
    }
  }, 20_000);

  test("rejects absent, deleted, and adapter-mismatched sessions", async () => {
    const { manager } = await setup();
    await expect(manager.loadAgentSession("missing", loadConfig()))
      .rejects.toBeInstanceOf(ManagedAgentSessionNotFoundError);

    const created = await manager.createAgentSession(createConfig());
    await created.stop();
    const summary = await manager.getAgentSessionInfo("managed-agent")!;
    await manager.deleteAgentSession("managed-agent", {
      deletionId: "delete-managed",
      expectedIncarnationId: summary!.incarnationId,
      expectedRecordRevision: summary!.recordRevision,
    });
    await expect(manager.loadAgentSession("managed-agent", loadConfig()))
      .rejects.toBeInstanceOf(ManagedAgentSessionDeletedError);
  }, 20_000);

  test("rejects an adapter mismatch before starting a harness", async () => {
    const { manager } = await setup();
    const created = await manager.createAgentSession(createConfig());
    await created.stop();
    await expect(manager.loadAgentSession("managed-agent", {
      ...loadConfig(),
      adapterId: "other",
      adapter: { command: ["definitely-not-a-real-command"] },
    })).rejects.toBeInstanceOf(AdapterMismatchError);
  }, 20_000);
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "acp-managed-load-"));
  roots.push(root);
  const store = new FileAgentSessionStore({ root });
  const manager = await SessionManager.open({ root, store });
  return { root, store, manager };
}

function createConfig(): Parameters<SessionManager["createAgentSession"]>[0] {
  return {
    ...loadConfig(),
    agentSessionId: "managed-agent",
    creationId: "managed-creation",
    persistence: { transcript: { preset: "activity" } },
  };
}

function loadConfig(): Parameters<SessionManager["loadAgentSession"]>[1] {
  return {
    adapter: { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] },
    adapterId: "fake",
  };
}
