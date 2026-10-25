import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "../src/agent.ts";
import type { PersistedMediaBlock } from "../src/persistence/backend.ts";
import type { AgentConfig } from "../src/agent/config.ts";
import type { MediaStore, StoredMedia } from "../src/media/store.ts";

const roots: string[] = [];
const agents: Agent[] = [];

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function agentConfig(
  root: string,
  store?: MediaStore,
  extras: Pick<AgentConfig, "capture" | "conversationPersistence"> = {},
  fixtureArgs: readonly string[] = [],
): AgentConfig {
  return {
    persistence: { kind: "sqlite", path: join(root, "agent.sqlite") },
    adapters: { fixture: { command: ["bun", resolve(import.meta.dir, "fixtures/media-agent.ts"), ...fixtureArgs] } },
    defaultAdapterId: "fixture",
    ...extras,
    ...(store ? { media: { store } } : {}),
    conversationDefaults: { metering: { pricing: false } },
  };
}

async function setup(
  store?: MediaStore,
  extras: Pick<AgentConfig, "capture" | "conversationPersistence"> = {},
  fixtureArgs: readonly string[] = [],
) {
  const root = await mkdtemp(join(tmpdir(), "media-agent-"));
  roots.push(root);
  const agent = await Agent.open(agentConfig(root, store, extras, fixtureArgs));
  agents.push(agent);
  return { agent, root };
}

/** A consumer store kept in memory. */
function memoryStore(): MediaStore {
  const values = new Map<string, StoredMedia & { data: Uint8Array }>();
  return {
    async put(data, info) {
      const ref = crypto.randomUUID();
      values.set(ref, { ref, info, data: new Uint8Array(data) });
      return ref;
    },
    async get(ref) {
      return values.get(ref) ?? null;
    },
    async delete(ref) {
      values.delete(ref);
    },
    async list(owner) {
      return [...values.values()].filter((value) => value.info.owner === owner);
    },
  };
}

test("Agent stores user media atomically, reuses refs and deletes only bytes", async () => {
  const { agent } = await setup();
  const conversation = await agent.conversations.create();
  await conversation.prompt({ parts: [{ kind: "text", text: "look" }, { kind: "image", data: new Uint8Array([1, 2]), name: "plot.png", mimeType: "image/png" }] });
  const page = await agent.persistence.messages.list(conversation.id);
  const user = page.messages.find((m) => m.role === "user")!;
  expect(user.content).toMatchObject([{ type: "text", text: "look" }, { type: "media", kind: "image", size: 2 }]);
  const media = (user.content as readonly unknown[])[1] as PersistedMediaBlock;
  expect((await agent.persistence.media!.get(media.ref!))?.data).toEqual(new Uint8Array([1, 2]));
  await conversation.prompt({ parts: [{ kind: "image", ref: media.ref! }] });
  expect(await agent.persistence.media!.list(conversation.id)).toHaveLength(1);
  await agent.deleteMedia(media.ref!);
  expect(await agent.persistence.media!.get(media.ref!)).toBeNull();
  expect((await agent.persistence.records.get(user.recordId))?.kind).toBe("message");
  await expect(conversation.prompt({ parts: [{ kind: "image", ref: media.ref! }] })).rejects.toThrow("missing or removed");
});

