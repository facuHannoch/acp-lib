import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentConversationId, createAgentSessionId } from "../src/agent-ids.ts";
import {
  AgentAuditRuntime,
  AuditLogDestinationInUseError,
  AuditLogHistoryMissingError,
  resolveAgentAuditLogConfig,
} from "../src/audit/index.ts";
import { SqliteAgentPersistence } from "../src/persistence/sqlite-backend.ts";
import type { AuditOutboxPersistence, PersistenceBackend } from "../src/persistence/backend.ts";

const roots: string[] = [];
const backends: SqliteAgentPersistence[] = [];
const runtimes: AgentAuditRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.allSettled(backends.splice(0).map((backend) => backend.close()));
  await Promise.allSettled(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent audit delivery runtime", () => {
  test("syncs a v2 entry before acknowledging its pending item", async () => {
    const fixture = await createFixture();
    const conversationId = createAgentConversationId();
    await fixture.backend.conversations.create({
      agentSessionId: fixture.agentSessionId,
      agentConversationId: conversationId,
    });
    const item = await fixture.backend.auditOutbox.enqueue({
      outboxId: "outbox-1",
      sourceObservationId: "record-1",
      sourceRecordId: "record-1",
      agentConversationId: conversationId,
      occurredAt: "2026-09-19T00:00:00.000Z",
      kind: "message",
      captureLevel: "content",
      captureFingerprint: fixture.config.captureFingerprint,
      payload: { role: "user", content: "hello" },
      createdAt: "2026-09-19T00:00:00.001Z",
    });
    fixture.runtime.notifyPending();
    const flushed = await fixture.runtime.flush({ timeoutMs: 3_000 });
    expect(flushed).toMatchObject({ status: "delivered", throughSequence: 1, deliveredThroughSequence: 1 });

    const lines = (await readFile(join(fixture.auditDirectory, "audit.000001.jsonl"), "utf8"))
      .trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({
      v: 2,
      t: "header",
      auditLogId: fixture.state.auditLogId,
      agentSessionId: fixture.agentSessionId,
      generation: 1,
    });
    expect(lines[1]).toMatchObject({
      v: 2,
      t: "audit",
      outboxId: item.outboxId,
      auditSequence: 1,
      payloadSha256: item.payloadSha256,
      payload: { role: "user", content: "hello" },
    });
    expect((await fixture.backend.auditOutbox.state())?.lastDeliveredSequence).toBe(1);
    expect(await fixture.runtime.status()).toMatchObject({
      state: "idle",
      pendingCount: 0,
      lastAllocatedSequence: 1,
      lastDeliveredSequence: 1,
    });
  });

  test("backs off after an acknowledgement failure and retries without appending the batch twice", async () => {
    const root = await makeRoot();
    const backend = await createBackend(root, "agent.sqlite");
    const auditDirectory = join(root, "audit");
    const config = resolveAgentAuditLogConfig({
      directory: auditDirectory,
      retry: { initialDelayMs: 60_000, maxDelayMs: 60_000 },
    });
    const state = await backend.auditOutbox.initialize("audit-log-1", config.captureFingerprint);
    let failures = 1;
    const flakyOutbox = proxyOutbox(backend.auditOutbox, async (ids, deliveredAt) => {
      if (failures-- > 0) throw new Error("simulated acknowledgement failure");
      return await backend.auditOutbox.acknowledge(ids, deliveredAt);
    });
    const persistence = new Proxy(backend, {
      get(target, property, receiver) {
        if (property === "auditOutbox") return flakyOutbox;
        return Reflect.get(target, property, receiver);
      },
    }) as PersistenceBackend;
    const runtime = await AgentAuditRuntime.open({
      persistence,
      agentSessionId: backend.identityRecord.agentSessionId,
      config,
      auditState: state,
    });
    runtimes.push(runtime);
    const notifications: string[] = [];
    runtime.subscribe(() => { throw new Error("isolated subscriber"); });
    runtime.subscribe((event) => notifications.push(event.kind));
    await backend.auditOutbox.enqueue({
      outboxId: "outbox-1",
      sourceObservationId: "source-1",
      occurredAt: "2026-09-19T00:00:00.000Z",
      kind: "agent_lifecycle",
      captureLevel: "metadata",
      captureFingerprint: config.captureFingerprint,
      payload: { state: "opened" },
      createdAt: "2026-09-19T00:00:00.000Z",
    });
    runtime.notifyPending();
    await waitUntil(async () => (await runtime.status()).state === "backoff");
    expect(await runtime.status()).toMatchObject({
      pendingCount: 1,
      pendingPayloadBytes: expect.any(Number),
      headAttemptCount: 1,
      headLastError: "Error: simulated acknowledgement failure",
    });
    expect(await runtime.flush({ timeoutMs: 0 })).toMatchObject({ status: "timed_out", throughSequence: 1 });
    expect((await readFile(join(auditDirectory, "audit.000001.jsonl"), "utf8")).trimEnd().split("\n"))
      .toHaveLength(2);

    await runtime.retry();
    expect(await runtime.flush({ timeoutMs: 3_000 })).toMatchObject({ status: "delivered" });
    expect((await readFile(join(auditDirectory, "audit.000001.jsonl"), "utf8")).trimEnd().split("\n"))
      .toHaveLength(2);
    expect(notifications).toContain("batch_failed");
    expect(notifications).toContain("backoff_started");
    expect(notifications).toContain("batch_completed");
  });

  test("prevents two different agent databases from owning one destination", async () => {
    const first = await createFixture();
    const secondBackend = await createBackend(first.root, "second.sqlite");
    const secondState = await secondBackend.auditOutbox.initialize("audit-log-2", first.config.captureFingerprint);
    await expect(AgentAuditRuntime.open({
      persistence: secondBackend,
      agentSessionId: secondBackend.identityRecord.agentSessionId,
      config: first.config,
      auditState: secondState,
    })).rejects.toBeInstanceOf(AuditLogDestinationInUseError);
  });

  test("refuses an empty replacement destination after delivery was acknowledged", async () => {
    const root = await makeRoot();
    const backend = await createBackend(root, "agent.sqlite");
    const config = resolveAgentAuditLogConfig({ directory: join(root, "missing-audit") });
    const state = await backend.auditOutbox.initialize("audit-log-1", config.captureFingerprint);
    await backend.auditOutbox.enqueue({
      outboxId: "outbox-1",
      sourceObservationId: "source-1",
      occurredAt: "2026-09-19T00:00:00.000Z",
      kind: "agent_lifecycle",
      captureLevel: "metadata",
      captureFingerprint: config.captureFingerprint,
      payload: { state: "opened" },
      createdAt: "2026-09-19T00:00:00.000Z",
    });
    await backend.auditOutbox.acknowledge(["outbox-1"]);
    await expect(AgentAuditRuntime.open({
      persistence: backend,
      agentSessionId: backend.identityRecord.agentSessionId,
      config,
      auditState: { ...state, lastAllocatedSequence: 1, lastDeliveredSequence: 1 },
    })).rejects.toBeInstanceOf(AuditLogHistoryMissingError);
  });
});

