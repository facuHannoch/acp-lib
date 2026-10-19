import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentConversationId, createAgentSessionId } from "../src/agent-ids.ts";
import { SqliteAgentPersistence, SQLITE_AGENT_SCHEMA_VERSION } from "../src/persistence/index.ts";

const opened: SqliteAgentPersistence[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((backend) => backend.close()));
  await Promise.allSettled(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function open(path?: string, agentSessionId = createAgentSessionId()) {
  const directory = path ? undefined : await mkdtemp(join(tmpdir(), "acp-adoption-storage-"));
  if (directory) directories.push(directory);
  const file = path ?? join(directory!, "agent.sqlite");
  const backend = await SqliteAgentPersistence.open({ path: file, agentSessionId });
  opened.push(backend);
  return { backend, path: file, agentSessionId };
}

const attach = (backend: SqliteAgentPersistence, conversationId: string, internalSessionId: string, at: string, id = `p-${internalSessionId}`) =>
  backend.providerSessions.append({
    providerSessionRecordId: id,
    agentConversationId: conversationId as never,
    internalSessionId,
    adapterId: "codex",
    mode: "normal",
    activatedAt: at,
  });

describe("adoption storage: the conversation row", () => {
  test("an adopted conversation stores that it is, and which provider session it asked for", async () => {
    const { backend, agentSessionId } = await open();
    const id = createAgentConversationId();
    const created = await backend.conversations.create({
      agentSessionId,
      agentConversationId: id,
      adoptProviderSessionId: "ses-1",
    });
    expect(created.adopted).toBe(true);
    expect(created.adoptProviderSessionId).toBe("ses-1");
    expect((await backend.conversations.get(id))?.adopted).toBe(true);
    expect((await backend.conversations.list()).conversations[0]).toMatchObject({ adopted: true, adoptProviderSessionId: "ses-1" });
  });

  test("an ordinary conversation carries no adoption fields", async () => {
    const { backend, agentSessionId } = await open();
    const id = createAgentConversationId();
    const created = await backend.conversations.create({ agentSessionId, agentConversationId: id });
    expect(created).not.toHaveProperty("adopted");
    expect(created).not.toHaveProperty("adoptProviderSessionId");
  });
});

describe("adoption storage: who owns a provider session", () => {
  test("an adoption that has not attached its session yet still holds its claim", async () => {
    const { backend, agentSessionId } = await open();
    const id = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: id, adoptProviderSessionId: "ses-1" });
    expect(await backend.providerSessions.conversationsUsing!("ses-1")).toEqual([id]);
    expect(await backend.providerSessions.conversationsUsing!("ses-other")).toEqual([]);
  });

  test("the active provider session of a conversation is owned by it", async () => {
    const { backend, agentSessionId } = await open();
    const id = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: id });
    await attach(backend, id, "ses-1", "2026-10-05T00:00:00.000Z");
    expect(await backend.providerSessions.conversationsUsing!("ses-1")).toEqual([id]);
  });

  test("a session the conversation moved away from is free again, and so is a claim it replaced", async () => {
    const { backend, agentSessionId } = await open();
    const id = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: id, adoptProviderSessionId: "ses-asked" });
    await attach(backend, id, "ses-first", "2026-10-05T00:00:00.000Z");
    // It attached a different session than the one it asked for: the claim no longer holds.
    expect(await backend.providerSessions.conversationsUsing!("ses-asked")).toEqual([]);
    expect(await backend.providerSessions.conversationsUsing!("ses-first")).toEqual([id]);
    await attach(backend, id, "ses-second", "2026-10-05T00:01:00.000Z");
    expect(await backend.providerSessions.conversationsUsing!("ses-first")).toEqual([]);
    expect(await backend.providerSessions.conversationsUsing!("ses-second")).toEqual([id]);
  });

  test("a deleted conversation owns nothing", async () => {
    const { backend, agentSessionId } = await open();
    const id = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: id, adoptProviderSessionId: "ses-1" });
    await attach(backend, id, "ses-1", "2026-10-05T00:00:00.000Z");
    await backend.conversations.delete(id);
    expect(await backend.providerSessions.conversationsUsing!("ses-1")).toEqual([]);
  });

  test("owners come back oldest first", async () => {
    const { backend, agentSessionId } = await open();
    const first = createAgentConversationId();
    const second = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: first, createdAt: "2026-10-05T00:00:00.000Z", adoptProviderSessionId: "ses-1" });
    await backend.conversations.create({ agentSessionId, agentConversationId: second, createdAt: "2026-10-05T00:01:00.000Z", adoptProviderSessionId: "ses-1" });
    expect(await backend.providerSessions.conversationsUsing!("ses-1")).toEqual([first, second]);
  });
});

describe("adoption storage: migrating a version 12 database", () => {
  test("adds the columns and the index, keeps existing conversations, and records version 13", async () => {
    const { backend, path, agentSessionId } = await open();
    const id = createAgentConversationId();
    await backend.conversations.create({ agentSessionId, agentConversationId: id, title: "kept" });
    await attach(backend, id, "ses-old", "2026-10-05T00:00:00.000Z");
    await backend.close();
    opened.splice(opened.indexOf(backend), 1);

    // Turn it into what a version 12 database looks like.
    const raw = new Database(path);
    raw.exec("DROP INDEX provider_sessions_internal_idx");
    raw.exec("ALTER TABLE conversations DROP COLUMN adopted");
    raw.exec("ALTER TABLE conversations DROP COLUMN adopt_provider_session_id");
    raw.exec("DELETE FROM schema_migrations WHERE version >= 13");
    raw.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (12, '2026-10-01T00:00:00.000Z')");
    expect(raw.query<{ v: number }, []>("SELECT MAX(version) AS v FROM schema_migrations").get()?.v).toBe(12);
    raw.close();

    const migrated = await open(path, agentSessionId);
    const columns = new Database(path, { readonly: true });
    const names = columns.query<{ name: string }, []>("PRAGMA table_info(conversations)").all().map((column) => column.name);
    expect(names).toContain("adopted");
    expect(names).toContain("adopt_provider_session_id");
    expect(columns.query<{ v: number }, []>("SELECT MAX(version) AS v FROM schema_migrations").get()?.v).toBe(SQLITE_AGENT_SCHEMA_VERSION);
    expect(columns.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'provider_sessions_internal_idx'").get()).not.toBeNull();
    columns.close();

    const summary = await migrated.backend.conversations.get(id);
    expect(summary?.title).toBe("kept");
    expect(summary).not.toHaveProperty("adopted");
    expect(await migrated.backend.providerSessions.conversationsUsing!("ses-old")).toEqual([id]);
  });
});
