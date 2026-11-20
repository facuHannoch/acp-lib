import { expect, test } from "bun:test";
import { validateManagedConfig, LEGACY_POLICY } from "../src/runtime/config/managed.ts";
import { policyFingerprint, resolvePolicy, toolDecision } from "../src/governance/policy/resolve.ts";
import { createInProcessHarness } from "../src/testing.ts";
import { spawnHarness } from "./helpers/stdio.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chooseManagedConfig, managedSessionPaths } from "../src/runtime/config/paths.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";
import { Database } from "bun:sqlite";
const base = { version: 1, system: "S", model: { protocol: "scripted", script: "script.json" } };
const value = { ...base, defaultPolicy: "default", policies: {
  default: { fallback: "allow", tools: { edit: "ask", safe: "allow" } },
  strict: { fallback: "deny", tools: { safe: "allow" } },
  review: { fallback: "ask", tools: { safe: "allow" } },
} };
test("configuration validation identifies fields and upgrades only complete legacy shapes", () => {
  expect(validateManagedConfig(base, true)).toMatchObject({ defaultPolicy: LEGACY_POLICY, policies: { [LEGACY_POLICY]: { fallback: "allow", tools: {} } } });
  expect(() => validateManagedConfig(base)).toThrow("config.defaultPolicy");
  expect(() => validateManagedConfig({ ...base, defaultPolicy: "x" }, true)).toThrow("config.policies");
  expect(() => validateManagedConfig({ ...value, defaultPolicy: "missing" })).toThrow("config.defaultPolicy");
  expect(() => validateManagedConfig({ ...value, model: { ...value.model, script: " " } })).toThrow("config.model.script");
  expect(() => validateManagedConfig({ ...value, extra: true })).toThrow("config.extra");
});
test("JSON input rejects duplicate keys including escaped spellings", async () => {
  const { parseUniqueJson } = await import("../src/util/json.ts");
  expect(() => parseUniqueJson('{"config":{"policy":1,"\\u0070olicy":2}}')).toThrow("Duplicate field");
  expect(parseUniqueJson('{"a":[{"v":"x\\\"y"},2]}')).toEqual({ a: [{ v: 'x"y' }, 2] });
});
test("policy precedence and fingerprints depend on named contributing rules", () => {
  const config = validateManagedConfig(value);
  expect(resolvePolicy(config)).toBe("default");
  expect(resolvePolicy(config, undefined, "strict")).toBe("strict");
  expect(resolvePolicy(config, "review", "strict")).toBe("review");
  expect(() => resolvePolicy(config, "unknown")).toThrow("Unknown policy");
  expect(toolDecision(config, ["default", "strict"], "edit")).toBe("deny");
  expect(toolDecision(config, ["default", "review"], "edit")).toBe("ask");
  expect(toolDecision(config, ["default", "strict"], "safe")).toBe("allow");
  expect(() => toolDecision(config, [], "safe")).toThrow("without taken-input policies");
  expect(policyFingerprint(config, ["review", "strict", "review"])).toBe(policyFingerprint(config, ["strict", "review"]));
  const changed = validateManagedConfig({ ...value, policies: { ...value.policies, default: { fallback: "deny", tools: {} } } });
  expect(policyFingerprint(changed, ["strict"])).toBe(policyFingerprint(config, ["strict"]));
  expect(policyFingerprint(changed, ["default"])).not.toBe(policyFingerprint(config, ["default"]));
});
for (const transport of ["in-process", "stdio"] as const) test(`${transport}: validate config without creating a session`, async () => {
  const harness = transport === "stdio" ? spawnHarness() : createInProcessHarness();
  try {
    await harness.client.initialize();
    expect(await harness.client.validateConfig(value)).toEqual({ valid: true });
    await expect(harness.client.validateConfig({ ...value, defaultPolicy: "missing" })).rejects.toMatchObject({ code: "invalid_config", message: expect.stringContaining("config.defaultPolicy") });
    await expect(harness.client.status()).rejects.toMatchObject({ code: "not_ready" });
  } finally { await harness.close(); }
});

test("dedup distinguishes an explicit override and notice restrictions propagate", async () => {
  const { legacyItemSignature, policyItemSignature, contributingPolicies } = await import("../src/state/storage/policy-metadata.ts");
  const item = { kind: "participant_message", channelId: "a", senderId: "u", text: "same" };
  expect(policyItemSignature(item)).toBe(policyItemSignature({ ...item, explicitPolicy: null }));
  expect(policyItemSignature(item)).not.toBe(policyItemSignature({ ...item, explicitPolicy: "default" }));
  expect(policyItemSignature(item)).not.toBe(legacyItemSignature(item));
  expect(contributingPolicies([{ resolved: "target", inherited: ["strict", "older"] }, { resolved: "strict", inherited: ["older", "other"] }]))
    .toEqual(["target", "strict", "older", "other"]);
});

