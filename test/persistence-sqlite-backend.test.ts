import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentConversationId,
  createAgentSessionId,
  type AgentConversationId,
  type AgentSessionId,
} from "../src/agent-ids.ts";
import {
  IMPLICIT_USER_PARTICIPANT_ID,
  AgentDatabaseInUseError,
  PersistenceConflictError,
  SqliteAgentPersistence,
  SQLITE_AGENT_SCHEMA_VERSION,
  hasSafeConcurrentWal,
  requireSqliteSearch,
  type NewConversationRecord,
  type PersistenceExtension,
} from "../src/persistence/index.ts";
import { emptyMeteringState } from "../src/metering/state.ts";
import type { OperationMeteringRecord } from "../src/metering/record.ts";

const opened: SqliteAgentPersistence[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((backend) => backend.close()));
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("SQLite agent persistence", () => {
  test("owns an explicit path and refuses a different agent identity", async () => {
    const { backend, path, agentSessionId } = await openBackend();
    expect(backend.path).toBe(path);
    expect(backend.identityRecord.agentSessionId).toBe(agentSessionId);
    expect(backend.capabilities).toEqual({
      transactions: true,
      fullTextSearch: true,
      identity: true,
      auditOutbox: true,
      extensions: true,
      vectorSearch: false,
      metering: true,
    });

    await backend.close();
    opened.splice(opened.indexOf(backend), 1);
    await expect(SqliteAgentPersistence.open({
      path,
      agentSessionId: createAgentSessionId(),
    })).rejects.toBeInstanceOf(PersistenceConflictError);
  });

  test("reconstructs separate messages and persists participant continuity", async () => {
    const { backend, path, agentSessionId } = await openBackend();
    const conversationId = createAgentConversationId();
    const created = await backend.conversations.create({
      agentSessionId,
      agentConversationId: conversationId,
    });
    expect(created.participants).toEqual([{
      id: IMPLICIT_USER_PARTICIPANT_ID,
      kind: "user",
    }]);

    const records = await backend.records.appendMany([
      message(agentSessionId, conversationId, "m-1", "user", "first"),
      message(agentSessionId, conversationId, "m-2", "assistant", "second"),
      message(agentSessionId, conversationId, "m-3", "assistant", "third"),
    ]);
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);

    const page = await backend.messages.list(conversationId);
    expect(page.messages.map((record) => record.content)).toEqual(["first", "second", "third"]);
    expect(page.messages[0]?.participantId).toBe(IMPLICIT_USER_PARTICIPANT_ID);
    expect((await backend.conversations.get(conversationId))?.latestSequence).toBe(3);

    await backend.close();
    opened.splice(opened.indexOf(backend), 1);
    const reopened = await track(SqliteAgentPersistence.open({ path, agentSessionId }));
    expect((await reopened.messages.list(conversationId)).messages.map((record) => record.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("filters participants before pagination", async () => {
    const { backend, agentSessionId } = await openBackend();
    const conversationId = createAgentConversationId();
    await backend.conversations.create({
      agentSessionId,
      agentConversationId: conversationId,
      participants: [
        { id: "user-a", kind: "user" },
        { id: "user-b", kind: "user" },
      ],
    });
    await backend.records.appendMany([
      message(agentSessionId, conversationId, "m-a1", "user", "a1", "user-a"),
      message(agentSessionId, conversationId, "m-b1", "user", "b1", "user-b"),
      message(agentSessionId, conversationId, "m-a2", "user", "a2", "user-a"),
    ]);

    const first = await backend.messages.list(conversationId, {
      participantIds: ["user-a"],
      limit: 1,
    });
    expect(first.messages.map((record) => record.content)).toEqual(["a1"]);
    expect(first.nextCursor).toBeDefined();
    const second = await backend.messages.list(conversationId, {
      participantIds: ["user-a"],
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.messages.map((record) => record.content)).toEqual(["a2"]);
  });

  test("round-trips every record kind through typed subtype tables", async () => {
    const { backend, path, agentSessionId } = await openBackend();
    const conversationId = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: conversationId });
    const records: NewConversationRecord[] = [
      {
        ...message(
          agentSessionId,
          conversationId,
          "typed-message",
          "user",
          "hello",
          IMPLICIT_USER_PARTICIPANT_ID,
        ),
        status: "completed",
        metadata: JSON.stringify({ submittedBy: "bob" }),
      },
      {
        recordId: "typed-tool", agentSessionId, agentConversationId: conversationId,
        kind: "tool_call", timestamp: now(), toolCallId: "tool-1", state: "completed",
        name: "terminal.exec", input: { command: "bun test" }, output: [{ type: "text", text: "all green" }],
      },
      {
        recordId: "typed-permission", agentSessionId, agentConversationId: conversationId,
        kind: "permission", timestamp: now(), permissionId: "permission-1", state: "resolved",
        request: { command: "bun test" }, outcome: "approved",
      },
      {
        recordId: "typed-configuration", agentSessionId, agentConversationId: conversationId,
        kind: "configuration", timestamp: now(), operation: "set", configId: "model",
        value: "gpt-test", status: "completed",
      },
      {
        recordId: "typed-protocol", agentSessionId, agentConversationId: conversationId,
        kind: "protocol", timestamp: now(), direction: "in", method: "session/update",
        message: { jsonrpc: "2.0" },
      },
      {
        recordId: "typed-native", agentSessionId, agentConversationId: conversationId,
        kind: "native_action", timestamp: now(), action: "switch", transitionId: "switch-1",
        state: "completed", input: { from: "a" }, output: { to: "b" },
      },
      {
        recordId: "typed-agent", agentSessionId, agentConversationId: conversationId,
        kind: "agent_action", timestamp: now(), action: "send_message", state: "requested",
        input: { target: "atlas" },
      },
      {
        recordId: "typed-thinking", agentSessionId, agentConversationId: conversationId,
        kind: "thinking", timestamp: now(), thinkingId: "thinking-1", state: "completed",
        content: [{ type: "text", text: "consider alternatives" }],
      },
      {
        recordId: "typed-activity", agentSessionId, agentConversationId: conversationId,
        kind: "activity", timestamp: now(), activityId: "activity-1", activityType: "terminal",
        state: "completed", content: "compiled successfully", data: { exitCode: 0 },
      },
      {
        recordId: "typed-metering", agentSessionId, agentConversationId: conversationId,
        kind: "metering", timestamp: now(), operationId: "operation-1",
        meteringRecordId: "metering-1", status: "available",
      },
    ];

    const appended = await backend.records.appendMany(records);
    expect(appended.map(({ sequence: _sequence, ...record }) => record)).toEqual(records);
    expect((await backend.records.list(conversationId)).records).toEqual(appended);
    for (const record of appended) expect(await backend.records.get(record.recordId)).toEqual(record);

    const inspection = new Database(path, { readonly: true });
    try {
      const columns = inspection.query<{ name: string }, []>("PRAGMA table_info(conversation_records)")
        .all().map(({ name }) => name);
      expect(columns).not.toContain("payload_json");
      expect(columns).toContain("operation_id");
      for (const table of [
        "conversation_messages",
        "conversation_tool_call_events",
        "conversation_permission_events",
        "conversation_configuration_events",
        "conversation_protocol_records",
        "conversation_native_action_events",
        "conversation_agent_action_events",
        "conversation_thinking_events",
        "conversation_activity_events",
        "conversation_metering_references",
      ]) {
        expect(inspection.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count)
          .toBe(1);
      }
    } finally {
      inspection.close();
    }
  });

  test("serializes concurrent writes through one owner into a monotonic conversation sequence", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const agentSessionId = createAgentSessionId();
    const backend = await track(SqliteAgentPersistence.open({ path, agentSessionId }));
    const conversationId = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: conversationId });

    await Promise.all(Array.from({ length: 40 }, (_, index) => {
      return backend.records.append(message(
        agentSessionId,
        conversationId,
        `concurrent-${index}`,
        "assistant",
        `reply ${index}`,
      ));
    }));

    const page = await backend.records.list(conversationId, { limit: 100 });
    expect(page.records).toHaveLength(40);
    expect(page.records.map((record) => record.sequence)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
  });

  test("rejects a second runtime owner and releases ownership on close", async () => {
    const { backend, path, agentSessionId } = await openBackend();
    await expect(SqliteAgentPersistence.open({ path, agentSessionId })).rejects.toBeInstanceOf(
      AgentDatabaseInUseError,
    );

    await backend.close();
    opened.splice(opened.indexOf(backend), 1);
    const reopened = await track(SqliteAgentPersistence.open({ path, agentSessionId }));
    expect(reopened.identityRecord.agentSessionId).toBe(agentSessionId);
    expect((await stat(`${path}.agent-owner.sqlite`)).mode & 0o777).toBe(0o600);
  });

  test("releases cross-process ownership when the owner process terminates", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const readyPath = join(directory, "ready");
    const holder = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "fixtures", "sqlite-owner-holder.ts"),
      path,
      readyPath,
    ], { stdout: "ignore", stderr: "pipe" });

    try {
      await waitForPath(readyPath, holder);
      await expect(SqliteAgentPersistence.open({ path })).rejects.toBeInstanceOf(AgentDatabaseInUseError);
      holder.kill("SIGKILL");
      await holder.exited;
      const reopened = await track(SqliteAgentPersistence.open({ path }));
      expect(reopened.path).toBe(path);
    } finally {
      if (holder.exitCode === null) {
        holder.kill("SIGKILL");
        await holder.exited;
      }
    }
  });

  test("rolls back a multi-repository transaction", async () => {
    const { backend, agentSessionId } = await openBackend();
    const conversationId = createAgentConversationId();
    await expect(backend.transaction(async (transaction) => {
      await transaction.conversations.create({
        agentSessionId,
        agentConversationId: conversationId,
      });
      await transaction.records.append(
        message(agentSessionId, conversationId, "rolled-back", "assistant", "not committed"),
      );
      throw new Error("stop");
    })).rejects.toThrow("stop");
    expect(await backend.conversations.get(conversationId)).toBeNull();
    expect(await backend.records.get("rolled-back")).toBeNull();
  });

  test("searches records through an external-content FTS5 index", async () => {
    const { backend, path, agentSessionId } = await openBackend();
    const conversationId = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: conversationId });
    await backend.records.appendMany([
      message(agentSessionId, conversationId, "search-message", "user", "find the sapphire lighthouse"),
      {
        recordId: "search-tool",
        agentSessionId,
        agentConversationId: conversationId,
        kind: "tool_call",
        timestamp: now(),
        toolCallId: "call-1",
        state: "completed",
        name: "terminal.exec",
        input: { command: "bun test" },
        output: "all green",
      },
      {
        recordId: "search-activity",
        agentSessionId,
        agentConversationId: conversationId,
        kind: "activity",
        timestamp: now(),
        activityId: "activity-search",
        activityType: "terminal",
        state: "completed",
        content: "deployed nebula service",
      },
    ]);

    const search = requireSqliteSearch(backend);
    expect((await search.search({ text: "sapphire" })).map((match) => match.recordId)).toEqual([
      "search-message",
    ]);
    expect((await search.search({ text: "terminal", kinds: ["tool_call"] }))[0]?.recordId).toBe(
      "search-tool",
    );
    expect((await search.search({ text: "nebula", kinds: ["activity"] }))[0]?.recordId).toBe(
      "search-activity",
    );
    await search.integrityCheck();

    const inspection = new Database(path, { readonly: true });
    try {
      for (const name of [
        "conversation_messages_fts_content",
        "conversation_tool_calls_fts_content",
        "conversation_activities_fts_content",
      ]) {
        expect(inspection.query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE name = ?",
        ).get(name)).toBeNull();
      }
    } finally {
      inspection.close();
    }
  });

  test("persists checkpoints, provider sessions, identity state, and audit delivery", async () => {
    const { backend, agentSessionId } = await openBackend();
    const conversationId = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: conversationId });
    await backend.checkpoints.put({
      agentConversationId: conversationId,
      revision: 1,
      coveredSequence: 0,
      state: { phase: "ready" },
      updatedAt: now(),
    }, 0);
    await expect(backend.checkpoints.put({
      agentConversationId: conversationId,
      revision: 2,
      coveredSequence: 0,
      state: { phase: "wrong writer" },
      updatedAt: now(),
    }, 0)).rejects.toBeInstanceOf(PersistenceConflictError);

    await backend.providerSessions.append({
      providerSessionRecordId: "provider-1",
      agentConversationId: conversationId,
      internalSessionId: "internal-1",
      adapterId: "codex",
      mode: "normal",
      activatedAt: "2026-09-17T00:00:00.000Z",
    });
    await backend.providerSessions.append({
      providerSessionRecordId: "provider-2",
      agentConversationId: conversationId,
      internalSessionId: "internal-2",
      adapterId: "claude",
      mode: "normal",
      activatedAt: "2026-09-17T00:01:00.000Z",
    });
    expect((await backend.providerSessions.active(conversationId))?.adapterId).toBe("claude");
    expect((await backend.providerSessions.list(conversationId))[0]?.deactivatedAt).toBe(
      "2026-09-17T00:01:00.000Z",
    );

    const observations = await backend.identity.append([{
      memoryId: "memory-1",
      agentSessionId,
      sourceConversationId: conversationId,
      sourceRecordIds: [],
      kind: "fact",
      content: { value: "likes tea" },
      createdAt: now(),
    }]);
    expect(observations[0]?.sequence).toBe(1);
    await backend.identity.publishSnapshot({
      snapshotId: "snapshot-1",
      agentSessionId,
      version: 1,
      processedThroughSequence: 1,
      value: { profile: "tea drinker" },
      createdAt: now(),
    }, 0);
    expect(await backend.identity.projectionState()).toMatchObject({
      observedThroughSequence: 1,
      processedThroughSequence: 1,
      activeSnapshotId: "snapshot-1",
    });

    const auditState = await backend.auditOutbox.initialize(
      "audit-log-1",
      "a".repeat(64),
      "2026-09-17T00:00:00.000Z",
    );
    expect(auditState.lastAllocatedSequence).toBe(0);
    const auditItem = await backend.auditOutbox.enqueue({
      outboxId: "audit-1",
      sourceObservationId: "record-1",
      sourceRecordId: "record-1",
      agentConversationId: conversationId,
      occurredAt: now(),
      kind: "message",
      captureLevel: "metadata",
      captureFingerprint: "a".repeat(64),
      payload: { event: "prompt" },
      createdAt: now(),
    });
    expect(auditItem.auditSequence).toBe(1);
    expect(await backend.auditOutbox.pending()).toHaveLength(1);
    await backend.auditOutbox.markFailed("audit-1", "offline", "2099-01-01T00:00:00.000Z");
    expect(await backend.auditOutbox.pending()).toHaveLength(0);
    await backend.auditOutbox.retryHead();
    expect(await backend.auditOutbox.pending()).toHaveLength(1);
    const delivered = await backend.auditOutbox.acknowledge(["audit-1"]);
    expect(delivered.lastDeliveredSequence).toBe(1);
    expect(await backend.auditOutbox.pending()).toHaveLength(0);
  });

  test("allocates one audit sequence across conversations and deduplicates pending sources", async () => {
    const { backend, agentSessionId } = await openBackend();
    const firstConversationId = createAgentConversationId();
    const secondConversationId = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: firstConversationId });
    await backend.conversations.create({ agentSessionId, agentConversationId: secondConversationId });
    await backend.auditOutbox.initialize("audit-log-1", "a".repeat(64));

    const items = await Promise.all(Array.from({ length: 20 }, (_, index) => backend.auditOutbox.enqueue({
      outboxId: `outbox-${index}`,
      sourceObservationId: `source-${index}`,
      sourceRecordId: `source-${index}`,
      agentConversationId: index % 2 ? firstConversationId : secondConversationId,
      occurredAt: now(),
      kind: "message",
      captureLevel: "content",
      captureFingerprint: "a".repeat(64),
      payload: { index },
      createdAt: now(),
    })));
    expect(items.map((item) => item.auditSequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );

    const duplicate = await backend.auditOutbox.enqueue({
      outboxId: "a-new-ambiguous-attempt-id",
      sourceObservationId: "source-0",
      sourceRecordId: "source-0",
      agentConversationId: secondConversationId,
      occurredAt: items[0]!.occurredAt,
      kind: "message",
      captureLevel: "content",
      captureFingerprint: "a".repeat(64),
      payload: { index: 0 },
      createdAt: now(),
    });
    expect(duplicate.outboxId).toBe("outbox-0");
    expect((await backend.auditOutbox.state())?.lastAllocatedSequence).toBe(20);
    await expect(backend.auditOutbox.enqueue({
      outboxId: "conflicting-attempt",
      sourceObservationId: "source-0",
      sourceRecordId: "source-0",
      agentConversationId: secondConversationId,
      occurredAt: now(),
      kind: "message",
      captureLevel: "content",
      captureFingerprint: "a".repeat(64),
      payload: { index: 999 },
      createdAt: now(),
    })).rejects.toBeInstanceOf(PersistenceConflictError);
  });

  test("rolls back canonical records and audit enqueue together", async () => {
    const { backend, agentSessionId } = await openBackend();
    const conversationId = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: conversationId });
    await backend.auditOutbox.initialize("audit-log-1", "a".repeat(64));
    await expect(backend.transaction(async (persistence) => {
      await persistence.records.append(message(
        agentSessionId,
        conversationId,
        "atomic-record",
        "user",
        "atomic",
      ));
      await persistence.auditOutbox!.enqueue({
        outboxId: "atomic-audit",
        sourceObservationId: "atomic-record",
        sourceRecordId: "atomic-record",
        agentConversationId: conversationId,
        occurredAt: now(),
        kind: "message",
        captureLevel: "content",
        captureFingerprint: "a".repeat(64),
        payload: { content: "atomic" },
        createdAt: now(),
      });
      throw new Error("rollback both");
    })).rejects.toThrow("rollback both");
    expect(await backend.records.get("atomic-record")).toBeNull();
    expect(await backend.auditOutbox.head()).toBeNull();
    expect((await backend.auditOutbox.state())?.lastAllocatedSequence).toBe(0);
  });

  test("commits metering state idempotently with optional detailed record retention", async () => {
    const { backend, agentSessionId } = await openBackend();
    const conversationId = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: conversationId });
    const record = meteringRecord(agentSessionId, "meter-op-1", 1);

    const committed = await backend.metering.commit({
      agentConversationId: conversationId,
      record,
      meteringRecords: "all",
      updatedAt: "2026-09-17T00:00:00.000Z",
    });
    expect(committed.revision).toBe(1);
    expect(await backend.metering.get(conversationId, record.operationId)).toEqual(record);
    expect((await backend.metering.list(conversationId)).records).toEqual([record]);

    const duplicate = await backend.metering.commit({
      agentConversationId: conversationId,
      record,
      meteringRecords: "all",
    });
    expect(duplicate.revision).toBe(1);

    const second = meteringRecord(agentSessionId, "meter-op-2", 2);
    const stateOnly = await backend.metering.commit({
      agentConversationId: conversationId,
      record: second,
      meteringRecords: "none",
    });
    expect(stateOnly.revision).toBe(2);
    expect(await backend.metering.get(conversationId, second.operationId)).toBeNull();
    expect((await backend.metering.list(conversationId)).records).toEqual([record]);

    const stateOnlyDuplicate = await backend.metering.commit({
      agentConversationId: conversationId,
      record: second,
      meteringRecords: "none",
    });
    expect(stateOnlyDuplicate.revision).toBe(2);

    const saved = await backend.metering.saveState(
      conversationId,
      stateOnly.state,
      "2026-09-17T00:02:00.000Z",
    );
    expect(saved.revision).toBe(2);

    const third = meteringRecord(agentSessionId, "meter-op-3", 3);
    await backend.metering.commit({
      agentConversationId: conversationId,
      record: third,
      meteringRecords: { retain: 1 },
    });
    expect((await backend.metering.list(conversationId)).records).toEqual([third]);
    expect(await backend.metering.get(conversationId, record.operationId)).toBeNull();
    expect((await backend.metering.state(conversationId))?.state.operationCount).toBe(3);
  });

  test("migrates extensions once and notifies them only after committed records", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const agentSessionId = createAgentSessionId();
    const committed: string[][] = [];
    let migrations = 0;
    const extension: PersistenceExtension = {
      id: "test.notes",
      version: 1,
      async migrate(context) {
        migrations += 1;
        await context.execute("CREATE TABLE test_notes(value TEXT NOT NULL)");
      },
      async recordsCommitted(records) {
        committed.push(records.map((record) => record.recordId));
      },
    };
    const first = await track(SqliteAgentPersistence.open({ path, agentSessionId, extensions: [extension] }));
    const conversationId = createAgentConversationId();
    await first.conversations.create({ agentSessionId, agentConversationId: conversationId });
    await first.records.append(message(agentSessionId, conversationId, "extension-record", "assistant", "saved"));
    expect(committed).toEqual([["extension-record"]]);
    expect((await first.extensions.list())[0]?.schemaVersion).toBe(1);
    await first.close();
    opened.splice(opened.indexOf(first), 1);

    const second = await track(SqliteAgentPersistence.open({ path, agentSessionId, extensions: [extension] }));
    expect(migrations).toBe(1);
    expect((await second.extensions.get("test.notes"))?.schemaVersion).toBe(1);
  });

  test("recognizes only SQLite versions carrying the WAL reset fix", () => {
    expect(hasSafeConcurrentWal("3.53.0")).toBe(true);
    expect(hasSafeConcurrentWal("3.51.3")).toBe(true);
    expect(hasSafeConcurrentWal("3.50.7")).toBe(true);
    expect(hasSafeConcurrentWal("3.44.6")).toBe(true);
    expect(hasSafeConcurrentWal("3.51.2")).toBe(false);
    expect(hasSafeConcurrentWal("3.49.1")).toBe(false);
  });

  test("rejects the previous pre-release schema with a recreate instruction", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const old = new Database(path, { create: true, readwrite: true });
    old.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (7, '2026-09-17T00:00:00.000Z');
    `);
    old.close();
    expect(SQLITE_AGENT_SCHEMA_VERSION).toBe(8);
    await expect(SqliteAgentPersistence.open({ path })).rejects.toThrow(
      "SQLite agent schema 7 is incompatible with 8; recreate the database",
    );
  });
});

async function openBackend(): Promise<{
  backend: SqliteAgentPersistence;
  path: string;
  agentSessionId: AgentSessionId;
}> {
  const directory = await makeDirectory();
  const path = join(directory, "agent.sqlite");
  const agentSessionId = createAgentSessionId();
  const backend = await track(SqliteAgentPersistence.open({ path, agentSessionId }));
  return { backend, path, agentSessionId };
}

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acp-sqlite-"));
  directories.push(directory);
  return directory;
}

async function track(promise: Promise<SqliteAgentPersistence>): Promise<SqliteAgentPersistence> {
  const backend = await promise;
  opened.push(backend);
  return backend;
}

async function waitForPath(path: string, process_: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      if (process_.exitCode !== null) {
        const stderr = await new Response(process_.stderr).text();
        throw new Error(`SQLite owner fixture exited before acquiring ownership: ${stderr}`);
      }
      await Bun.sleep(20);
    }
  }
  throw new Error("timed out waiting for SQLite owner fixture");
}

function message(
  agentSessionId: AgentSessionId,
  agentConversationId: AgentConversationId,
  recordId: string,
  role: "assistant" | "user",
  content: string,
  participantId?: string,
): NewConversationRecord {
  return {
    recordId,
    agentSessionId,
    agentConversationId,
    kind: "message",
    timestamp: now(),
    role,
    content,
    ...(participantId ? { participantId } : {}),
  };
}

function meteringRecord(
  agentSessionId: AgentSessionId,
  operationId: string,
  operationCount: number,
): OperationMeteringRecord {
  const state = emptyMeteringState(agentSessionId);
  return Object.freeze({
    operationId,
    operationKind: "prompt",
    outcome: "completed",
    startedAt: 1,
    completedAt: 2,
    agentSessionId,
    internalSessionId: "internal-metering-1",
    provider: { adapterId: "test", providerId: null, model: null },
    provenance: {
      source: "none",
      measurement: "unavailable",
      routing: "unknown",
      attribution: "unavailable",
    },
    usage: { status: "usage_unavailable", reason: "test fixture" },
    pricingStatus: "not_attributable",
    contextAfter: null,
    providerCostAfter: null,
    costReconciliation: { status: "unavailable", reason: "test fixture" },
    nextState: Object.freeze({ ...state, operationCount }),
  });
}

function now(): string {
  return new Date().toISOString();
}
