import { useFormat3Schema } from "./fixtures/format3-schema.ts";
import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createInProcessHarness } from "../src/testing.ts";
import { validateManagedConfig } from "../src/runtime/config/managed.ts";
import { scenarioDefinitions } from "../src/capabilities/tools/scenario.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";
import { openDevelopment } from "../src/interfaces/cli/development.ts";
import { decodeSessionFile } from "../src/state/storage/session-file.ts";
import { openRouter } from "../src/capabilities/model/openrouter.ts";
import type { Model } from "../src/contracts/loop.ts";

const secret = "test-custom-credential-8d3b", different = "test-default-credential-126c";
const environment = { CONFIG_TEST_CUSTOM_KEY: secret, OPENROUTER_API_KEY: different, OPENROUTER_MODEL: "environment/model" };
const config = validateManagedConfig({ version: 1, system: "provider system", model: { protocol: "openrouter", model: "saved/model", apiKeyEnv: "CONFIG_TEST_CUSTOM_KEY" },
  defaultPolicy: "main", policies: { main: { fallback: "allow", tools: {} }, unused: { fallback: "ask", tools: {} } } });
const fake = (calls: { key: string; model: string }[]) => (key: string, model: string): Model => {
  calls.push({ key, model }); return async () => ({ role: "assistant", content: "offline response", calls: [] });
};
const until = async (check: () => boolean | Promise<boolean>) => { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error("timed out"); };
const push = (id: string) => ({ channel: "a", item: { id, kind: "user_message" as const, sender: "u", content: [{ type: "text" as const, text: "hello" }] } });

test("OpenRouter config validates references and never accepts key values", () => {
  expect(validateManagedConfig({ ...config, model: { protocol: "openrouter" } }).model).toEqual({ protocol: "openrouter", model: "deepseek/deepseek-v4.1-flash", apiKeyEnv: "OPENROUTER_API_KEY" });
  expect(() => validateManagedConfig({ ...config, model: { ...config.model, apiKey: secret } })).toThrow("config.model.apiKey");
  expect(() => validateManagedConfig({ ...config, model: { ...config.model, apiKeyEnv: "bad-name" } })).toThrow("config.model.apiKeyEnv");
});

test("offline OpenRouter dispatch does not log the credential", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {}), error = spyOn(console, "error").mockImplementation(() => {});
  const calls: { key: string; model: string }[] = [];
  const harness = createInProcessHarness({ environment, providerFactory: fake(calls) });
  try {
    await harness.client.initialize(); await harness.client.createSession({ sessionId: "s", config, participants: [], channels: {} });
    await harness.client.push(push("m")); await until(() => calls.length === 1); await until(async () => (await harness.client.idle()).idle);
    expect(JSON.stringify([log.mock.calls, error.mock.calls])).not.toContain(secret);
  } finally { harness.close(); log.mockRestore(); error.mockRestore(); }
});

test("provider error text cannot leak an echoed credential", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response(`echo ${secret}`, { status: 401 })) as unknown as typeof fetch);
  try {
    const result = await openRouter(secret, "saved/model")([], []).catch(error => String(error));
    expect(result).toContain("[REDACTED]"); expect(result).not.toContain(secret);
    fetchSpy.mockImplementation((async () => { throw new Error(`transport echoed ${secret}`); }) as unknown as typeof fetch);
    const transport = await openRouter(secret, "saved/model")([], []).catch(error => String(error));
    expect(transport).toContain("[REDACTED]"); expect(transport).not.toContain(secret);
  } finally { fetchSpy.mockRestore(); }
});