test("sidecar and saved config precedence is evaluated at each open", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-config-select-"));
  try {
    const paths = managedSessionPaths("session-1", directory), sidecar = join(directory, "config.json");
    expect(paths.database).toBe(join(directory, "session-1", "session.sqlite"));
    expect(() => managedSessionPaths("../bad", directory)).toThrow("sessionId");
    const saved = { ...value, system: "saved" }, inline = { ...value, system: "inline" };
    expect(chooseManagedConfig({ mode: "open", sidecar, saved }).system).toBe("saved");
    writeFileSync(sidecar, JSON.stringify({ ...value, system: "sidecar" }));
    expect(chooseManagedConfig({ mode: "open", sidecar, inline, saved }).system).toBe("sidecar");
    expect(chooseManagedConfig({ mode: "create", sidecar, inline }).system).toBe("inline");
    writeFileSync(sidecar, "invalid");
    expect(() => chooseManagedConfig({ mode: "open", sidecar, inline, saved })).toThrow("config.json");
    writeFileSync(sidecar, '{"version":1,"version":1}');
    expect(() => chooseManagedConfig({ mode: "open", sidecar, inline, saved })).toThrow("Duplicate field");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: accepted policy and inherited notice restrictions survive reopen`, () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-policy-store-"));
  try {
    const adapter = kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(directory, "session.sqlite"));
    const identity = { sessionId: "s", compatibilityKey: "k" }, config = validateManagedConfig(value);
    const open = (mode: "create" | "open") => { const r = adapter.open({ mode, identity, config }); if (!r.ok) throw new Error(r.error.message); return r.value; };
    const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }) => { if (!r.ok) throw new Error(r.error.message); return r.value; };
    const s = open("create");
    unwrap(s.createChannel({ channelId: "source", policy: "strict" }));
    unwrap(s.createChannel({ channelId: "target", policy: "default" }));
    unwrap(s.createChannel({ channelId: "third", policy: "review" }));
    const input = { kind: "participant_message" as const, channelId: "source", senderId: "u", text: "hi", itemId: "m" };
    expect(unwrap(s.acceptItem(input)).item.policy).toEqual({ resolved: "strict", inherited: [] });
    const turn = unwrap(s.beginTurn("source"))!.turn;
    const notice = { kind: "channel_notice" as const, channelId: "target", senderId: "channel:source", sourceChannelId: "source", sourceTurnId: turn.turnId, text: "notice", itemId: "n" };
    expect(unwrap(s.acceptItem(notice)).item.policy).toEqual({ resolved: "default", inherited: ["strict"] });
    unwrap(s.editChannel("source", null, "review"));
    expect(unwrap(s.acceptItem(input))).toMatchObject({ duplicate: true, item: { policy: { resolved: "strict" } } });
    expect(s.acceptItem({ ...input, explicitPolicy: "strict" })).toMatchObject({ ok: false, error: { code: "item_conflict" } });
    s.close();
    const reopened = open("open");
    expect(unwrap(reopened.snapshot()).items.find(item => item.itemId === "n")?.policy).toEqual({ resolved: "default", inherited: ["strict"] });
    const targetTurn = unwrap(reopened.beginTurn("target"))!;
    const taken = targetTurn.items[0]!.policy!;
    expect(toolDecision(config, [taken.resolved, ...taken.inherited], "edit")).toBe("deny");
    const nextNotice = unwrap(reopened.acceptItem({ kind: "channel_notice", channelId: "third", senderId: "channel:target",
      sourceChannelId: "target", sourceTurnId: targetTurn.turn.turnId, text: "forward", itemId: "n2" }));
    expect(nextNotice.item.policy).toEqual({ resolved: "review", inherited: ["default", "strict"] });
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: only contributing policy changes block checkpoint resume`, () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-policy-checkpoint-"));
  try {
    const adapter = kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(directory, "session.sqlite"));
    const identity = { sessionId: "s", compatibilityKey: "k" };
    const open = (mode: "create" | "open", config: ReturnType<typeof validateManagedConfig>) => { const r = adapter.open({ mode, identity, config }); if (!r.ok) throw new Error(r.error.message); return r.value; };
    const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }) => { if (!r.ok) throw new Error(r.error.message); return r.value; };
    const s = open("create", validateManagedConfig(value));
    unwrap(s.acceptItem({ kind: "participant_message", channelId: "a", senderId: "u", text: "hi", itemId: "m", explicitPolicy: "strict" }));
    const turn = unwrap(s.beginTurn("a"))!.turn;
    unwrap(s.beginChannelSuspend("a")); unwrap(s.checkpointTurn(turn.turnId)); s.close();
    const otherChanged = validateManagedConfig({ ...value, policies: { ...value.policies, default: { fallback: "deny", tools: {} } } });
    const compatible = open("open", otherChanged); expect(compatible.resumeChannel("a").ok).toBe(true);
    unwrap(compatible.beginChannelSuspend("a")); unwrap(compatible.checkpointTurn(turn.turnId)); compatible.close();
    const strictChanged = validateManagedConfig({ ...value, policies: { ...value.policies, strict: { fallback: "ask", tools: {} } } });
    const incompatible = open("open", strictChanged); const before = unwrap(incompatible.snapshot());
    expect(incompatible.resumeChannel("a")).toMatchObject({ ok: false, error: { code: "incompatible" } });
    expect(unwrap(incompatible.snapshot())).toEqual(before); incompatible.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: missing stored policy permits inspection but rejects execution without writes`, () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-policy-missing-"));
  try {
    const adapter = kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(directory, "session.sqlite"));
    const identity = { sessionId: "s", compatibilityKey: "k" }, initial = validateManagedConfig(value);
    const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }) => { if (!r.ok) throw new Error(r.error.message); return r.value; };
    const s = unwrap(adapter.open({ mode: "create", identity, config: initial }));
    unwrap(s.saveConfig(initial));
    unwrap(s.acceptItem({ kind: "participant_message", channelId: "a", senderId: "u", text: "hi", itemId: "m", explicitPolicy: "strict" }));
    s.close();
    const candidate = validateManagedConfig({ ...value, policies: { default: value.policies.default, review: value.policies.review } });
    const opened = unwrap(adapter.open({ mode: "open", identity, config: candidate })), before = unwrap(opened.snapshot());
    const { createSession } = require("../src/index.ts");
    const session = createSession({ systemPrompt: candidate.system, storage: opened, configureTurn: () => { throw new Error("must not execute"); } });
    expect(session.status().execution).toBe("incompatible");
    expect(opened.acceptItem({ kind: "participant_message", channelId: "a", senderId: "u", text: "again", itemId: "m2" })).toMatchObject({ ok: false, error: { code: "incompatible" } });
    expect(opened.beginTurn("a")).toMatchObject({ ok: false, error: { code: "incompatible" } });
    expect(opened.resume()).toMatchObject({ ok: false, error: { code: "incompatible" } });
    expect(opened.resumeChannel("a")).toMatchObject({ ok: false, error: { code: "incompatible" } });
    expect(opened.saveConfig(candidate)).toMatchObject({ ok: false, error: { code: "incompatible" } });
    expect(unwrap(opened.snapshot())).toEqual(before);
    expect(unwrap(opened.importedConfig())).toEqual(initial); opened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("stdio managed sessions use active config until reopen and preserve saved config after invalid sidecar", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-managed-config-")), id = "managed";
  const config = validateManagedConfig({ ...value, model: { protocol: "scripted", script: new URL("./fixtures/echo-scenario.json", import.meta.url).pathname } });
  const sidecar = managedSessionPaths(id, home).config;
  const { mkdirSync } = await import("node:fs"); mkdirSync(managedSessionPaths(id, home).directory);
  writeFileSync(sidecar, JSON.stringify(config));
  const first = spawnHarness({ home });
  try {
    await first.client.initialize(); await first.client.createSession({ sessionId: id, participants: [], channels: {} });
    writeFileSync(sidecar, JSON.stringify({ ...config, system: "changed" }));
    const { decodeSessionFile } = await import("../src/state/storage/session-file.ts");
    expect((decodeSessionFile(await first.client.exportArchive(), 268435456) as any).config.system).toBe("S");
  } finally { await first.close(); }
  const second = spawnHarness({ home });
  try {
    await second.client.initialize(); await second.client.loadSession({ sessionId: id });
    const { decodeSessionFile } = await import("../src/state/storage/session-file.ts");
    expect((decodeSessionFile(await second.client.exportArchive(), 268435456) as any).config.system).toBe("changed");
  } finally { await second.close(); }
  writeFileSync(sidecar, "bad JSON");
  const invalid = spawnHarness({ home });
  try { await invalid.client.initialize(); await expect(invalid.client.loadSession({ sessionId: id, config })).rejects.toMatchObject({ code: "invalid_config" }); }
  finally { await invalid.close(); }
  rmSync(sidecar);
  const restored = spawnHarness({ home });
  try {
    await restored.client.initialize(); await restored.client.loadSession({ sessionId: id });
    const { decodeSessionFile } = await import("../src/state/storage/session-file.ts");
    expect((decodeSessionFile(await restored.client.exportArchive(), 268435456) as any).config.system).toBe("changed");
  } finally { await restored.close(); rmSync(home, { recursive: true, force: true }); }
}, 20000);

test("a version 2 session file upgrades its config and item signatures", async () => {
  const { decodeSessionFile, encodeSessionFile } = await import("../src/state/storage/session-file.ts");
  const { legacyItemSignature } = await import("../src/state/storage/policy-metadata.ts");
  const script = new URL("./fixtures/echo-scenario.json", import.meta.url).pathname;
  const config = { version: 1 as const, system: "legacy", model: { protocol: "scripted" as const, script },
    defaultPolicy: LEGACY_POLICY, policies: { [LEGACY_POLICY]: { fallback: "allow" as const, tools: {} } } };
  const home = mkdtempSync(join(tmpdir(), "harness-legacy-file-")), first = spawnHarness({ home });
  let legacy: Uint8Array;
  try {
    await first.client.initialize(); await first.client.createSession({ sessionId: "s", config, participants: [], channels: {} });
    await first.client.push({ channel: "a", item: { id: "m", kind: "user_message", sender: "u", content: [{ type: "text", text: "hello" }] } });
    for (let i = 0; i < 200 && !(await first.client.idle()).idle; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const payload = decodeSessionFile(await first.client.exportArchive(), 268435456) as any;
    payload.archive.archiveVersion = 2; payload.archive.snapshot.session.formatVersion = 3;
    delete payload.archive.snapshot.modelCalls; delete payload.archive.snapshot.scriptPositions;
    for (const entry of payload.archive.snapshot.timeline) delete entry.messageId;
    for (const item of payload.archive.snapshot.items) { item.signature = legacyItemSignature(item); delete item.policy; delete item.explicitPolicy; }
    payload.config = { version: 1, system: config.system, model: config.model };
    legacy = encodeSessionFile(payload, 268435456);
  } finally { await first.close(); }
  const destination = mkdtempSync(join(tmpdir(), "harness-legacy-dest-")), second = spawnHarness({ home: destination });
  try {
    await second.client.initialize(); await second.client.importArchive(legacy);
    const loaded = await second.client.loadSession({ sessionId: "s" });
    expect(loaded.items[0]).toMatchObject({ id: "m", policy: { resolved: LEGACY_POLICY, inherited: [] } });
    expect(await second.client.push({ channel: "a", item: { id: "m", kind: "user_message", sender: "u", content: [{ type: "text", text: "hello" }] } })).toMatchObject({ duplicate: true, item: { policy: { resolved: LEGACY_POLICY } } });
  } finally { await second.close(); rmSync(home, { recursive: true, force: true }); rmSync(destination, { recursive: true, force: true }); }
}, 20000);

test("stdio retains a pending message's resolved policy across channel edits", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-policy-wire-")), effects = join(home, "effects.log");
  const harness = spawnHarness({ home, effects });
  const config = validateManagedConfig({ ...value, model: { protocol: "scripted", script: new URL("./fixtures/hold-scenario.json", import.meta.url).pathname } });
  try {
    await harness.client.initialize(); await harness.client.createSession({ sessionId: "s", config, participants: [], channels: {} });
    await harness.client.createChannel({ channel: "a", policy: "strict" });
    const message = (id: string) => ({ channel: "a", item: { id, kind: "user_message" as const, sender: "u", content: [{ type: "text" as const, text: id }] } });
    await harness.client.push(message("first"));
    const { existsSync, readFileSync } = await import("node:fs");
    for (let i = 0; i < 400 && (!existsSync(effects) || !readFileSync(effects, "utf8").includes("start:k")); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(await harness.client.push(message("pending"))).toMatchObject({ item: { policy: { resolved: "strict" } } });
    await harness.client.editChannel({ channel: "a", displayName: null, policy: "review" });
    expect(await harness.client.push(message("pending"))).toMatchObject({ duplicate: true, item: { policy: { resolved: "strict" } } });
    await expect(harness.client.push({ ...message("pending"), item: { ...message("pending").item, policy: "strict" } })).rejects.toMatchObject({ code: "item_conflict" });
    await expect(harness.client.push({ ...message("other"), item: { ...message("other").item, policy: "missing" } })).rejects.toMatchObject({ code: "invalid_policy" });
  } finally { await harness.close(); rmSync(home, { recursive: true, force: true }); }
}, 20000);

test("development open of an explicit database loads its saved scripted config", async () => {
  const { openDevelopment } = await import("../src/interfaces/cli/development.ts");
  const directory = mkdtempSync(join(tmpdir(), "harness-dev-config-")), path = join(directory, "session.sqlite");
  const script = new URL("./fixtures/echo-scenario.json", import.meta.url).pathname;
  const config = validateManagedConfig({ ...value, model: { protocol: "scripted", script } });
  const adapter = createSqliteStorageAdapter(path);
  const opened = adapter.open({ mode: "create", identity: { sessionId: "development", compatibilityKey: "unused" }, config });
  if (!opened.ok) throw new Error(opened.error.message);
  if (!opened.value.saveConfig(config).ok) throw new Error("could not save config");
  opened.value.close();
  try {
    const development = await openDevelopment({ systemPrompt: "ignored", database: path });
    try { expect(development.session.status().sessionId).toBe("development"); }
    finally { development.close(); }
    const edited = { ...config, system: "from sidecar" };
    writeFileSync(join(directory, "config.json"), JSON.stringify(edited));
    const fromSidecar = await openDevelopment({ systemPrompt: "ignored", database: path, managedConfig: config });
    fromSidecar.close();
    expect(adapter.readSavedConfig()).toMatchObject({ ok: true, value: { system: "from sidecar" } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("incompatible policy on a format 3 database permits inspection without migrating or recovering it", () => {
  const { legacyItemSignature } = require("../src/state/storage/policy-metadata.ts");
  const directory = mkdtempSync(join(tmpdir(), "harness-legacy-incompatible-")), path = join(directory, "session.sqlite");
  const adapter = createSqliteStorageAdapter(path), identity = { sessionId: "s", compatibilityKey: "k" };
  try {
    const created = adapter.open({ mode: "create", identity }); if (!created.ok) throw new Error(created.error.message);
    const input = { kind: "participant_message" as const, channelId: "a", senderId: "u", text: "hi", itemId: "m" };
    if (!created.value.acceptItem(input).ok || !created.value.beginTurn("a").ok) throw new Error("setup failed");
    created.value.close();
    const db = new Database(path);
    db.query("UPDATE items SET signature = ?").run(legacyItemSignature(input));
    db.exec("ALTER TABLE items DROP COLUMN policy_metadata; ALTER TABLE channels DROP COLUMN policy; UPDATE meta SET value = '3' WHERE key = 'formatVersion'");
    db.close();
    const { readFileSync } = require("node:fs"), before = readFileSync(path);
    const opened = adapter.open({ mode: "open", identity, config: validateManagedConfig(value) });
    if (!opened.ok) throw new Error(opened.error.message);
    const view = opened.value.snapshot(); expect(view.ok && view.value.turns[0]?.state.status).toBe("running");
    expect(opened.value.beginTurn("a")).toMatchObject({ ok: false, error: { code: "incompatible" } });
    opened.value.close(); expect(readFileSync(path).equals(before)).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("format 3 item signatures upgrade to policy-aware identities without reaccepting retries", () => {
  const { legacyItemSignature } = require("../src/state/storage/policy-metadata.ts");
  const directory = mkdtempSync(join(tmpdir(), "harness-legacy-upgrade-")), path = join(directory, "session.sqlite");
  const adapter = createSqliteStorageAdapter(path), identity = { sessionId: "s", compatibilityKey: "k" };
  try {
    const created = adapter.open({ mode: "create", identity }); if (!created.ok) throw new Error(created.error.message);
    const input = { kind: "participant_message" as const, channelId: "a", senderId: "u", text: "hi", itemId: "m" };
    if (!created.value.acceptItem(input).ok) throw new Error("setup failed"); created.value.close();
    const db = new Database(path); db.query("UPDATE items SET signature = ?").run(legacyItemSignature(input));
    db.exec("ALTER TABLE items DROP COLUMN policy_metadata; ALTER TABLE channels DROP COLUMN policy; UPDATE meta SET value = '3' WHERE key = 'formatVersion'"); db.close();
    const opened = adapter.open({ mode: "open", identity }); if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.acceptItem(input)).toMatchObject({ ok: true, value: { duplicate: true, item: { policy: { resolved: LEGACY_POLICY, inherited: [] } } } });
    expect(opened.value.acceptItem({ ...input, explicitPolicy: LEGACY_POLICY })).toMatchObject({ ok: false, error: { code: "item_conflict" } });
    expect(opened.value.snapshot()).toMatchObject({ ok: true, value: { session: { formatVersion: 5 } } }); opened.value.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
