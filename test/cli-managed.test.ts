import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedCliUsageError, parseManagedCliCommand, runManagedCliCommand } from "../src/cli/managed.ts";
import { createAgentSessionCheckpoint } from "../src/persistence/checkpoint.ts";
import { FileAgentSessionStore } from "../src/persistence/file-registry-store.ts";
import { internalSessionHistoryDigest, type AgentSessionRecord } from "../src/persistence/registry.ts";
import { SessionManager } from "../src/session-manager.ts";

const roots: string[] = [];
const NOW = "2026-09-09T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed CLI parsing", () => {
  test("parses listing and explicit destructive deletion flags", () => {
    expect(parseManagedCliCommand(["sessions", "--root", "/tmp/catalog", "--all", "--json"]))
      .toEqual({ kind: "sessions", root: "/tmp/catalog", includeDeleted: true, json: true });
    expect(parseManagedCliCommand([
      "delete", "agent-1", "--delete-transcript", "--delete-audit-log",
      "--remove-registry-entry", "--yes",
    ])).toEqual({
      kind: "delete",
      root: undefined,
      agentSessionId: "agent-1",
      deleteTranscript: true,
      deleteAuditLog: true,
      removeRegistryEntry: true,
      yes: true,
    });
  });

  test("rejects missing identities, extra positionals, and command-specific flags", () => {
    expect(() => parseManagedCliCommand(["delete", "--yes"])).toThrow("AGENT_SESSION_ID");
    expect(() => parseManagedCliCommand(["delete", "a", "b"])).toThrow("unexpected argument");
    expect(() => parseManagedCliCommand(["sessions", "--yes"])).toThrow("unknown option");
  });

  test("parses the complete managed lifecycle surface", () => {
    expect(parseManagedCliCommand([
      "create", "logical-1", "--adapter", "opencode", "--preset", "detailed",
      "--audit-log", "/tmp/audit.jsonl", "--no-repl",
    ])).toMatchObject({
      kind: "create", agentSessionId: "logical-1", adapterId: "opencode",
      transcript: { preset: "detailed" }, auditLogPath: "/tmp/audit.jsonl", repl: false,
    });
    expect(parseManagedCliCommand(["resume", "logical-1", "--no-activity"]))
      .toMatchObject({ kind: "open", agentSessionId: "logical-1", activity: false });
    expect(parseManagedCliCommand([
      "restore", "logical-1", "--replacement-transcript", "/tmp/new.jsonl",
      "--no-replacement-audit-log",
    ])).toMatchObject({
      kind: "restore", agentSessionId: "logical-1",
      replacementTranscript: { path: "/tmp/new.jsonl" }, replacementAuditLog: false,
    });
    expect(parseManagedCliCommand([
      "reconfigure", "logical-1", "--replace-transcript", "--preset", "conversation", "--yes",
    ])).toEqual({
      kind: "reconfigure", root: undefined, agentSessionId: "logical-1",
      change: { artifact: "transcript", action: "replace", preset: "conversation" }, yes: true,
    });
  });

  test("rejects conflicting lifecycle choices", () => {
    expect(() => parseManagedCliCommand(["create", "--no-transcript", "--transcript", "/tmp/t.jsonl"]))
      .toThrow("conflicting options");
    expect(() => parseManagedCliCommand(["reconfigure", "a", "--disable-transcript", "--disable-audit-log"]))
      .toThrow("exactly one");
    expect(() => parseManagedCliCommand(["open", "a", "--delete-transcript"]))
      .toThrow("unknown option");
  });
});