test("SQLite rolls back bytes with records and clearing records deletes conversation media", async () => {
  const { agent } = await setup();
  const conversation = await agent.conversations.create();
  await expect(agent.persistence.transaction(async (scope) => {
    await scope.media!.put(new Uint8Array([1]), { owner: conversation.id, kind: "file", mimeType: "application/octet-stream", size: 1, sha256: "test" });
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect(await agent.persistence.media!.list(conversation.id)).toHaveLength(0);
  await conversation.prompt({ parts: [{ kind: "image", data: new Uint8Array([1]), mimeType: "image/png" }] });
  expect(await agent.persistence.media!.list(conversation.id)).toHaveLength(1);
  await agent.persistence.records.deleteForConversation!(conversation.id);
  expect(await agent.persistence.media!.list(conversation.id)).toHaveLength(0);
});

test("schema 15 upgrades to media storage while retaining text history", async () => {
  const { agent, root } = await setup();
  const conversation = await agent.conversations.create();
  await conversation.prompt("retained text");
  const id = conversation.id;
  await agent.persistence.records.append({ recordId: "legacy-media", agentSessionId: agent.id,
    agentConversationId: id, kind: "message", timestamp: new Date().toISOString(), role: "user",
    content: [{ type: "image", mimeType: "image/png", data: "legacybase64marker" },
      { type: "json", value: { text: "visiblelegacytext", ref: "legacyrefmarker" } }] });
  await agent.close();
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(root, "agent.sqlite"));
  db.exec("UPDATE conversation_messages SET search_text = 'legacybase64marker legacyrefmarker visiblelegacytext' WHERE content_json IS NOT NULL");
  db.exec("INSERT INTO conversation_messages_fts(conversation_messages_fts) VALUES ('rebuild')");
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM conversation_messages_fts WHERE conversation_messages_fts MATCH 'legacybase64marker'").get()!.n).toBe(1);
  db.exec("DROP TABLE conversation_media; DELETE FROM schema_migrations WHERE version >= 16; INSERT INTO schema_migrations(version, applied_at) VALUES (15, '2026-10-24T00:00:00.000Z')");
  db.close();
  const { SqliteAgentPersistence } = await import("../src/persistence/sqlite-backend.ts");
  const backend = await SqliteAgentPersistence.open({ path: join(root, "agent.sqlite") });
  try {
    expect((await backend.messages.list(id)).messages.some((m) => m.content === "retained text")).toBe(true);
    expect(await backend.media.list(id)).toHaveLength(0);
    expect(await backend.search!.search({ text: "legacybase64marker" })).toHaveLength(0);
    expect(await backend.search!.search({ text: "legacyrefmarker" })).toHaveLength(0);
    expect(await backend.search!.search({ text: "visiblelegacytext" })).toHaveLength(1);
    expect(await backend.records.get("legacy-media")).toMatchObject({ content: [{ type: "image", data: "legacybase64marker" }, { type: "json" }] });
    const ref = await backend.media.put(new Uint8Array([3]), { owner: id, kind: "file", mimeType: "application/pdf", size: 1, sha256: "hash" });
    expect((await backend.media.get(ref))?.data).toEqual(new Uint8Array([3]));
  } finally { await backend.close(); }
});


test("a custom store failure refuses the prompt before writing user history or sending", async () => {
  const { agent } = await setup({
    async put() { throw new Error("store unavailable"); }, async get() { return null; },
    async delete() {}, async list() { return []; },
  });
  const conversation = await agent.conversations.create();
  await expect(conversation.prompt({ parts: [{ kind: "image", data: new Uint8Array([1]), mimeType: "image/png" }] })).rejects.toThrow("store unavailable");
  expect((await agent.persistence.messages.list(conversation.id)).messages).toHaveLength(0);
  expect(await agent.persistence.media!.list(conversation.id)).toHaveLength(0);
});


test("media capture defaults, overrides and text independence apply on the Agent path", async () => {
  const { agent } = await setup(undefined, { capture: { message: "none", media: "metadata" },
    conversationPersistence: ({ title }) => title === "hidden" ? { capture: { media: "none" } } : undefined });
  const normal = await agent.conversations.create();
  await normal.prompt({ parts: [
    { kind: "text", text: "not recorded" },
    { kind: "image", data: new Uint8Array([1]), mimeType: "image/png" },
    { kind: "image", data: new Uint8Array([2]), mimeType: "image/png", keep: true },
    { kind: "image", data: new Uint8Array([3]), mimeType: "image/png", record: false },
  ] });
  const user = (await agent.persistence.messages.list(normal.id)).messages.find((m) => m.role === "user")!;
  expect(user.content).toMatchObject([{ type: "media" }, { type: "media", ref: expect.any(String) }]);
  expect(JSON.stringify(user.content)).not.toContain("not recorded");
  expect(await agent.persistence.media!.list(normal.id)).toHaveLength(1);
  const hidden = await agent.conversations.create({ title: "hidden" });
  await hidden.prompt({ parts: [{ kind: "image", data: new Uint8Array([1]), mimeType: "image/png" }] });
  expect(await agent.persistence.media!.list(hidden.id)).toHaveLength(0);
  expect((await agent.persistence.messages.list(hidden.id)).messages).toHaveLength(0);
});

test("Agent stores media output once across snapshots, final records and session reload", async () => {
  const { agent } = await setup();
  const conversation = await agent.conversations.create();
  const result = await conversation.prompt("MEDIA_OUTPUT");
  expect(result.messages[0]!.parts?.map((p) => p.kind)).toEqual(["image", "text", "audio", "file", "file", "file"]);
  expect(await agent.persistence.media!.list(conversation.id)).toHaveLength(4);
  const assistants = (await agent.persistence.messages.list(conversation.id)).messages.filter((m) => m.role === "assistant");
  const final = assistants.at(-1)!;
  expect(final.content).toMatchObject([{ type: "media", kind: "image", ref: expect.any(String) }, { type: "text", text: "after image" }, { type: "media", kind: "audio" }, { type: "media", mode: "link" }, { type: "media", kind: "file" }, { type: "media", kind: "file" }]);
  expect(JSON.stringify(final.content)).not.toContain('"data"');
  await conversation.stop();
  const reopened = await agent.conversations.open(conversation.id);
  expect(reopened).toBeDefined();
  expect(await agent.persistence.media!.list(conversation.id)).toHaveLength(4);
});

test("partial media survives a failed provider turn", async () => {
  const { agent } = await setup();
  const conversation = await agent.conversations.create();
  await expect(conversation.prompt("MEDIA_OUTPUT FAIL_AFTER_MEDIA")).rejects.toThrow("failed after media");
  const messages = (await agent.persistence.messages.list(conversation.id)).messages;
  expect(messages.some((m) => m.role === "assistant" && m.status === "failed" && Array.isArray(m.content) && m.content.some((b) => b.type === "media"))).toBe(true);
  expect(await agent.persistence.media!.list(conversation.id)).toHaveLength(4);
});

test("out-of-band media delivers once, retries failures, and never writes unkept bytes", async () => {
  const { agent } = await setup();
  const conversation = await agent.conversations.create();
  const record = await agent.conversations.appendAssistantMessage(conversation.id, { parts: [{ kind: "image", data: new Uint8Array([1]), mimeType: "image/png", keep: false }] });
  expect(record.operationId).toBeUndefined();
  expect(record.content).toMatchObject([{ type: "media", mode: "copy" }]);
  expect(await agent.persistence.media!.list(conversation.id)).toHaveLength(0); // waits in memory
  await expect(conversation.prompt("FAIL_TURN")).rejects.toThrow();
  const delivered = JSON.parse((await conversation.prompt("after")).text);
  expect(delivered.blocks.some((b: { type: string }) => b.type === "image")).toBe(true);
  expect(delivered.prompt).toContain(record.recordId);
  expect(await agent.persistence.media!.list(conversation.id)).toHaveLength(0);
  expect(JSON.parse((await conversation.prompt("later")).text).blocks.some((b: { type: string }) => b.type === "image")).toBe(false);
});

test("after a restart, unkept out-of-band media is named instead of sent", async () => {
  const { agent, root } = await setup();
  const conversation = await agent.conversations.create();
  await agent.conversations.appendAssistantMessage(conversation.id, { parts: [{ kind: "image", data: new Uint8Array([7]), mimeType: "image/png", keep: false }] });
  await agent.close();
  const reopened = await Agent.open(agentConfig(root));
  agents.push(reopened);
  const result = await reopened.conversations.open(conversation.id);
  const delivered = JSON.parse((await result.conversation.prompt("after restart")).text);
  expect(delivered.blocks.some((block: { type: string }) => block.type === "image")).toBe(false);
  expect(delivered.prompt).toContain("[image: not available]");
  expect(await reopened.persistence.media!.list(conversation.id)).toHaveLength(0);
});

test("out-of-band delivery advances even when message text capture is disabled", async () => {
  const { agent } = await setup(undefined, { capture: { message: "none" } });
  const conversation = await agent.conversations.create();
  await agent.conversations.appendAssistantMessage(conversation.id, { parts: [{ kind: "image", data: new Uint8Array([8]), mimeType: "image/png" }] });
  expect(JSON.parse((await conversation.prompt("first")).text).blocks.some((b: { type: string }) => b.type === "image")).toBe(true);
  expect(JSON.parse((await conversation.prompt("second")).text).blocks.some((b: { type: string }) => b.type === "image")).toBe(false);
});

test("files listing folds response revisions and searches only metadata with conversation filters", async () => {
  const { agent } = await setup();
  const one = await agent.conversations.create();
  const two = await agent.conversations.create();
  await one.prompt({ parts: [{ kind: "text", text: "searchable-paste" }, { kind: "image", data: new Uint8Array([1, 2]), name: "unique-chart.png", mimeType: "image/png" }] });
  await two.prompt("MEDIA_OUTPUT");
  const files = agent.persistence.files!;
  expect((await files.list()).files).toHaveLength(6); // one user image; five assistant media parts
  expect((await files.list({ agentConversationId: one.id })).files).toHaveLength(1);
  expect((await files.search({ text: "unique-chart" })).files).toHaveLength(1);
  expect((await files.search({ text: "application/pdf" })).files).toHaveLength(2);
  expect((await files.list({ kind: "audio" })).files).toHaveLength(1);
  expect((await files.list({ mimeType: "image/png", minSize: 2, maxSize: 2 })).files).toHaveLength(2);
  expect((await files.list({ name: "%" })).files).toHaveLength(0); // literal, not a SQL wildcard
  const paged = [];
  let cursor: string | undefined;
  do { const page = await files.list({ limit: 2, cursor }); paged.push(...page.files); cursor = page.nextCursor; } while (cursor);
  expect(new Set(paged.map((file) => `${file.recordId}:${file.partIndex}`)).size).toBe(6);
  expect((await agent.persistence.search!.search({ text: '"unique-chart"', conversationIds: [one.id], kinds: ["message"] }))).toHaveLength(0);
  const copy = paged.find((file) => file.ref)!;
  await agent.deleteMedia(copy.ref!);
  expect((await files.list()).files).toHaveLength(6); // history metadata remains
  await expect(files.list({ cursor: "bad" })).rejects.toThrow("cursor");
});


test("waiting out-of-band bytes survive a failed local turn commit and never reach the store", async () => {
  const store = memoryStore();
  const { agent } = await setup(store);
  const conversation = await agent.conversations.create();
  await agent.conversations.appendAssistantMessage(conversation.id, { parts: [{ kind: "image", data: new Uint8Array([9]), mimeType: "image/png", keep: false }] });
  const transaction = agent.persistence.transaction.bind(agent.persistence);
  let fail = true;
  (agent.persistence as any).transaction = (work: any) => transaction((scope) => work({ ...scope,
    providerSessions: new Proxy(scope.providerSessions, { get(target, property) {
      if (property === "append") return async (...args: Parameters<typeof target.append>) => {
        if (fail) { fail = false; throw new Error("local turn commit failed"); }
        return target.append(...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } }),
  }));
  await expect(conversation.prompt("first attempt")).rejects.toThrow("local turn commit failed");
  expect(await store.list(conversation.id)).toHaveLength(0);
  const retried = JSON.parse((await conversation.prompt("retry")).text);
  expect(retried.blocks).toContainEqual({ type: "image", data: "CQ==", mimeType: "image/png" });
  expect(await store.list(conversation.id)).toHaveLength(0);
});

test("a deleted out-of-band copy is named, not sent, and the turn still runs", async () => {
  const { agent } = await setup();
  const conversation = await agent.conversations.create();
  const record = await agent.conversations.appendAssistantMessage(conversation.id, { parts: [{ kind: "image", data: new Uint8Array([1]), mimeType: "image/png" }] });
  const ref = (record.content as readonly PersistedMediaBlock[])[0]!.ref!;
  await agent.deleteMedia(ref);
  const delivered = JSON.parse((await conversation.prompt("after deletion")).text);
  expect(delivered.blocks.some((block: { type: string }) => block.type === "image")).toBe(false);
  expect(delivered.prompt).toContain("[image: not available]");
  expect(await agent.persistence.media!.get(ref)).toBeNull();
});

test("out-of-band media an agent cannot take is named, delivered once, and does not block later turns", async () => {
  const { agent } = await setup(undefined, {}, ["no-media"]);
  const conversation = await agent.conversations.create();
  await agent.conversations.appendAssistantMessage(conversation.id, { parts: [
    { kind: "text", text: "sent elsewhere" },
    { kind: "image", data: new Uint8Array([1]), mimeType: "image/png", name: "plot.png" },
  ] });
  const first = JSON.parse((await conversation.prompt("one")).text);
  expect(first.blocks.every((block: { type: string }) => block.type === "text")).toBe(true);
  expect(first.prompt).toContain("[image plot.png: not supported by this agent]");
  const second = JSON.parse((await conversation.prompt("two")).text);
  expect(second.prompt).not.toContain("plot.png");
});

test("an out-of-band link left out by media capture is still delivered", async () => {
  const { agent, root } = await setup(undefined, { capture: { media: "none" } });
  const conversation = await agent.conversations.create();
  const path = join(root, "notes.txt");
  await Bun.write(path, "notes");
  await agent.conversations.appendAssistantMessage(conversation.id, { parts: [
    { kind: "text", text: "see the notes" },
    { kind: "file", path, mode: "link" },
  ] });
  const delivered = JSON.parse((await conversation.prompt("next")).text);
  expect(delivered.blocks).toContainEqual(expect.objectContaining({ type: "resource_link", uri: `file://${path}` }));
});

test("deleting a conversation forgets its waiting out-of-band parts", async () => {
  const { agent } = await setup();
  const conversation = await agent.conversations.create();
  await agent.conversations.appendAssistantMessage(conversation.id, { parts: [
    { kind: "image", data: new Uint8Array([1]), mimeType: "image/png", keep: false },
  ] });
  const { pendingOutOfBandParts } = await import("../src/media/pending.ts");
  expect(pendingOutOfBandParts(agent).size).toBe(1);
  await conversation.stop();
  await agent.conversations.delete(conversation.id);
  expect(pendingOutOfBandParts(agent).size).toBe(0);
});
