import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { access, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  test("pages recent mixed records by sequence at a stable snapshot", async () => {
    const { backend, agentSessionId } = await openBackend();
    const conversationId = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: conversationId });
    for (let index = 1; index <= 6; index++) {
      await backend.records.append(message(agentSessionId, conversationId, `page-${index}`, "user", String(index)));
    }
    const first = await backend.records.listRecent!(conversationId, { limit: 2 });
    expect(first.records.map((record) => record.sequence)).toEqual([5, 6]);
    expect(first.snapshotSequence).toBe(6);
    await backend.records.append(message(agentSessionId, conversationId, "page-7", "user", "7"));
    const second = await backend.records.listRecent!(conversationId, { limit: 2, olderCursor: first.olderCursor });
    expect(second.records.map((record) => record.sequence)).toEqual([3, 4]);
    const third = await backend.records.listRecent!(conversationId, { limit: 2, olderCursor: second.olderCursor });
    expect(third.records.map((record) => record.sequence)).toEqual([1, 2]);
    expect(third.olderCursor).toBeUndefined();
    expect((await backend.records.list(conversationId, { afterSequence: first.snapshotSequence })).records
      .map((record) => record.sequence)).toEqual([7]);
    await expect(backend.records.listRecent!(conversationId, {
      kinds: ["message"], olderCursor: first.olderCursor,
    })).rejects.toThrow("invalid or mismatched recent-record cursor");
  });

  test("reads batched previews without treating an agent prompt as a human message", async () => {
    const { backend, agentSessionId } = await openBackend();
    const humanConversation = createAgentConversationId();
    const agentConversation = createAgentConversationId();
    const emptyConversation = createAgentConversationId();
    await backend.conversations.create({
      agentSessionId, agentConversationId: humanConversation,
      participants: [{ id: "human-1", kind: "user" }, { id: "bob-1", kind: "agent" }],
    });
    await backend.conversations.create({
      agentSessionId, agentConversationId: agentConversation,
      participants: [{ id: "bob-1", kind: "agent" }],
    });
    await backend.conversations.create({ agentSessionId, agentConversationId: emptyConversation });
    const humanAt = "2026-09-19T01:00:00.000Z";
    await backend.records.append({
      ...message(agentSessionId, humanConversation, "human-msg", "user", "Hello human", "human-1"),
      timestamp: humanAt,
    });
    await backend.records.append(message(agentSessionId, humanConversation, "agent-msg", "user", "Hello from Bob", "bob-1"));
    await backend.records.append(message(agentSessionId, humanConversation, "assistant-msg", "assistant", "The answer"));
    await backend.records.append(message(agentSessionId, agentConversation, "agent-only", "user", "Agent-only request", "bob-1"));

    const page = await backend.conversations.listPreviews!({ limit: 10 });
    const previews = new Map(page.previews.map((preview) => [preview.conversation.agentConversationId, preview]));
    expect(previews.get(humanConversation)?.latestMessage).toMatchObject({
      recordId: "assistant-msg", role: "assistant", text: "The answer",
    });
    expect(previews.get(humanConversation)?.lastHumanMessageAt).toBe(humanAt);
    expect(previews.get(agentConversation)?.latestMessage?.participantId).toBe("bob-1");
    expect(previews.get(agentConversation)?.lastHumanMessageAt).toBeUndefined();
    expect(previews.get(emptyConversation)?.latestMessage).toBeUndefined();
    const firstPage = await backend.conversations.listPreviews!({ limit: 2 });
    expect(firstPage.previews).toHaveLength(2);
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = await backend.conversations.listPreviews!({ limit: 2, cursor: firstPage.nextCursor });
    expect(secondPage.previews).toHaveLength(1);
    expect(new Set([...firstPage.previews, ...secondPage.previews]
      .map((preview) => preview.conversation.agentConversationId)).size).toBe(3);
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
        consumerMetadata: { deliveryId: "delivery-1" },
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

  test("canonicalizes a database symlink before enforcing ownership", async () => {
    const { backend, path, agentSessionId } = await openBackend();
    const alias = join(dirname(path), "agent-alias.sqlite");
    await symlink(path, alias);
    await expect(SqliteAgentPersistence.open({ path: alias, agentSessionId })).rejects.toBeInstanceOf(
      AgentDatabaseInUseError,
    );
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
    expect(SQLITE_AGENT_SCHEMA_VERSION).toBe(13);
    await expect(SqliteAgentPersistence.open({ path })).rejects.toThrow(
      "SQLite agent schema 7 is incompatible with 13; recreate the database",
    );
  });

  test("migrates a version-8 agent database without losing conversations", async () => {
    const { backend, path, agentSessionId } = await openBackend();
    const conversationId = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: conversationId });
    await backend.records.append(message(agentSessionId, conversationId, "before-migration", "user", "retained"));
    await backend.close();
    opened.splice(opened.indexOf(backend), 1);

    const old = new Database(path, { readwrite: true });
    old.exec(`
      DROP TABLE identity_delivery_cursors;
      DROP INDEX conversation_messages_logical_idx;
      ALTER TABLE conversation_messages DROP COLUMN logical_message_id;
      ALTER TABLE conversation_messages DROP COLUMN consumer_metadata_json;
      ALTER TABLE conversations DROP COLUMN last_human_message_at;
      DROP INDEX provider_sessions_internal_idx;
      ALTER TABLE conversations DROP COLUMN adopted;
      ALTER TABLE conversations DROP COLUMN adopt_provider_session_id;
      DELETE FROM schema_migrations WHERE version >= 9;
      INSERT INTO schema_migrations(version, applied_at) VALUES (8, '2026-09-18T00:00:00.000Z');
    `);
    old.close();

    const migrated = await track(SqliteAgentPersistence.open({ path, agentSessionId }));
    expect((await migrated.messages.list(conversationId)).messages.map((record) => record.content)).toEqual(["retained"]);
    const targetConversationId = createAgentConversationId();
    await migrated.conversations.create({ agentSessionId, agentConversationId: targetConversationId });
    await migrated.identityDelivery.advance([{
      targetConversationId,
      targetProviderContextId: "provider-1",
      sourceConversationId: conversationId,
      deliveredThroughSequence: 1,
    }]);
    expect((await migrated.identityDelivery.get(targetConversationId, "provider-1", conversationId))?.deliveredThroughSequence).toBe(1);
    const inspection = new Database(path, { readonly: true });
    expect(inspection.query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_migrations").get()?.version).toBe(13);
    expect(inspection.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM identity_delivery_cursors").get()?.count).toBe(1);
    inspection.close();
  });

  test("migrates version 9 to message consumer metadata without changing existing records", async () => {
    const { backend, path, agentSessionId } = await openBackend();
    const conversationId = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: conversationId });
    await backend.records.append(message(agentSessionId, conversationId, "old-message", "user", "retained"));
    await backend.close();
    opened.splice(opened.indexOf(backend), 1);

    const old = new Database(path, { readwrite: true });
    old.exec(`
      DROP INDEX conversation_messages_logical_idx;
      ALTER TABLE conversation_messages DROP COLUMN logical_message_id;
      ALTER TABLE conversation_messages DROP COLUMN consumer_metadata_json;
      ALTER TABLE conversations DROP COLUMN last_human_message_at;
      DROP INDEX provider_sessions_internal_idx;
      ALTER TABLE conversations DROP COLUMN adopted;
      ALTER TABLE conversations DROP COLUMN adopt_provider_session_id;
      DELETE FROM schema_migrations WHERE version >= 10;
      INSERT INTO schema_migrations(version, applied_at) VALUES (9, '2026-09-19T00:00:00.000Z');
    `);
    old.close();

    const migrated = await track(SqliteAgentPersistence.open({ path, agentSessionId }));
    expect((await migrated.messages.list(conversationId)).messages[0]).toMatchObject({ content: "retained" });
    expect((await migrated.messages.list(conversationId)).messages[0]?.consumerMetadata).toBeUndefined();
    expect((await migrated.conversations.listPreviews!()).previews[0]?.lastHumanMessageAt).toBeDefined();
    await migrated.records.append({
      ...message(agentSessionId, conversationId, "new-message", "user", "with metadata"),
      consumerMetadata: { deliveryId: "d-1" },
    });
    expect((await migrated.messages.list(conversationId)).messages[1]?.consumerMetadata).toEqual({ deliveryId: "d-1" });
  });

  test("migrates version 10 to assistant-message revision identity", async () => {
    const { backend, path, agentSessionId } = await openBackend();
    const conversationId = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: conversationId });
    await backend.records.append(message(agentSessionId, conversationId, "legacy", "assistant", "retained"));
    await backend.close();
    opened.splice(opened.indexOf(backend), 1);

    const old = new Database(path, { readwrite: true });
    old.exec(`
      DROP INDEX conversation_messages_logical_idx;
      ALTER TABLE conversation_messages DROP COLUMN logical_message_id;
      DROP INDEX provider_sessions_internal_idx;
      ALTER TABLE conversations DROP COLUMN adopted;
      ALTER TABLE conversations DROP COLUMN adopt_provider_session_id;
      DELETE FROM schema_migrations WHERE version >= 11;
      INSERT INTO schema_migrations(version, applied_at) VALUES (10, '2026-09-19T00:00:00.000Z');
    `);
    old.close();

    const migrated = await track(SqliteAgentPersistence.open({ path, agentSessionId }));
    expect((await migrated.messages.list(conversationId)).messages[0]).toMatchObject({ content: "retained" });
    expect((await migrated.messages.list(conversationId)).messages[0]?.logicalMessageId).toBeUndefined();
    await migrated.records.append({
      ...message(agentSessionId, conversationId, "new-snapshot", "assistant", "new"),
      logicalMessageId: "logical-new",
      status: "in_progress",
    });
    await migrated.records.append({
      ...message(agentSessionId, conversationId, "new-final", "assistant", "new final"),
      logicalMessageId: "logical-new",
      status: "completed",
    });
    expect((await migrated.messages.list(conversationId)).messages.map((record) => record.content))
      .toEqual(["retained", "new final"]);
  });

  test("migrates version 11 to the error record kind without losing records", async () => {
    const { backend, path, agentSessionId } = await openBackend();
    const conversationId = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: conversationId });
    await backend.records.append(message(agentSessionId, conversationId, "before-v12", "user", "retained"));
    await backend.close();
    opened.splice(opened.indexOf(backend), 1);

    const old = new Database(path, { readwrite: true });
    old.exec(`
      DROP TABLE conversation_error_records;
      CREATE TABLE conversation_records_v11 (
        row_id INTEGER PRIMARY KEY,
        record_id TEXT NOT NULL UNIQUE,
        agent_session_id TEXT NOT NULL,
        agent_conversation_id TEXT NOT NULL REFERENCES conversations(agent_conversation_id),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        kind TEXT NOT NULL CHECK (kind IN (
          'message','tool_call','permission','configuration','protocol',
          'native_action','agent_action','thinking','activity','metering'
        )),
        timestamp TEXT NOT NULL,
        operation_id TEXT,
        metadata TEXT,
        UNIQUE (agent_conversation_id, sequence)
      );
      INSERT INTO conversation_records_v11
        SELECT row_id, record_id, agent_session_id, agent_conversation_id, sequence, kind, timestamp, operation_id, metadata
        FROM conversation_records;
      DROP TABLE conversation_records;
      ALTER TABLE conversation_records_v11 RENAME TO conversation_records;
      CREATE INDEX conversation_records_kind_idx ON conversation_records(agent_conversation_id, kind, sequence);
      CREATE INDEX conversation_records_time_idx ON conversation_records(timestamp, agent_conversation_id);
      CREATE INDEX conversation_records_operation_idx
        ON conversation_records(agent_conversation_id, operation_id, sequence) WHERE operation_id IS NOT NULL;
      DROP INDEX provider_sessions_internal_idx;
      ALTER TABLE conversations DROP COLUMN adopted;
      ALTER TABLE conversations DROP COLUMN adopt_provider_session_id;
      DELETE FROM schema_migrations WHERE version >= 12;
      INSERT INTO schema_migrations(version, applied_at) VALUES (11, '2026-09-20T00:00:00.000Z');
    `);
    old.close();

    const migrated = await track(SqliteAgentPersistence.open({ path, agentSessionId }));
    expect((await migrated.messages.list(conversationId)).messages[0]).toMatchObject({ content: "retained" });
    await migrated.records.append({
      recordId: "error-1",
      agentSessionId,
      agentConversationId: conversationId,
      kind: "error",
      timestamp: new Date().toISOString(),
      source: "provider_session",
      code: "provider_session_missing",
      recoverability: "recoverable",
      message: "The provider session could not be loaded.",
      internalSessionId: "missing-thread",
      operationId: "op-load-1",
    });
    const stored = (await migrated.records.list(conversationId, { kinds: ["error"] })).records;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      kind: "error",
      source: "provider_session",
      code: "provider_session_missing",
      recoverability: "recoverable",
      message: "The provider session could not be loaded.",
      internalSessionId: "missing-thread",
      operationId: "op-load-1",
    });
    const inspection = new Database(path, { readonly: true });
    expect(inspection.query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_migrations").get()?.version).toBe(13);
    expect(inspection.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM conversation_records").get()?.count).toBe(2);
    inspection.close();
  });

  test("keeps sparse identity delivery cursors monotonic and provider-scoped", async () => {
    const { backend, agentSessionId } = await openBackend();
    const sourceConversationId = createAgentConversationId();
    const targetConversationId = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: sourceConversationId });
    await backend.conversations.create({ agentSessionId, agentConversationId: targetConversationId });
    await backend.records.appendMany([
      message(agentSessionId, sourceConversationId, "identity-1", "user", "one"),
      message(agentSessionId, sourceConversationId, "identity-2", "assistant", "two"),
    ]);

    expect(await backend.identityDelivery.get(targetConversationId, "provider-1", sourceConversationId)).toBeNull();
    await backend.identityDelivery.advance([{
      targetConversationId,
      targetProviderContextId: "provider-1",
      sourceConversationId,
      deliveredThroughSequence: 2,
    }]);
    await backend.identityDelivery.advance([{
      targetConversationId,
      targetProviderContextId: "provider-1",
      sourceConversationId,
      deliveredThroughSequence: 1,
    }]);
    expect((await backend.identityDelivery.get(targetConversationId, "provider-1", sourceConversationId))?.deliveredThroughSequence).toBe(2);
    expect(await backend.identityDelivery.get(targetConversationId, "provider-2", sourceConversationId)).toBeNull();
    await backend.identityDelivery.reset(targetConversationId, "provider-1");
    expect(await backend.identityDelivery.get(targetConversationId, "provider-1", sourceConversationId)).toBeNull();
    await expect(backend.identityDelivery.advance([{
      targetConversationId: sourceConversationId,
      targetProviderContextId: "provider-1",
      sourceConversationId,
      deliveredThroughSequence: 1,
    }])).rejects.toThrow("itself");
    await expect(backend.identityDelivery.advance([{
      targetConversationId,
      targetProviderContextId: "provider-1",
      sourceConversationId,
      deliveredThroughSequence: 3,
    }])).rejects.toThrow("exceed source");
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
