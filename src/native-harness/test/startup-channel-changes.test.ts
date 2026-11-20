import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelEvent, PendingChannelChange, ProtocolConfig } from "../src/client.ts";
import { createInProcessHarness } from "../src/testing.ts";
import { parseChannelChanges, sameBatch } from "../src/interfaces/protocol/channel-changes.ts";
import { spawnHarness } from "./helpers/stdio.ts";

// Decision 0020: channel changes made while the harness was stopped are applied
// by the open, before recovered work can run. Durable cases go through the
// public client to real `serve --stdio` processes with SQLite sessions.
const root = mkdtempSync(join(tmpdir(), "harness-startup-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const config: ProtocolConfig = { version: 1, system: "Startup changes", model: { protocol: "scripted", script: fixture("hold-scenario.json") },
  defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} }, strict: { fallback: "deny", tools: {} } } };
const push = (channel: string, id: string, text: string) => ({ channel, item: { id, kind: "user_message" as const, sender: `user-${channel}`, content: [{ type: "text" as const, text }] } });
const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${what}`);
}
function watch(harness: ReturnType<typeof spawnHarness>) {
  const events: ChannelEvent[] = [];
  harness.client.onChannelEvent(event => { events.push(event); });
  return events;
}
const started = (events: ChannelEvent[], channel: string) => events.filter(event => event.channel === channel && (event.event.type === "turn_started" || event.event.type === "turn_resumed"));

/** A session whose process died with work outstanding: channel `a` has turn 1
 * running in its tool (recovered as interrupted) and `a2` accepted but never
 * taken. Without a startup batch the next open would run `a2`. */
async function crashed(name: string) {
  const home = mkdtempSync(join(root, `${name}-`)), effects = join(home, "effects.log");
  const first = spawnHarness({ home, effects });
  await first.client.initialize();
  await first.client.createSession({ sessionId: "s", config, participants: [], channels: {} });
  await first.client.push(push("a", "a1", "start"));
  await until(() => lines(effects).includes("start:k"), "tool start");
  await first.client.push(push("a", "a2", "pending"));
  first.child.kill("SIGKILL"); await first.child.exited; first.client.close();
  // Tools of later turns return at once.
  writeFileSync(`${effects}.release-k`, "");
  return { home, effects, open: (fault?: string) => spawnHarness({ home, effects, fault }) };
}
const load = (harness: ReturnType<typeof spawnHarness>, channelChanges?: PendingChannelChange[]) =>
  harness.client.loadSession({ sessionId: "s", config, ...(channelChanges ? { channelChanges } : {}) });

test("a suspension made while stopped holds recovered input; other channels run; a live resume takes the input once", async () => {
  const place = await crashed("suspend");
  const second = place.open(), events = watch(second);
  try {
    const init = await second.client.initialize();
    expect(init.description.capabilities.startupChannelChanges).toBe(true);
    const loaded = await load(second, [{ channel: "a", changeId: "v7", lifecycle: "suspended" }, { channel: "fresh", changeId: "v1", displayName: "Fresh", policy: "strict" }]);
    expect(loaded.channelChanges).toEqual([{ channel: "a", changeId: "v7", outcome: "applied" }, { channel: "fresh", changeId: "v1", outcome: "applied" }]);
    // The view already shows the result of the batch.
    expect(loaded.status.channels).toMatchObject([
      { channel: "a", lifecycle: "suspended", pending: ["a2"], waitingForResume: true },
      { channel: "fresh", lifecycle: "open", displayName: "Fresh", policy: "strict", pending: [] }]);
    expect(loaded.status.execution).toBe("idle");
    expect(loaded.turns).toMatchObject([{ turnId: "1", state: "interrupted", items: ["a1"] }]);
    // Another channel works while `a` stays parked.
    await second.client.push(push("b", "b1", "hello"));
    await until(() => events.some(event => event.channel === "b" && event.event.type === "turn_ended"), "b's turn");
    expect(started(events, "a")).toEqual([]);
    expect((await second.client.status()).channels.find(channel => channel.channel === "a")).toMatchObject({ lifecycle: "suspended", pending: ["a2"] });
    await expect(second.client.push(push("a", "a3", "refused"))).rejects.toMatchObject({ code: "channel_suspended" });
    // The backlog is intact and is taken exactly once after the live resume.
    await second.client.resumeChannel({ channel: "a" });
    await until(() => events.some(event => event.channel === "a" && event.event.type === "turn_ended"), "a's turn");
    expect(started(events, "a")).toMatchObject([{ event: { type: "turn_started", items: ["a2"] } }]);
  } finally { await second.close(); }
}, 20000);

test("a delete blocked by pending work suspends the channel, keeps its work and lets the rest of the session open; it applies once the work is withdrawn", async () => {
  const place = await crashed("delete");
  const batch: PendingChannelChange[] = [{ channel: "a", changeId: "del-1", lifecycle: "retired", displayName: "ignored when blocked" }, { channel: "b", changeId: "b-1", displayName: "Bob" }];
  const second = place.open(), events = watch(second);
  try {
    await second.client.initialize();
    const loaded = await load(second, batch);
    expect(loaded.channelChanges).toEqual([{ channel: "a", changeId: "del-1", outcome: "blocked", reason: "channel_busy" }, { channel: "b", changeId: "b-1", outcome: "applied" }]);
    const a = loaded.status.channels.find(channel => channel.channel === "a")!;
    expect(a).toMatchObject({ lifecycle: "suspended", pending: ["a2"], waitingForResume: true });
    expect(a.displayName).toBeUndefined();
    expect(loaded.items.find(item => item.id === "a2")).toMatchObject({ milestone: "received" });
    await second.client.push(push("b", "b1", "hello"));
    await until(() => events.some(event => event.channel === "b" && event.event.type === "turn_ended"), "b's turn");
    expect(started(events, "a")).toEqual([]);
    // The host resolves the obstacle through the live API.
    expect(await second.client.withdrawItem({ channel: "a", item: "a2" })).toMatchObject({ outcome: "withdrawn" });
  } finally { await second.close(); }

  const third = place.open();
  try {
    await third.client.initialize();
    const loaded = await load(third, batch);
    expect(loaded.channelChanges).toEqual([{ channel: "a", changeId: "del-1", outcome: "applied" }, { channel: "b", changeId: "b-1", outcome: "applied" }]);
    expect(loaded.status.channels.find(channel => channel.channel === "a")).toMatchObject({ lifecycle: "retired" });
  } finally { await third.close(); }

  // A repeated retirement is already applied; a retired ID cannot be reopened.
  const fourth = place.open();
  try {
    await fourth.client.initialize();
    const loaded = await load(fourth, [{ channel: "a", changeId: "del-1", lifecycle: "retired" }]);
    expect(loaded.channelChanges).toEqual([{ channel: "a", changeId: "del-1", outcome: "applied" }]);
  } finally { await fourth.close(); }
  const fifth = place.open();
  try {
    await fifth.client.initialize();
    const loaded = await load(fifth, [{ channel: "a", changeId: "re-1", lifecycle: "open", displayName: "Back" }, { channel: "gone", changeId: "g-1", lifecycle: "retired" }]);
    expect(loaded.channelChanges).toEqual([{ channel: "a", changeId: "re-1", outcome: "blocked", reason: "channel_retired" }, { channel: "gone", changeId: "g-1", outcome: "applied" }]);
    expect(loaded.status.channels.filter(channel => channel.lifecycle === "retired").map(channel => channel.channel)).toEqual(["a", "gone"]);
    await expect(fifth.client.push(push("gone", "g1", "refused"))).rejects.toMatchObject({ code: "channel_retired" });
  } finally { await fifth.close(); }
}, 30000);

test("an invalid batch is rejected whole and leaves every channel as it was", async () => {
  const place = await crashed("invalid");
  const second = place.open(), events = watch(second);
  try {
    await second.client.initialize();
    const valid = { channel: "new", changeId: "n1", displayName: "New" };
    const invalid: [unknown, string][] = [
      [[valid, { channel: "new", changeId: "n2" }], "invalid_params"],
      [[valid, { channel: "a", changeId: "p1", policy: "nope", lifecycle: "suspended" }], "invalid_policy"],
      [[valid, { channel: "a" }], "invalid_params"],
      [[valid, { channel: "a", changeId: "x", lifecycle: "suspending" }], "invalid_params"],
      [[valid, { channel: "a", changeId: "x", extra: true }], "invalid_params"],
      [[valid, { channel: "a", changeId: "x", displayName: "" }], "invalid_params"],
      [{ channel: "a", changeId: "x" }, "invalid_params"],
    ];
    for (const [batch, code] of invalid) await expect(load(second, batch as PendingChannelChange[])).rejects.toMatchObject({ code });
    // Nothing was created, renamed or suspended, and nothing ran meanwhile.
    expect(events).toEqual([]);
    const loaded = await load(second);
    expect(loaded.channelChanges).toBeUndefined();
    expect(loaded.status.channels).toMatchObject([{ channel: "a", lifecycle: "open", pending: ["a2"], waitingForResume: false }]);
    expect(loaded.status.channels[0]!.displayName).toBeUndefined();
    await until(() => events.some(event => event.channel === "a" && event.event.type === "turn_ended"), "recovered input to run");
  } finally { await second.close(); }
}, 20000);

test("a lost open response is safe to retry on the same connection: recorded results, nothing applied twice", async () => {
  const place = await crashed("repeat");
  const second = place.open(), events = watch(second);
  const batch: PendingChannelChange[] = [{ channel: "a", changeId: "v1", lifecycle: "suspended", displayName: "Alice" }];
  try {
    await second.client.initialize();
    const first = await load(second, batch);
    const again = await load(second, batch), bare = await load(second);
    expect(again.channelChanges).toEqual(first.channelChanges!);
    expect(bare.channelChanges).toEqual(first.channelChanges!);
    // A fresh view of the same state: no commit happened between the loads.
    expect(again.status).toEqual(first.status);
    expect(events.filter(event => event.event.type === "channel_state").length).toBeLessThanOrEqual(2);
    await expect(load(second, [{ channel: "a", changeId: "v2", lifecycle: "open" }])).rejects.toMatchObject({ code: "invalid_state" });
    expect((await second.client.status()).channels[0]).toMatchObject({ lifecycle: "suspended", displayName: "Alice", pending: ["a2"] });
    expect(started(events, "a")).toEqual([]);
  } finally { await second.close(); }
}, 20000);

test("a process that dies after committing the batch but before answering: resending the desired state on a new connection is safe", async () => {
  const place = await crashed("reconnect");
  const batch: PendingChannelChange[] = [{ channel: "a", changeId: "v1", lifecycle: "suspended" }, { channel: "c", changeId: "c1", displayName: "Carol" }];
  // Dies right after the suspension commits: the host never sees a response.
  const second = place.open("beginChannelSuspend:1");
  await second.client.initialize();
  await expect(load(second, batch)).rejects.toMatchObject({ code: "transport_closed" });
  expect(await second.child.exited).not.toBe(0);
  second.client.close();

  const third = place.open(), events = watch(third);
  try {
    await third.client.initialize();
    const loaded = await load(third, batch);
    expect(loaded.channelChanges).toEqual([{ channel: "a", changeId: "v1", outcome: "applied" }, { channel: "c", changeId: "c1", outcome: "applied" }]);
    expect(loaded.status.channels).toMatchObject([{ channel: "a", lifecycle: "suspended", pending: ["a2"] }, { channel: "c", displayName: "Carol", lifecycle: "open" }]);
    // No work was duplicated or lost by the retry.
    expect(loaded.turns).toHaveLength(1);
    expect(loaded.items.map(item => `${item.id}:${item.milestone}`)).toEqual(["a1:seen", "a2:received"]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(started(events, "a")).toEqual([]);
  } finally { await third.close(); }
}, 20000);

test("a resume in the batch continues a checkpoint only after the response; an incompatible checkpoint blocks and stays suspended", async () => {
  const home = mkdtempSync(join(root, "resume-")), effects = join(home, "effects.log");
  const first = spawnHarness({ home, effects });
  try {
    await first.client.initialize();
    await first.client.createSession({ sessionId: "s", config, participants: [], channels: {} });
    await first.client.push(push("a", "a1", "start"));
    await until(() => lines(effects).includes("start:k"), "tool start");
    const suspending = first.client.suspendChannel({ channel: "a" });
    await until(async () => (await first.client.status()).channels[0]?.lifecycle === "suspending", "suspension to begin");
    writeFileSync(`${effects}.release-k`, "");
    expect(await suspending).toMatchObject({ channel: { lifecycle: "suspended", activeTurn: { state: "suspended" } } });
  } finally { await first.close(); }

  const resume: PendingChannelChange[] = [{ channel: "a", changeId: "r1", lifecycle: "open" }];
  const changed = spawnHarness({ home, effects });
  try {
    await changed.client.initialize();
    const loaded = await changed.client.loadSession({ sessionId: "s", config: { ...config, system: "Another system" }, channelChanges: resume });
    expect(loaded.channelChanges).toEqual([{ channel: "a", changeId: "r1", outcome: "blocked", reason: "incompatible" }]);
    expect(loaded.status.channels).toMatchObject([{ channel: "a", lifecycle: "suspended", activeTurn: { turnId: "1", state: "suspended" } }]);
  } finally { await changed.close(); }

  const second = spawnHarness({ home, effects }), events = watch(second);
  try {
    await second.client.initialize();
    const loaded = await load(second, resume);
    expect(loaded.channelChanges).toEqual([{ channel: "a", changeId: "r1", outcome: "applied" }]);
    expect(loaded.status.channels).toMatchObject([{ channel: "a", lifecycle: "open", activeTurn: { turnId: "1", state: "running" } }]);
    await until(() => events.some(event => event.event.type === "turn_ended"), "resumed turn");
    expect(events.at(-1)).toMatchObject({ event: { type: "turn_ended", turnId: "1", outcome: "completed" } });
    // Everything the resumed turn produced came after the open response.
    const at = second.wire.findIndex(message => "result" in message && (message.result as { status?: unknown })?.status !== undefined);
    const work = second.wire.findIndex(message => "method" in message && ["message_completed", "tool_call", "turn_ended", "items_receipt"].includes(message.params.event.type));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(work).toBeGreaterThan(at);
  } finally { await second.close(); }
}, 30000);

test("create applies a batch before the new session starts; in-memory servers support it too", async () => {
  const harness = createInProcessHarness();
  try {
    await harness.client.initialize();
    await expect(harness.client.createSession({ sessionId: "bad", config, participants: [], channels: {}, channelChanges: [{ channel: "a", changeId: "1", policy: "nope" }] }))
      .rejects.toMatchObject({ code: "invalid_policy" });
    const created = await harness.client.createSession({ sessionId: "m", config, participants: [], channels: {},
      channelChanges: [{ channel: "a", changeId: "1", displayName: "Alice", lifecycle: "suspended" }, { channel: "b", changeId: "2", policy: "strict", lifecycle: "open" }] });
    expect(created).toEqual({ sessionId: "m", channelChanges: [{ channel: "a", changeId: "1", outcome: "applied" }, { channel: "b", changeId: "2", outcome: "applied" }] });
    expect((await harness.client.status()).channels).toMatchObject([{ channel: "a", displayName: "Alice", lifecycle: "suspended" }, { channel: "b", policy: "strict", lifecycle: "open" }]);
    await expect(harness.client.push(push("a", "a1", "refused"))).rejects.toMatchObject({ code: "channel_suspended" });
    // Null clears and a missing field leaves the value alone, through the live API's own rules.
    expect(await harness.client.editChannel({ channel: "a", displayName: null })).toMatchObject({ channel: { channel: "a", lifecycle: "suspended" } });
  } finally { harness.close(); }
});

test("batch parsing keeps null distinct from missing and compares batches by content", () => {
  const parsed = parseChannelChanges([{ channel: "a", changeId: "1", displayName: null }, { channel: "b", changeId: "2", policy: null, lifecycle: "open" }]);
  expect(parsed).toEqual([{ channel: "a", changeId: "1", displayName: null }, { channel: "b", changeId: "2", policy: null, lifecycle: "open" }]);
  expect(sameBatch(parsed, [{ changeId: "1", displayName: null, channel: "a" }, { channel: "b", changeId: "2", policy: null, lifecycle: "open" }])).toBe(true);
  expect(sameBatch(parsed, [{ channel: "a", changeId: "1" }, parsed[1]!])).toBe(false);
  expect(sameBatch(parsed, [parsed[1]!, parsed[0]!])).toBe(false);
  expect(sameBatch([], [])).toBe(true);
});
