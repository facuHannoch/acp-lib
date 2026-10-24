import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "../src/agent.ts";
import type { PersistedMediaBlock } from "../src/persistence/backend.ts";
const roots: string[] = [];
const agents: Agent[] = [];
afterEach(async () => { await Promise.all(agents.splice(0).map((a) => a.close())); await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function setup(store?: import("../src/media/store.ts").MediaStore, extras: Pick<import("../src/agent/config.ts").AgentConfig, "capture" | "conversationPersistence"> = {}) {
  const root = await mkdtemp(join(tmpdir(), "media-agent-")); roots.push(root);
  const agent = await Agent.open({ persistence: { kind: "sqlite", path: join(root, "agent.sqlite") }, adapters: { fixture: { command: ["bun", resolve(import.meta.dir, "fixtures/media-agent.ts")] } }, defaultAdapterId: "fixture", ...extras, ...(store ? { media: { store } } : {}), conversationDefaults: { metering: { pricing: false } } }); agents.push(agent);
  return { agent, root };
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
  await agent.close();
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(root, "agent.sqlite"));
  db.exec("DROP TABLE conversation_media; DELETE FROM schema_migrations WHERE version >= 16; INSERT INTO schema_migrations(version, applied_at) VALUES (15, '2026-10-24T00:00:00.000Z')");
  db.close();
  const { SqliteAgentPersistence } = await import("../src/persistence/sqlite-backend.ts");
  const backend = await SqliteAgentPersistence.open({ path: join(root, "agent.sqlite") });
  try {
    expect((await backend.messages.list(id)).messages.some((m) => m.content === "retained text")).toBe(true);
    expect(await backend.media.list(id)).toHaveLength(0);
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

test("out-of-band media delivers once, retries failures, and removes temporary no-keep bytes", async () => {
  const { agent } = await setup();
  const conversation = await agent.conversations.create();
  const record = await agent.conversations.appendAssistantMessage(conversation.id, { parts: [{ kind: "image", data: new Uint8Array([1]), mimeType: "image/png", keep: false }] });
  expect(record.operationId).toBeUndefined();
  expect(record.content).toMatchObject([{ type: "media", mode: "copy" }]);
  expect(await agent.persistence.media!.list(conversation.id)).toHaveLength(1); // pending transport only
  await expect(conversation.prompt("FAIL_TURN")).rejects.toThrow();
  const delivered = JSON.parse((await conversation.prompt("after")).text);
  expect(delivered.blocks.some((b: { type: string }) => b.type === "image")).toBe(true);
  expect(delivered.prompt).toContain(record.recordId);
  expect(await agent.persistence.media!.list(conversation.id)).toHaveLength(0);
  expect(JSON.parse((await conversation.prompt("later")).text).blocks.some((b: { type: string }) => b.type === "image")).toBe(false);
});

test("pending no-keep out-of-band media survives Agent restart", async () => {
  const { agent, root } = await setup();
  const conversation = await agent.conversations.create();
  await agent.conversations.appendAssistantMessage(conversation.id, { parts: [{ kind: "image", data: new Uint8Array([7]), mimeType: "image/png", keep: false }] });
  await agent.close();
  const reopened = await Agent.open({ persistence: { kind: "sqlite", path: join(root, "agent.sqlite") }, adapters: { fixture: { command: ["bun", resolve(import.meta.dir, "fixtures/media-agent.ts")] } }, defaultAdapterId: "fixture", conversationDefaults: { metering: { pricing: false } } }); agents.push(reopened);
  const result = await reopened.conversations.open(conversation.id);
  const delivered = await result.conversation.prompt("after restart");
  expect(JSON.parse(delivered.text).blocks).toContainEqual({ type: "image", data: "Bw==", mimeType: "image/png" });
  expect(await reopened.persistence.media!.list(conversation.id)).toHaveLength(0);
});

test("out-of-band delivery advances even when message text capture is disabled", async () => {
  const { agent } = await setup(undefined, { capture: { message: "none" } });
  const conversation = await agent.conversations.create();
  await agent.conversations.appendAssistantMessage(conversation.id, { parts: [{ kind: "image", data: new Uint8Array([8]), mimeType: "image/png" }] });
  expect(JSON.parse((await conversation.prompt("first")).text).blocks.some((b: { type: string }) => b.type === "image")).toBe(true);
  expect(JSON.parse((await conversation.prompt("second")).text).blocks.some((b: { type: string }) => b.type === "image")).toBe(false);
});