async function createFixture() {
  const root = await makeRoot();
  const backend = await createBackend(root, "agent.sqlite");
  const auditDirectory = join(root, "audit");
  const config = resolveAgentAuditLogConfig({ directory: auditDirectory });
  const state = await backend.auditOutbox.initialize("audit-log-1", config.captureFingerprint);
  const runtime = await AgentAuditRuntime.open({
    persistence: backend,
    agentSessionId: backend.identityRecord.agentSessionId,
    config,
    auditState: state,
  });
  runtimes.push(runtime);
  return { root, backend, agentSessionId: backend.identityRecord.agentSessionId, auditDirectory, config, state, runtime };
}

async function createBackend(root: string, name: string): Promise<SqliteAgentPersistence> {
  const backend = await SqliteAgentPersistence.open({ path: join(root, name), agentSessionId: createAgentSessionId() });
  backends.push(backend);
  return backend;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acp-audit-runtime-"));
  roots.push(root);
  return root;
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for audit delivery");
}

function proxyOutbox(
  target: AuditOutboxPersistence,
  acknowledge: AuditOutboxPersistence["acknowledge"],
): AuditOutboxPersistence {
  return new Proxy(target, {
    get(value, property) {
      if (property === "acknowledge") return acknowledge;
      const member = Reflect.get(value, property);
      return typeof member === "function" ? member.bind(value) : member;
    },
  });
}
