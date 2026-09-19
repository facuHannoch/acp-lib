import { afterEach, describe, expect, test } from "bun:test";
import { access, appendFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentConversationId, createAgentSessionId } from "../src/agent-ids.ts";
import {
  AgentAuditRuntime,
  AuditLogDestinationInUseError,
  AuditLogHistoryMissingError,
  AuditLogIdentityConflictError,
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

  test("rotates before entries by size without splitting an oversized entry", async () => {
    const fixture = await createFixture({ rotation: { maxBytes: 300, maxAgeMs: false } });
    for (let index = 0; index < 3; index++) {
      await fixture.backend.auditOutbox.enqueue({
        outboxId: `outbox-${index}`,
        sourceObservationId: `source-${index}`,
        occurredAt: "2026-09-19T00:00:00.000Z",
        kind: "message",
        captureLevel: "content",
        captureFingerprint: fixture.config.captureFingerprint,
        payload: { content: "x".repeat(400), index },
        createdAt: `2026-09-19T00:00:0${index}.000Z`,
      });
    }
    fixture.runtime.notifyPending();
    expect(await fixture.runtime.flush({ timeoutMs: 3_000 })).toMatchObject({ status: "delivered" });
    const segments = (await readdir(fixture.auditDirectory)).filter((name) => name.endsWith(".jsonl")).sort();
    expect(segments).toEqual([
      "audit.000001.jsonl",
      "audit.000002.jsonl",
      "audit.000003.jsonl",
    ]);
    for (const segment of segments) {
      expect((await readFile(join(fixture.auditDirectory, segment), "utf8")).trimEnd().split("\n"))
        .toHaveLength(2);
    }
    expect((await fixture.runtime.status()).activeSegmentGeneration).toBe(3);
  });

  test("rotates lazily by age only when another entry arrives", async () => {
    const fixture = await createFixture({ rotation: { maxBytes: false, maxAgeMs: 1 } });
    await enqueueLifecycle(fixture.backend, fixture.config.captureFingerprint, "outbox-1", "source-1");
    fixture.runtime.notifyPending();
    await fixture.runtime.flush({ timeoutMs: 3_000 });
    await Bun.sleep(5);
    expect((await readdir(fixture.auditDirectory)).filter((name) => name.endsWith(".jsonl")))
      .toHaveLength(1);
    await enqueueLifecycle(fixture.backend, fixture.config.captureFingerprint, "outbox-2", "source-2");
    fixture.runtime.notifyPending();
    await fixture.runtime.flush({ timeoutMs: 3_000 });
    expect((await readdir(fixture.auditDirectory)).filter((name) => name.endsWith(".jsonl")).sort())
      .toEqual(["audit.000001.jsonl", "audit.000002.jsonl"]);
  });

  test("reopens from a bounded tail after audit history spans more than the replay window", async () => {
    const fixture = await createFixture({ rotation: { maxBytes: 300, maxAgeMs: false } });
    for (let index = 0; index < 40; index++) {
      await fixture.backend.auditOutbox.enqueue({
        outboxId: `outbox-history-${index}`,
        sourceObservationId: `source-history-${index}`,
        occurredAt: "2026-09-19T00:00:00.000Z",
        kind: "message",
        captureLevel: "content",
        captureFingerprint: fixture.config.captureFingerprint,
        payload: { content: "x".repeat(400), index },
        createdAt: "2026-09-19T00:00:00.000Z",
      });
    }
    fixture.runtime.notifyPending();
    expect(await fixture.runtime.flush({ timeoutMs: 5_000 })).toMatchObject({ status: "delivered" });
    await fixture.runtime.close();

    const reopened = await AgentAuditRuntime.open({
      persistence: fixture.backend,
      agentSessionId: fixture.agentSessionId,
      config: fixture.config,
      auditState: (await fixture.backend.auditOutbox.state())!,
    });
    runtimes.push(reopened);
    expect((await reopened.status()).lastDeliveredSequence).toBe(40);
    expect((await readdir(fixture.auditDirectory)).filter((name) => name.endsWith(".jsonl")))
      .toHaveLength(40);
  });

  test("reconciles a synced pending suffix on reopen without writing it again", async () => {
    const root = await makeRoot();
    const backend = await createBackend(root, "agent.sqlite");
    const auditDirectory = join(root, "audit");
    const config = resolveAgentAuditLogConfig({
      directory: auditDirectory,
      retry: { initialDelayMs: 60_000, maxDelayMs: 60_000 },
      shutdownGraceMs: 0,
    });
    const state = await backend.auditOutbox.initialize("audit-log-1", config.captureFingerprint);
    const alwaysFailing = proxyOutbox(backend.auditOutbox, async () => {
      throw new Error("simulated crash boundary");
    });
    const persistence = new Proxy(backend, {
      get(target, property, receiver) {
        if (property === "auditOutbox") return alwaysFailing;
        return Reflect.get(target, property, receiver);
      },
    }) as PersistenceBackend;
    const first = await AgentAuditRuntime.open({
      persistence,
      agentSessionId: backend.identityRecord.agentSessionId,
      config,
      auditState: state,
    });
    await backend.auditOutbox.enqueue({
      outboxId: "outbox-1",
      sourceObservationId: "source-1",
      occurredAt: "2026-09-19T00:00:00.000Z",
      kind: "message",
      captureLevel: "content",
      captureFingerprint: config.captureFingerprint,
      payload: { content: "once" },
      createdAt: "2026-09-19T00:00:00.000Z",
    });
    first.notifyPending();
    await waitUntil(async () => (await first.status()).state === "backoff");
    await first.close();

    const before = await readFile(join(auditDirectory, "audit.000001.jsonl"), "utf8");
    const refreshed = (await backend.auditOutbox.state())!;
    const reopened = await AgentAuditRuntime.open({
      persistence: backend,
      agentSessionId: backend.identityRecord.agentSessionId,
      config,
      auditState: refreshed,
    });
    runtimes.push(reopened);
    expect(await backend.auditOutbox.head()).toBeNull();
    expect((await backend.auditOutbox.state())?.lastDeliveredSequence).toBe(1);
    expect(await readFile(join(auditDirectory, "audit.000001.jsonl"), "utf8")).toBe(before);
  });

  test("recovers the append-before-ack boundary after owner process termination", async () => {
    const root = await makeRoot();
    const databasePath = join(root, "crash-agent.sqlite");
    const auditDirectory = join(root, "crash-audit");
    const readyPath = join(root, "crash-ready");
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "fixtures", "audit-crash-holder.ts"),
      databasePath,
      auditDirectory,
      readyPath,
    ], { stdout: "ignore", stderr: "pipe" });
    try {
      await waitForChildPath(readyPath, child);
      child.kill("SIGKILL");
      await child.exited;
      const backend = await SqliteAgentPersistence.open({ path: databasePath });
      backends.push(backend);
      const config = resolveAgentAuditLogConfig({
        directory: auditDirectory,
        retry: { initialDelayMs: 60_000, maxDelayMs: 60_000 },
        shutdownGraceMs: 0,
      });
      const state = (await backend.auditOutbox.state())!;
      const runtime = await AgentAuditRuntime.open({
        persistence: backend,
        agentSessionId: backend.identityRecord.agentSessionId,
        config,
        auditState: state,
      });
      runtimes.push(runtime);
      expect(await backend.auditOutbox.head()).toBeNull();
      expect((await backend.auditOutbox.state())?.lastDeliveredSequence).toBe(1);
      expect((await readFile(join(auditDirectory, "audit.000001.jsonl"), "utf8")).trimEnd().split("\n"))
        .toHaveLength(2);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  });

  test("truncates only an incomplete tail in the highest segment", async () => {
    const fixture = await createFixture();
    await fixture.backend.auditOutbox.enqueue({
      outboxId: "outbox-1",
      sourceObservationId: "source-1",
      occurredAt: "2026-09-19T00:00:00.000Z",
      kind: "message",
      captureLevel: "content",
      captureFingerprint: fixture.config.captureFingerprint,
      payload: { content: "complete" },
      createdAt: "2026-09-19T00:00:00.000Z",
    });
    fixture.runtime.notifyPending();
    await fixture.runtime.flush({ timeoutMs: 3_000 });
    await fixture.runtime.close();
    runtimes.splice(runtimes.indexOf(fixture.runtime), 1);
    const segment = join(fixture.auditDirectory, "audit.000001.jsonl");
    const complete = await readFile(segment, "utf8");
    await appendFile(segment, "{\"v\":2,\"t\":\"audit\"");

    const reopened = await AgentAuditRuntime.open({
      persistence: fixture.backend,
      agentSessionId: fixture.agentSessionId,
      config: fixture.config,
      auditState: (await fixture.backend.auditOutbox.state())!,
    });
    runtimes.push(reopened);
    expect(await readFile(segment, "utf8")).toBe(complete);
  });

  test("fails closed on a complete malformed entry", async () => {
    const fixture = await createFixture();
    await fixture.runtime.close();
    runtimes.splice(runtimes.indexOf(fixture.runtime), 1);
    await appendFile(join(fixture.auditDirectory, "audit.000001.jsonl"), "{not-json}\n");
    await expect(AgentAuditRuntime.open({
      persistence: fixture.backend,
      agentSessionId: fixture.agentSessionId,
      config: fixture.config,
      auditState: (await fixture.backend.auditOutbox.state())!,
    })).rejects.toBeInstanceOf(AuditLogIdentityConflictError);
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

  test("delivers one contiguous audit order under concurrent conversation writers", async () => {
    const fixture = await createFixture();
    const conversations = await Promise.all(Array.from({ length: 20 }, async () => {
      const id = createAgentConversationId();
      await fixture.backend.conversations.create({
        agentSessionId: fixture.agentSessionId,
        agentConversationId: id,
      });
      return id;
    }));
    await Promise.all(conversations.flatMap((conversationId, conversationIndex) =>
      Array.from({ length: 10 }, (_, itemIndex) => {
        const index = conversationIndex * 10 + itemIndex;
        return fixture.backend.auditOutbox.enqueue({
          outboxId: `concurrent-outbox-${index}`,
          sourceObservationId: `concurrent-source-${index}`,
          agentConversationId: conversationId,
          occurredAt: "2026-09-19T00:00:00.000Z",
          kind: "activity",
          captureLevel: "metadata",
          captureFingerprint: fixture.config.captureFingerprint,
          payload: { conversationIndex, itemIndex },
          createdAt: "2026-09-19T00:00:00.000Z",
        });
      })));
    fixture.runtime.notifyPending();
    expect(await fixture.runtime.flush({ timeoutMs: 5_000 })).toMatchObject({
      status: "delivered",
      throughSequence: 200,
    });
    const reader = await (await import("../src/audit/reader.ts")).AgentAuditLogReader.open({
      directory: fixture.auditDirectory,
    });
    const entries = (await reader.readPage({ mode: "logical", limit: 1_000 })).entries;
    expect(entries).toHaveLength(200);
    expect(entries.map((entry) => entry.auditSequence)).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 1),
    );
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

async function createFixture(overrides: Parameters<typeof resolveAgentAuditLogConfig>[0] = { directory: "unused" }) {
  const root = await makeRoot();
  const backend = await createBackend(root, "agent.sqlite");
  const auditDirectory = join(root, "audit");
  const config = resolveAgentAuditLogConfig({ ...overrides, directory: auditDirectory });
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

async function waitForChildPath(path: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      if (child.exitCode !== null) {
        const stderr = await new Response(child.stderr).text();
        throw new Error(`audit crash fixture exited before readiness: ${stderr}`);
      }
      await Bun.sleep(20);
    }
  }
  throw new Error("timed out waiting for audit crash fixture");
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

async function enqueueLifecycle(
  backend: SqliteAgentPersistence,
  captureFingerprint: string,
  outboxId: string,
  sourceObservationId: string,
): Promise<void> {
  await backend.auditOutbox.enqueue({
    outboxId,
    sourceObservationId,
    occurredAt: new Date().toISOString(),
    kind: "agent_lifecycle",
    captureLevel: "metadata",
    captureFingerprint,
    payload: { state: "opened" },
    createdAt: new Date().toISOString(),
  });
}