describe("managed CLI execution", () => {
  test("presents active sessions by default and includes tombstones only on request", async () => {
    const { manager, store } = await setup();
    await store.saveAgentSessionRecord(record("active"), { expectedRecordRevision: null, expectedIncarnationId: null });
    await store.saveAgentSessionRecord(record("deleted", 1, { deletedAt: NOW }), { expectedRecordRevision: null, expectedIncarnationId: null });

    let text = "";
    await runManagedCliCommand(
      { kind: "sessions", includeDeleted: false, json: false },
      { out: (value) => { text += value; } },
      manager,
    );
    expect(text).toContain("active\n");
    expect(text).not.toContain("deleted\n");
    expect(text).toContain("transcript unavailable · audit unavailable");

    let json = "";
    await runManagedCliCommand(
      { kind: "sessions", includeDeleted: true, json: true },
      { out: (value) => { json += value; } },
      manager,
    );
    expect((JSON.parse(json) as { agentSessionId: string }[]).map((item) => item.agentSessionId).sort())
      .toEqual(["active", "deleted"]);
  });

  test("requires an exact interactive identity confirmation and supports cancellation", async () => {
    const { manager, store } = await setup();
    await store.saveAgentSessionRecord(record("agent-1"), { expectedRecordRevision: null, expectedIncarnationId: null });
    let diagnostics = "";
    await runManagedCliCommand(
      command(),
      {
        interactive: true,
        confirm: async () => "not-agent-1",
        error: (value) => { diagnostics += value; },
      },
      manager,
    );
    expect(diagnostics).toContain("Deletion cancelled");
    expect((await manager.getAgentSessionInfo("agent-1"))?.lifecycle).toBe("active");

    await runManagedCliCommand(
      command(),
      { interactive: true, confirm: async () => "agent-1", out: () => {}, error: () => {} },
      manager,
    );
    expect((await manager.getAgentSessionInfo("agent-1", { includeDeleted: true }))?.lifecycle)
      .toBe("deleted");
  });

  test("refuses non-interactive mutation without --yes", async () => {
    const { manager, store } = await setup();
    await store.saveAgentSessionRecord(record("agent-1"), { expectedRecordRevision: null, expectedIncarnationId: null });
    await expect(runManagedCliCommand(command(), { interactive: false }, manager))
      .rejects.toBeInstanceOf(ManagedCliUsageError);
    expect((await manager.getAgentSessionInfo("agent-1"))?.lifecycle).toBe("active");
  });

  test("reuses an exact pending deletion instead of creating a conflicting operation", async () => {
    const { manager, store } = await setup();
    await store.saveAgentSessionRecord(record("agent-1"), { expectedRecordRevision: null, expectedIncarnationId: null });
    const finalize = store.finalizeMaintenance.bind(store);
    let fail = true;
    store.finalizeMaintenance = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error("simulated lost finalization");
      }
      return await finalize(...args);
    };
    await expect(manager.deleteAgentSession("agent-1", {
      deletionId: "original-delete",
      expectedIncarnationId: "inc-agent-1",
      expectedRecordRevision: 1,
    })).rejects.toThrow("simulated lost finalization");

    let output = "";
    await runManagedCliCommand(
      { ...command(), yes: true },
      { out: (value) => { output += value; } },
      manager,
    );
    expect(output).toContain("registry tombstone retained");
    expect(await manager.getSessionMaintenance("agent-1")).toBeNull();
  });

  test("inspects summaries, checkpoints, and maintenance without starting a harness", async () => {
    const { manager, store } = await setup();
    await store.saveAgentSessionRecord(record("agent-1"), { expectedRecordRevision: null, expectedIncarnationId: null });
    let output = "";
    await runManagedCliCommand(
      { kind: "info", agentSessionId: "agent-1", includeDeleted: false, json: true },
      { out: (value) => { output += value; } }, manager,
    );
    expect(JSON.parse(output).agentSessionId).toBe("agent-1");

    output = "";
    await runManagedCliCommand(
      { kind: "checkpoint", agentSessionId: "agent-1", includeDeleted: false, registryProjection: true },
      { out: (value) => { output += value; } }, manager,
    );
    expect(JSON.parse(output)).toMatchObject({ source: "registry_projection", checkpoint: { agentSessionId: "agent-1" } });

    output = "";
    await runManagedCliCommand(
      { kind: "maintenance", agentSessionId: "agent-1", json: false },
      { out: (value) => { output += value; } }, manager,
    );
    expect(output).toContain("No pending maintenance");
  });

  test("managed creation hands the stable AgentSession to the session REPL and always stops it", async () => {
    let stopped = 0;
    let replSessionId = "";
    let createConfig: Record<string, unknown> | undefined;
    const session = {
      agentSessionId: "logical-1",
      stop: async () => { stopped++; },
    };
    const manager = {
      getSessionMaintenance: async () => null,
      createAgentSession: async (config: Record<string, unknown>) => {
        createConfig = config;
        return session;
      },
    } as unknown as SessionManager;

    await runManagedCliCommand(
      parseManagedCliCommand(["create", "logical-1", "--adapter", "opencode"]),
      {
        out: () => {},
        runSession: async (value) => { replSessionId = value.agentSessionId; },
      },
      manager,
    );

    expect(createConfig).toMatchObject({ agentSessionId: "logical-1", adapterId: "opencode" });
    expect(replSessionId).toBe("logical-1");
    expect(stopped).toBe(1);
  });
});

function command(): Extract<ReturnType<typeof parseManagedCliCommand>, { kind: "delete" }> {
  return {
    kind: "delete",
    agentSessionId: "agent-1",
    deleteTranscript: false,
    deleteAuditLog: false,
    removeRegistryEntry: false,
    yes: false,
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "acp-managed-cli-"));
  roots.push(root);
  const store = new FileAgentSessionStore({ root });
  return { store, manager: await SessionManager.open({ root, store }) };
}

function record(
  id: string,
  revision = 1,
  deletion?: AgentSessionRecord["deletion"],
): AgentSessionRecord {
  const sessionConfiguration = {
    adapterId: "opencode",
    schemaDigest: null,
    announcedConfigIds: [],
    restorationTargets: [],
    effective: {},
    omittedConfigIds: [],
    restorationFidelity: "exact" as const,
    observedAt: NOW,
  };
  const checkpoint = createAgentSessionCheckpoint({
    agentSessionId: id,
    incarnationId: `inc-${id}`,
    stateRevision: 1,
    adapterId: "opencode",
    mode: "normal",
    internalSessionId: `provider-${id}`,
    internalSessionActivatedAt: NOW,
    internalSessionHistoryRevision: 0,
    internalSessionHistoryDigest: internalSessionHistoryDigest([]),
    model: "model",
    sessionConfiguration,
    protocol: { name: "acp", version: 1 },
    transcript: null,
    boundary: { status: "settled", lastSettledOperationId: null },
    updatedAt: NOW,
  });
  return {
    agentSessionId: id,
    incarnationId: `inc-${id}`,
    recordRevision: revision,
    checkpoint,
    adapterId: "opencode",
    mode: "normal",
    internalSessionId: `provider-${id}`,
    internalSessionActivatedAt: NOW,
    internalSessionHistory: [],
    model: "model",
    sessionConfiguration,
    protocol: { name: "acp", version: 1 },
    transcript: null,
    auditLog: null,
    ...(deletion ? { deletion } : {}),
    createdAt: NOW,
    updatedAt: NOW,
    lastOpenedAt: NOW,
  };
}
