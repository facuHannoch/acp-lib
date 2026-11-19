import { decodeSessionFile, encodeSessionFile } from "../src/state/storage/session-file.ts";
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessHarness } from "../src/testing.ts";
import type { HarnessClient } from "../src/client.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";
import type { ChannelEvent } from "../src/contracts/events.ts";
import type { CreateParams, ProtocolConfig } from "../src/contracts/protocol.ts";
import type { SessionStorageAdapter } from "../src/contracts/storage.ts";
import { spawnHarness } from "./helpers/stdio.ts";

const root = mkdtempSync(join(tmpdir(), "harness-port-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const config: ProtocolConfig = { version: 1, system: "Test system", model: { protocol: "scripted", script: new URL("./fixtures/hold-scenario.json", import.meta.url).pathname }, defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow", tools: {} } } };
const setup: CreateParams = { sessionId: "moved", participants: [], channels: {}, config };
const push = (channel: string, id: string, text: string) => ({ channel, item: { id, kind: "user_message" as const, sender: channel, content: [{ type: "text" as const, text }] } });
const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${what}`);
}
function watch(client: HarnessClient) {
  const events: ChannelEvent[] = [];
  client.onChannelEvent(event => { events.push(event); });
  return events;
}
/** A home is a directory of SQLite sessions for stdio, or a set of lasting memory locations in-process. */
function home(transport: "in-process" | "stdio", effects: string, limits?: { maxBytes?: number; idleMs?: number; chunkBytes?: number }) {
  const directory = mkdtempSync(join(root, "home-"));
  const locations = new Map<string, SessionStorageAdapter>();
  const adapter = (id: string) => locations.get(id) ?? locations.set(id, createMemoryStorageAdapter()).get(id)!;
  return { directory, files: () => readdirSync(directory).sort(),
    open: () => transport === "stdio" ? spawnHarness({ home: directory, effects }) : createInProcessHarness({ adapter, effects, transfers: directory, limits }) };
}
const big = (i: number) => `${i}:${"p".repeat(300_000)}`;

test("stdio: active config and individual checkpoint survive path import after source config removal", async () => {
  const source = mkdtempSync(join(root, "source-config-")), dest = mkdtempSync(join(root, "dest-config-"));
  const effects = join(source, "effects.log"), configPath = join(source, "config.json"), path = join(source, "copy.harness"), scriptPath = join(source, "script.json");
  if (config.model.protocol !== "scripted") throw new Error("Expected scripted test model");
  const script = readFileSync(config.model.script); writeFileSync(scriptPath, script);
  writeFileSync(configPath, JSON.stringify({ ...config, model: { ...config.model, script: scriptPath } }));
  const active = JSON.parse(readFileSync(configPath, "utf8"));
  const first = spawnHarness({ home: source, effects });
  try {
    await first.client.initialize(); await first.client.createSession({ ...setup, config: active });
    rmSync(configPath);
    await first.client.push(push("a", "a1", "start"));
    await until(() => lines(effects).includes("start:k"), "tool start");
    await first.client.push(push("a", "a2", "pending"));
    const suspended = first.client.suspendChannel({ channel: "a" });
    await until(async () => (await first.client.status()).channels[0]?.lifecycle === "suspending", "channel suspending");
    writeFileSync(`${effects}.release-k`, ""); await suspended;
    await expect(first.client.exportTo(path)).rejects.toMatchObject({ code: "busy" });
    await first.client.suspend();
    await first.client.exportTo(path);
    expect((decodeSessionFile(readFileSync(path), 268435456) as any).config).toEqual(active);
  } finally { await first.close(); }
  rmSync(scriptPath);
  const second = spawnHarness({ home: dest, effects });
  try {
    await second.client.initialize(); await second.client.importFrom(path);
    await expect(second.client.loadSession({ sessionId: "moved" })).rejects.toMatchObject({ code: "invalid_config" });
    writeFileSync(scriptPath, script);
    const loaded = await second.client.loadSession({ sessionId: "moved" });
    expect(loaded.status.channels[0]).toMatchObject({ lifecycle: "suspended", pending: ["a2"], waitingForResume: true });
    await second.client.resume();
    expect((await second.client.status()).channels[0]).toMatchObject({ lifecycle: "suspended", pending: ["a2"] });
    const events = watch(second.client); await second.client.resumeChannel({ channel: "a" });
    await until(() => events.some(e => e.event.type === "turn_ended"), "resumed channel");
    expect(lines(effects)).toEqual(["start:k", "done:k"]);
  } finally { await second.close(); }
  const adapter = createSqliteStorageAdapter(join(dest, "moved", "session.sqlite"));
  const db = adapter.open({ mode: "open", identity: { sessionId: "moved", compatibilityKey: "inspection" } });
  if (!db.ok) throw new Error(db.error.message);
  expect(db.value.importedConfig()).toMatchObject({ ok: true, value: active }); db.value.close();
}, 30000);

/** A suspended session holding a checkpointed turn and pending input larger than one frame in total. */
async function suspendedSource(client: HarnessClient, effects: string) {
  await client.initialize(); await client.createSession(setup);
  await client.push(push("a", "a1", "start"));
  await until(() => lines(effects).includes("start:k"), "tool to start");
  for (let i = 0; i < 5; i++) await client.push(push("a", `big-${i}`, big(i)));
  const suspending = client.suspend();
  await until(async () => (await client.status()).lifecycle === "suspending", "suspension to begin");
  writeFileSync(`${effects}.release-k`, "");
  return suspending;
}

for (const transport of ["in-process", "stdio"] as const) test(`${transport}: a suspended session larger than one frame round-trips into a fresh home and resumes there exactly once`, async () => {
  const effects = join(mkdtempSync(join(root, "fx-")), "effects.log");
  const source = home(transport, effects), destination = home(transport, effects);
  let archive: Uint8Array, before;
  const first = source.open();
  try {
    const status = await suspendedSource(first.client, effects);
    expect(status).toMatchObject({ lifecycle: "suspended" });
    before = await first.client.loadSession({ sessionId: "moved", config });
    archive = await first.client.exportArchive();
    // Larger than one 1 MiB frame, so it can only have crossed in chunks.
    expect(archive.length).toBeGreaterThan(1024 * 1024);
    // One binary envelope contains both the logical archive and active config.
    const payload = decodeSessionFile(archive, 268435456) as any;
    const document = payload.archive;
    expect(payload.config).toEqual(config);
    expect(Object.keys(document).sort()).toEqual(["allocation", "archiveVersion", "exportedAt", "format", "snapshot"]);
    expect(document).toMatchObject({ format: "harness-session", archiveVersion: 3, snapshot: { revision: before.status.revision, session: { sessionId: "moved", lifecycle: "suspended" } } });
    // Export by path writes the same document; its reported length and hash are those of the file.
    const path = join(source.directory, "moved.harness");
    const byPath = await first.client.exportTo(path);
    const file = readFileSync(path);
    expect(byPath).toEqual({ bytes: file.length, sha256: sha(file) });
    expect((decodeSessionFile(file, 268435456) as any).archive.snapshot).toEqual(document.snapshot);
    await expect(first.client.exportTo(path)).rejects.toMatchObject({ code: "already_exists" });
    expect(readFileSync(path).equals(file)).toBe(true);
    // Export leaves the session as it was, and no transfer file behind.
    expect(await first.client.loadSession({ sessionId: "moved", config })).toEqual(before);
    expect(source.files().filter(name => name.includes("transfer") || name.includes("draft"))).toEqual([]);
  } finally { await first.close(); }

  const second = destination.open();
  try {
    await second.client.initialize();
    const events = watch(second.client);
    expect(await second.client.importArchive(archive)).toEqual({ sessionId: "moved", lifecycle: "suspended", revision: before.status.revision });
    // Importing neither opens nor runs the copy.
    await expect(second.client.status()).rejects.toMatchObject({ code: "not_ready" });
    // An occupied destination is refused and left alone.
    await expect(second.client.importArchive(archive)).rejects.toMatchObject({ code: "already_exists" });
    const loaded = await second.client.loadSession({ sessionId: "moved", config });
    expect(loaded).toEqual(before);
    expect(loaded.turns).toMatchObject([{ turnId: "1", state: "suspended", items: ["a1"] }]);
    expect(loaded.items.map(item => [item.id, item.milestone])).toEqual([["a1", "seen"], ...[0, 1, 2, 3, 4].map(i => [`big-${i}`, "received"])]);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(events).toEqual([]);
    // Deduplication travelled with the session.
    expect(await second.client.push(push("a", "big-2", big(2)))).toMatchObject({ duplicate: true, item: { milestone: "received" } });
    await expect(second.client.push(push("a", "big-2", "other text"))).rejects.toMatchObject({ code: "item_conflict" });
    await second.client.resume();
    await until(() => events.some(event => event.event.type === "turn_ended"), "resumed turn");
    expect(events.map(event => event.event.type)).toEqual(["turn_resumed", "turn_took", "message_completed", "items_receipt", "turn_ended"]);
    expect(events[1]!.event).toMatchObject({ turnId: "1", items: [0, 1, 2, 3, 4].map(i => `big-${i}`) });
    // The tool that completed in the source process never ran in the destination.
    expect(lines(effects)).toEqual(["start:k", "done:k"]);
    const after = await second.client.loadSession({ sessionId: "moved", config });
    expect(after.turns).toMatchObject([{ turnId: "1", state: "completed", items: ["a1", "big-0", "big-1", "big-2", "big-3", "big-4"] }]);
    // IDs continue from the source's allocation state.
    await second.client.push(push("b", "b1", "fresh"));
    await until(() => events.filter(event => event.event.type === "turn_ended").length === 2, "fresh turn");
    expect(events.find(event => event.channel === "b")!.event).toMatchObject({ type: "turn_started", turnId: "2", items: ["b1"] });
    expect(events.find(event => event.channel === "b")!.revision).toBeGreaterThan(before.status.revision);
  } finally { await second.close(); }

  // A copy under a new session ID keeps the IDs inside it, by path this time.
  const third = destination.open();
  try {
    await third.client.initialize();
    expect(await third.client.importFrom(join(source.directory, "moved.harness"), "renamed")).toMatchObject({ sessionId: "renamed", lifecycle: "suspended" });
    const renamed = await third.client.loadSession({ sessionId: "renamed", config });
    expect(renamed).toEqual({ ...before, status: { ...before.status, sessionId: "renamed" } });
  } finally { await third.close(); }
}, 30000);

for (const transport of ["in-process", "stdio"] as const) test(`${transport}: invalid archives and broken transfers leave no session and no files`, async () => {
  const effects = join(mkdtempSync(join(root, "fx-")), "effects.log");
  const source = home(transport, effects), destination = home(transport, effects);
  const first = source.open();
  let archive: Uint8Array;
  try { await suspendedSource(first.client, effects); archive = await first.client.exportArchive(); }
  finally { await first.close(); }
  const second = destination.open();
  try {
    const { client } = second;
    await client.initialize();
    const baseline = destination.files();
    const refused = async (attempt: Promise<unknown>, code: string) => {
      await expect(attempt).rejects.toMatchObject({ code });
      await expect(client.loadSession({ sessionId: "moved", config })).rejects.toMatchObject({ code: "not_found" });
      expect(destination.files()).toEqual(baseline);
    };
    // Damaged documents: truncated, not JSON, edited content, illegal lifecycle.
    const edited = (change: (document: any) => void) => { const payload = decodeSessionFile(archive, 268435456) as any; change(payload.archive); return encodeSessionFile(payload, 268435456); };
    await refused(client.importArchive(archive.subarray(0, archive.length - 10)), "invalid_archive");
    await refused(client.importArchive(new TextEncoder().encode("not an archive")), "invalid_archive");
    await refused(client.importArchive(new Uint8Array([0xff, 0xfe, 0x00])), "invalid_archive");
    await refused(client.importArchive(edited(document => { document.snapshot.items[1].text = "tampered"; })), "invalid_archive");
    await refused(client.importArchive(edited(document => { document.snapshot.session.lifecycle = "suspending"; })), "invalid_archive");
    await refused(client.importArchive(edited(document => { document.snapshot.items[2].acceptedSeq = document.snapshot.items[1].acceptedSeq; })), "invalid_archive");
    await refused(client.importArchive(edited(document => { document.archiveVersion = 4; })), "invalid_archive");
    const invalidConfig = decodeSessionFile(archive, 268435456) as any;
    invalidConfig.config.model.script = "  ";
    await refused(client.importArchive(encodeSessionFile(invalidConfig, 268435456)), "invalid_archive");
    const wrongVersion = Uint8Array.from(archive); wrongVersion[9] = 2;
    await refused(client.importArchive(wrongVersion), "invalid_archive");
    await refused(client.importArchive(Uint8Array.from([...archive, 0])), "invalid_archive");
    // Path sources: missing file, junk file.
    await refused(client.importFrom(join(destination.directory, "absent.harness")), "not_found");
    const junk = join(mkdtempSync(join(root, "junk-")), "junk.harness"); writeFileSync(junk, "{\"format\":");
    await refused(client.importFrom(junk), "invalid_archive");

    // Transfer rules. Bytes that do not match the announced hash or length are not an archive.
    const open = () => client.request("transfer/open", { bytes: archive.length, sha256: sha(archive) });
    let { transferId, limits } = await open();
    expect(limits).toEqual({ chunkBytes: 524288, maxBytes: 268435456, idleMs: 60000 });
    await expect(open()).rejects.toMatchObject({ code: "transfer_limit" });
    const chunk = archive.subarray(0, limits.chunkBytes);
    await expect(client.request("transfer/write", { transferId, offset: 10, data: b64(chunk) })).rejects.toMatchObject({ code: "transfer_limit" });
    await expect(client.request("transfer/write", { transferId, offset: 0, data: b64(archive.subarray(0, limits.chunkBytes + 1)) })).rejects.toMatchObject({ code: "transfer_limit" });
    await expect(client.request("transfer/write", { transferId: "unknown", offset: 0, data: b64(chunk) })).rejects.toMatchObject({ code: "not_found" });
    await expect(client.request("transfer/read", { transferId, offset: 0 })).rejects.toMatchObject({ code: "not_found" });
    // The refused chunks wrote nothing: the first accepted chunk is still at offset 0.
    expect(await client.request("transfer/write", { transferId, offset: 0, data: b64(chunk) })).toEqual({ received: chunk.length });
    await expect(client.request("transfer/write", { transferId, offset: 0, data: b64(chunk) })).rejects.toMatchObject({ code: "transfer_limit" });
    // Importing an incomplete upload fails and ends the transfer.
    await refused(client.request("session/import", { from: { type: "transfer", transferId } }), "invalid_archive");
    await expect(client.request("transfer/close", { transferId })).rejects.toMatchObject({ code: "not_found" });
    // An upload that would run past its announced length.
    ({ transferId } = await client.request("transfer/open", { bytes: 4, sha256: sha(archive) }));
    await expect(client.request("transfer/write", { transferId, offset: 0, data: b64(archive.subarray(0, 5)) })).rejects.toMatchObject({ code: "transfer_limit" });
    expect(await client.request("transfer/close", { transferId })).toEqual({});
    // Complete bytes under the wrong hash.
    ({ transferId } = await client.request("transfer/open", { bytes: 4, sha256: sha(archive) }));
    await client.request("transfer/write", { transferId, offset: 0, data: b64(archive.subarray(0, 4)) });
    await refused(client.request("session/import", { from: { type: "transfer", transferId } }), "invalid_archive");
    // Over the size limit: refused before any file exists.
    await refused(client.request("transfer/open", { bytes: 268435457, sha256: sha(archive) }), "transfer_limit");
    await refused(client.request("transfer/open", { bytes: 0, sha256: sha(archive) }), "invalid_archive");
    // After all of that, the real archive still imports.
    expect(await client.importArchive(archive)).toMatchObject({ sessionId: "moved", lifecycle: "suspended" });
    await expect(client.importArchive(encodeSessionFile(invalidConfig, 268435456))).rejects.toMatchObject({ code: "invalid_archive" });
    expect((await client.loadSession({ sessionId: "moved", config })).status.lifecycle).toBe("suspended");
    expect(destination.files().filter(name => name.includes("transfer") || name.includes("draft"))).toEqual([]);
  } finally { await second.close(); }
}, 30000);

for (const transport of ["in-process", "stdio"] as const) test(`${transport}: export is refused while work is active or pending, and allowed when idle`, async () => {
  const effects = join(mkdtempSync(join(root, "fx-")), "effects.log");
  const place = home(transport, effects);
  const harness = place.open();
  try {
    const { client } = harness;
    const init = await client.initialize();
    expect(init.description.capabilities.methods).toEqual(expect.arrayContaining(["session/export", "session/import", "transfer/open", "transfer/write", "transfer/read", "transfer/close"]));
    await expect(client.exportArchive()).rejects.toMatchObject({ code: "not_ready" });
    await client.createSession(setup);
    const events = watch(client);
    // Idle with nothing pending: a running-lifecycle archive.
    const empty = (decodeSessionFile(await client.exportArchive(), 268435456) as any).archive;
    expect(empty.snapshot).toMatchObject({ session: { lifecycle: "running" }, turns: [], items: [] });
    await client.push(push("a", "a1", "start"));
    await until(() => lines(effects).includes("start:k"), "tool to start");
    const target = join(place.directory, "busy.harness");
    await expect(client.exportTo(target)).rejects.toMatchObject({ code: "busy" });
    await expect(client.exportArchive()).rejects.toMatchObject({ code: "busy" });
    const suspending = client.suspend();
    await until(async () => (await client.status()).lifecycle === "suspending", "suspension to begin");
    // Suspending is not yet a clean suspension.
    await expect(client.exportArchive()).rejects.toMatchObject({ code: "busy" });
    expect(existsSync(target)).toBe(false);
    writeFileSync(`${effects}.release-k`, "");
    await suspending;
    // A download can be read at any offset, repeatedly, until it is closed.
    const { bytes, sha256, transferId } = await client.request("session/export", { to: { type: "transfer" } });
    const whole = Buffer.from((await client.request("transfer/read", { transferId: transferId!, offset: 0 })).data, "base64");
    expect(whole.length).toBe(bytes); expect(sha(whole)).toBe(sha256);
    expect(await client.request("transfer/read", { transferId: transferId!, offset: bytes })).toEqual({ data: "", eof: true });
    expect(Buffer.from((await client.request("transfer/read", { transferId: transferId!, offset: 5 })).data, "base64").equals(whole.subarray(5))).toBe(true);
    await expect(client.request("transfer/read", { transferId: transferId!, offset: bytes + 1 })).rejects.toMatchObject({ code: "transfer_limit" });
    await expect(client.request("session/export", { to: { type: "transfer" } })).rejects.toMatchObject({ code: "transfer_limit" });
    await expect(client.request("transfer/write", { transferId: transferId!, offset: 0, data: "AAAA" })).rejects.toMatchObject({ code: "not_found" });
    expect(await client.request("transfer/close", { transferId: transferId! })).toEqual({});
    await expect(client.request("transfer/read", { transferId: transferId!, offset: 0 })).rejects.toMatchObject({ code: "not_found" });
    expect(place.files().filter(name => name.includes("transfer"))).toEqual([]);
    await client.resume();
    await until(() => events.some(event => event.event.type === "turn_ended"), "turn to finish");
    // Completed, idle, running: exportable again.
    expect((decodeSessionFile(await client.exportArchive(), 268435456) as any).archive.snapshot).toMatchObject({ session: { lifecycle: "running" }, turns: [{ state: { status: "completed" } }] });
  } finally { await harness.close(); }
}, 30000);

test("an archive over the size limit is refused by export with no file, and an idle transfer is removed", async () => {
  const effects = join(mkdtempSync(join(root, "fx-")), "effects.log");
  const place = home("in-process", effects, { maxBytes: 200, idleMs: 40 });
  const harness = place.open();
  try {
    const { client } = harness;
    await client.initialize(); await client.createSession(setup);
    const small = await client.request("session/export", { to: { type: "transfer" } }).catch(error => error);
    // The empty session is already larger than this test's 200-byte limit.
    expect(small).toMatchObject({ code: "transfer_limit" });
    const target = join(place.directory, "too-big.harness");
    await expect(client.exportTo(target)).rejects.toMatchObject({ code: "transfer_limit" });
    expect(place.files()).toEqual([]);
    await expect(client.request("transfer/open", { bytes: 201, sha256: "0".repeat(64) })).rejects.toMatchObject({ code: "transfer_limit" });
    // An open transfer that goes quiet is closed and its file removed.
    const { transferId } = await client.request("transfer/open", { bytes: 100, sha256: "0".repeat(64) });
    expect(place.files()).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(place.files()).toEqual([]);
    await expect(client.request("transfer/write", { transferId, offset: 0, data: "AAAA" })).rejects.toMatchObject({ code: "not_found" });
    // A transfer still open when the connection ends is removed with it.
    await client.request("transfer/open", { bytes: 100, sha256: "0".repeat(64) });
    expect(place.files()).toHaveLength(1);
  } finally { await harness.close(); }
  expect(place.files()).toEqual([]);
});

test("stdio: a transfer file left by a killed process is removed when the next process starts", async () => {
  const effects = join(mkdtempSync(join(root, "fx-")), "effects.log");
  const place = home("stdio", effects);
  const doomed = place.open() as ReturnType<typeof spawnHarness>;
  await doomed.client.initialize();
  const { transferId } = await doomed.client.request("transfer/open", { bytes: 100, sha256: "0".repeat(64) });
  await doomed.client.request("transfer/write", { transferId, offset: 0, data: "AAAA" });
  expect(place.files().filter(name => name.startsWith(".transfer-"))).toHaveLength(1);
  doomed.child.kill("SIGKILL"); await doomed.child.exited; doomed.client.close();
  expect(place.files().filter(name => name.startsWith(".transfer-"))).toHaveLength(1);
  const next = place.open();
  try {
    await next.client.initialize();
    expect(place.files().filter(name => name.startsWith(".transfer-"))).toEqual([]);
  } finally { await next.close(); }
}, 15000);