test("offline OpenRouter export and fresh-home reopen uses named secret without storing it", async () => {
  const source = mkdtempSync(join(tmpdir(), "provider-source-")), dest = mkdtempSync(join(tmpdir(), "provider-dest-"));
  const calls: { key: string; model: string }[] = [], wire: unknown[] = [];
  const first = createInProcessHarness({ home: source, environment, providerFactory: fake(calls) });
  let bytes: Uint8Array;
  try {
    wire.push(await first.client.initialize()); wire.push(await first.client.createSession({ sessionId: "s", config, participants: [], channels: {} }));
    first.client.onChannelEvent(event => wire.push(event));
    wire.push(await first.client.push(push("a1"))); await until(async () => (await first.client.idle()).idle);
    expect(calls).toEqual([{ key: secret, model: "saved/model" }]);
    bytes = await first.client.exportArchive();
    expect((decodeSessionFile(bytes, 268435456) as any).config).toEqual(config);
    expect(Buffer.from(bytes).includes(secret)).toBe(false);
  } finally { first.close(); }
  expect(readFileSync(join(source, "s", "session.sqlite")).includes(secret)).toBe(false);
  const second = createInProcessHarness({ home: dest, environment, providerFactory: fake(calls) });
  try {
    wire.push(await second.client.initialize()); wire.push(await second.client.importArchive(bytes));
    const loaded = await second.client.openSession({ sessionId: "s" }); wire.push(loaded);
    second.client.onChannelEvent(event => wire.push(event));
    wire.push(await second.client.push(push("a2"))); await until(() => calls.length === 2); await until(async () => (await second.client.idle()).idle);
    expect(calls).toEqual([{ key: secret, model: "saved/model" }, { key: secret, model: "saved/model" }]);
    expect(JSON.stringify(wire)).not.toContain(secret);
  } finally { second.close(); }
  const database = join(dest, "s", "session.sqlite");
  expect(readFileSync(database).includes(secret)).toBe(false);
  const before = readFileSync(database);
  const missing = createInProcessHarness({ home: dest, environment: { OPENROUTER_API_KEY: different }, providerFactory: fake(calls) });
  try { await missing.client.initialize(); await expect(missing.client.openSession({ sessionId: "s" })).rejects.toMatchObject({ code: "invalid_config", message: expect.stringContaining("CONFIG_TEST_CUSTOM_KEY") }); }
  finally { missing.close(); }
  expect(readFileSync(database).equals(before)).toBe(true);
  const empty = createInProcessHarness({ home: dest, environment: { CONFIG_TEST_CUSTOM_KEY: "" }, providerFactory: fake(calls) });
  try { await empty.client.initialize(); await expect(empty.client.openSession({ sessionId: "s" })).rejects.toMatchObject({ code: "invalid_config" }); }
  finally { empty.close(); }
  expect(readFileSync(database).equals(before)).toBe(true);
  rmSync(source, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true });
}, 20000);

test("OpenRouter checkpoint key binds model and contributing policy but not credential reference", async () => {
  const directory = mkdtempSync(join(tmpdir(), "provider-checkpoint-")), path = join(directory, "session.sqlite");
  const key = createHash("sha256").update(JSON.stringify([config.system, "saved/model", scenarioDefinitions.map(tool => tool.name)])).digest("hex");
  const adapter = createSqliteStorageAdapter(path), identity = { sessionId: "development", compatibilityKey: key };
  const r = adapter.open({ mode: "create", identity, config }); if (!r.ok) throw new Error(r.error.message); const store = r.value;
  const must = <T>(v: { ok: true; value: T } | { ok: false; error: { message: string } }) => { if (!v.ok) throw new Error(v.error.message); return v.value; };
  must(store.acceptItem({ kind: "participant_message", channelId: "a", senderId: "u", text: "hi", itemId: "m" }));
  const turn = must(store.beginTurn("a"))!.turn; must(store.beginChannelSuspend("a")); must(store.checkpointTurn(turn.turnId)); must(store.saveConfig(config)); store.close();
  const changedSystem = validateManagedConfig({ ...config, system: "changed system" });
  const systemMismatch = await openDevelopment({ systemPrompt: "ignored", database: path, managedConfig: changedSystem, environment, providerFactory: fake([]) });
  const unchanged = systemMismatch.session.snapshot();
  expect(systemMismatch.session.channels.resume("a")).toMatchObject({ ok: false, error: { code: "incompatible" } });
  expect(systemMismatch.session.snapshot()).toEqual(unchanged); systemMismatch.close();
  const changedModel = validateManagedConfig({ ...config, model: { protocol: "openrouter", model: "changed/model", apiKeyEnv: "CONFIG_TEST_CUSTOM_KEY" } });
  const different = await openDevelopment({ systemPrompt: "ignored", database: path, managedConfig: changedModel, environment, providerFactory: fake([]) });
  const before = different.session.snapshot();
  expect(different.session.channels.resume("a")).toMatchObject({ ok: false, error: { code: "incompatible" } });
  expect(different.session.snapshot()).toEqual(before); different.close();
  const refChanged = validateManagedConfig({ ...config, model: { protocol: "openrouter", model: "saved/model", apiKeyEnv: "ANOTHER_TEST_KEY" },
    policies: { ...config.policies, unused: { fallback: "deny", tools: {} } } });
  const calls: { key: string; model: string }[] = [];
  const same = await openDevelopment({ systemPrompt: "ignored", database: path, managedConfig: refChanged, environment: { ANOTHER_TEST_KEY: "new-key" }, providerFactory: fake(calls) });
  expect(same.session.channels.resume("a")).toMatchObject({ ok: true });
  await until(() => same.session.status().channels[0]?.activeTurn === undefined); same.close();
  rmSync(directory, { recursive: true, force: true });
});

