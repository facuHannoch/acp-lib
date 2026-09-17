import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
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
  PersistenceConflictError,
  SqliteAgentPersistence,
  hasSafeConcurrentWal,
  requireSqliteSearch,
  type NewConversationRecord,
  type PersistenceExtension,
} from "../src/persistence/index.ts";

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

  test("serializes concurrent writers into one monotonic conversation sequence", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "agent.sqlite");
    const agentSessionId = createAgentSessionId();
    const first = await track(SqliteAgentPersistence.open({ path, agentSessionId }));
    const second = await track(SqliteAgentPersistence.open({ path, agentSessionId }));
    const conversationId = createAgentConversationId();
    await first.conversations.create({ agentSessionId, agentConversationId: conversationId });

    await Promise.all(Array.from({ length: 40 }, (_, index) => {
      const backend = index % 2 === 0 ? first : second;
      return backend.records.append(message(
        agentSessionId,
        conversationId,
        `concurrent-${index}`,
        "assistant",
        `reply ${index}`,
      ));
    }));

    const page = await first.records.list(conversationId, { limit: 100 });
    expect(page.records).toHaveLength(40);
    expect(page.records.map((record) => record.sequence)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
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
    ]);

    const search = requireSqliteSearch(backend);
    expect((await search.search({ text: "sapphire" })).map((match) => match.recordId)).toEqual([
      "search-message",
    ]);
    expect((await search.search({ text: "terminal", kinds: ["tool_call"] }))[0]?.recordId).toBe(
      "search-tool",
    );
    await search.integrityCheck();

    const inspection = new Database(path, { readonly: true });
    try {
      const shadow = inspection.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE name = 'conversation_record_fts_content'",
      ).get();
      expect(shadow).toBeNull();
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

    await backend.auditOutbox.enqueue({
      outboxId: "audit-1",
      recordId: "record-1",
      destinationId: "compliance",
      payload: { event: "prompt" },
      createdAt: now(),
      attemptCount: 0,
    });
    expect(await backend.auditOutbox.pending()).toHaveLength(1);
    await backend.auditOutbox.markFailed("audit-1", "offline", "2099-01-01T00:00:00.000Z");
    expect(await backend.auditOutbox.pending()).toHaveLength(0);
    await backend.auditOutbox.markDelivered("audit-1");
    expect(await backend.auditOutbox.pending()).toHaveLength(0);
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

function now(): string {
  return new Date().toISOString();
}