test("saved provider model beats environment and sidecar wins over inline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "provider-sidecar-")), path = join(directory, "session.sqlite"), calls: { key: string; model: string }[] = [];
  const make = (model: string) => validateManagedConfig({ ...config, model: { protocol: "openrouter", model, apiKeyEnv: "CONFIG_TEST_CUSTOM_KEY" } });
  const first = await openDevelopment({ systemPrompt: "unused", database: path, create: true, managedConfig: config, environment, providerFactory: fake(calls) });
  first.close();
  const saved = await openDevelopment({ systemPrompt: "unused", database: path, environment, providerFactory: fake(calls) });
  saved.session.start(); saved.session.agent.send({ channelId: "a", participantId: "u", text: "hi", itemId: "1" });
  await until(() => saved.session.agent.idle()); saved.close();
  writeFileSync(join(directory, "config.json"), JSON.stringify(make("sidecar/model")));
  const sidecar = await openDevelopment({ systemPrompt: "unused", database: path, managedConfig: config, environment, providerFactory: fake(calls) });
  sidecar.session.start(); sidecar.session.agent.send({ channelId: "a", participantId: "u", text: "hello", itemId: "2" });
  await until(() => sidecar.session.agent.idle()); sidecar.close();
  expect(calls).toEqual([{ key: secret, model: "saved/model" }, { key: secret, model: "sidecar/model" }]);
  expect(readdirSync(directory)).toEqual(expect.arrayContaining(["config.json", "session.sqlite"]));
  rmSync(directory, { recursive: true, force: true });
});

test("legacy OpenRouter checkpoint resumes with its original compatibility key", async () => {
  const { Database } = await import("bun:sqlite"), { legacyItemSignature } = await import("../src/state/storage/policy-metadata.ts");
  const directory = mkdtempSync(join(tmpdir(), "provider-legacy-")), path = join(directory, "session.sqlite");
  const legacyConfig = validateManagedConfig({ ...config, defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow", tools: {} } } });
  const identity = { sessionId: "development", compatibilityKey: createHash("sha256").update(JSON.stringify([config.system, "saved/model", scenarioDefinitions.map(tool => tool.name)])).digest("hex") };
  const adapter = createSqliteStorageAdapter(path), opened = adapter.open({ mode: "create", identity, config: legacyConfig });
  if (!opened.ok) throw new Error(opened.error.message);
  const input = { kind: "participant_message" as const, channelId: "a", senderId: "u", text: "hello", itemId: "m" };
  const accepted = opened.value.acceptItem(input); if (!accepted.ok) throw new Error(accepted.error.message);
  const begun = opened.value.beginTurn("a"); if (!begun.ok || !begun.value) throw new Error("begin failed");
  if (!opened.value.beginChannelSuspend("a").ok || !opened.value.checkpointTurn(begun.value.turn.turnId).ok) throw new Error("checkpoint failed");
  opened.value.close();
  const db = new Database(path); db.query("UPDATE items SET signature = ?").run(legacyItemSignature(input));
  const raw = db.query<{ state: string }, []>("SELECT state FROM turns").get()!; const state = JSON.parse(raw.state); delete state.checkpoint.policyFingerprint;
  db.query("UPDATE turns SET state = ?").run(JSON.stringify(state));
  useFormat3Schema(db); db.close();
  expect(adapter.readSavedConfig()).toMatchObject({ ok: true });
  const calls: { key: string; model: string }[] = [];
  const legacy = await openDevelopment({ systemPrompt: config.system, database: path, provider: { apiKey: secret, model: "saved/model" }, environment: {}, providerFactory: fake(calls) });
  expect(legacy.session.channels.resume("a")).toMatchObject({ ok: true });
  await until(() => legacy.session.status().channels[0]?.activeTurn === undefined); legacy.close(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(adapter.readSavedConfig()).toMatchObject({ ok: true });
  const reopened = await expect(openDevelopment({ systemPrompt: config.system, database: path, provider: { apiKey: secret, model: "saved/model" }, environment: {}, providerFactory: fake(calls) })).rejects.toThrow("OPENROUTER_API_KEY");
  expect(reopened).toBeUndefined();
  rmSync(directory, { recursive: true, force: true });
});
