import { inspectOperatorView } from "./helpers/operator-view.ts";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelEvent } from "../src/contracts/events.ts";
import type { CreateParams, RpcNotification } from "../src/contracts/protocol.ts";
import { spawnHarness } from "./helpers/stdio.ts";

// Real child processes over stdio with SQLite sessions. Each crash is a SIGKILL
// raised inside the child immediately after one named commit (or tool effect),
// so nothing after that boundary ran: no event, no acknowledgment, no cleanup.
const root = mkdtempSync(join(tmpdir(), "harness-crash-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const setup: CreateParams = { sessionId: "crash", participants: [], channels: {}, config: {
  version: 1, system: "Test system", model: { protocol: "scripted", script: new URL("./fixtures/crash-scenario.jsonl", import.meta.url).pathname }, defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow", tools: {} } } } };
const push = (id: string, text: string, channel = "a") => ({ channel, item: { id, kind: "user_message" as const, sender: "ana", content: [{ type: "text" as const, text }] } });
const effects = (path: string) => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
const events = (wire: unknown[]) => (wire as RpcNotification[]).filter(message => "method" in message).map(message => message.params as ChannelEvent);

/** Start a child that dies at `fault`, send one message, and wait for the death. */
async function crashAt(fault: string) {
  const home = mkdtempSync(join(root, `case-${++n}-`)), log = join(home, "effects.log");
  const doomed = spawnHarness({ home, fault, effects: log });
  await doomed.client.initialize(); await doomed.client.createSession(setup);
  const ack = doomed.client.push(push("m1", "first")).then(value => value, error => error);
  expect(await doomed.child.exited).not.toBe(0);
  doomed.client.close();
  return { home, log, ack: await ack, seen: events(doomed.wire) };
}
/** Reopen the same home with no fault and load the session. */
async function reopen(home: string, log: string) {
  const harness = spawnHarness({ home, effects: log });
  await harness.client.initialize();
  const loaded = await inspectOperatorView(harness.client, { sessionId: "crash", config: setup.config });
  return { ...harness, loaded };
}
function turnEnded(harness: { client: ReturnType<typeof spawnHarness>["client"] }, turnId: string) {
  return new Promise<ChannelEvent>(resolve => harness.client.onChannelEvent(event => {
    if (event.event.type === "turn_ended" && event.event.turnId === turnId) resolve(event);
  }));
}

test("crash before take: the accepted input is still pending, runs once after reopen, and a retry finds the original", async () => {
  const crashed = await crashAt("acceptItem:1");
  // The acknowledgment never arrived, so the client cannot know it was accepted.
  expect(crashed.ack).toMatchObject({ code: "transport_closed" });
  expect(crashed.seen).toEqual([]);
  const harness = await reopen(crashed.home, crashed.log);
  try {
    if (!events(harness.wire).some(value => value.event.type === "turn_ended" && value.event.turnId === "1"))
      expect((await turnEnded(harness, "1")).event).toMatchObject({ outcome: "completed" });
    const tracked = await harness.client.reconcileChannel({ channel: "a", itemIds: ["m1"], turnIds: ["1"] });
    expect(tracked).toMatchObject({ items: [{ id: "m1", milestone: "seen", turnId: "1" }], turns: [{ turnId: "1", state: "completed" }] });
    // Resending the same ID resolves the unknown acknowledgment without new work.
    expect(await harness.client.push(push("m1", "first"))).toMatchObject({ duplicate: true, item: { milestone: "seen", turnId: "1" } });
    const status = await harness.client.status();
    expect(status).toMatchObject({ execution: "idle", channels: [{ channel: "a", pending: [] }] });
    expect(events(harness.wire).filter(event => event.event.type === "turn_started").map(event => event.event)).toMatchObject([{ type: "turn_started", turnId: "1", items: ["m1"] }]);
    expect(effects(crashed.log)).toEqual(["effect"]);
  } finally { await harness.close(); }
}, 15000);

test("crash after take: the input stays on one interrupted turn, is not run again, and the channel takes fresh work", async () => {
  const crashed = await crashAt("beginTurn:1");
  // Received was acknowledged or not depending on timing; either way the take committed.
  expect(crashed.seen).toEqual([]);
  const harness = await reopen(crashed.home, crashed.log);
  try {
    expect(harness.loaded).toMatchObject({
      status: { lifecycle: "running", execution: "idle", channels: [{ channel: "a", pending: [], unresolved: { turnId: "1", state: "interrupted", items: ["m1"], uncertainCalls: [] } }] },
      turns: [{ turnId: "1", state: "interrupted", items: ["m1"] }], items: [{ id: "m1", milestone: "taken", turnId: "1" }], messages: [] });
    expect(await harness.client.push(push("m1", "first"))).toMatchObject({ duplicate: true, item: { milestone: "taken", turnId: "1" } });
    const done = turnEnded(harness, "2");
    expect(await harness.client.push(push("m2", "fresh"))).toMatchObject({ duplicate: false, item: { milestone: "received" } });
    expect((await done).event).toMatchObject({ outcome: "completed" });
    // Only the fresh message ever started a turn in this process.
    expect(events(harness.wire).filter(event => event.event.type === "turn_started").map(event => event.event)).toMatchObject([{ type: "turn_started", turnId: "2", items: ["m2"] }]);
    const status = await harness.client.status();
    expect(status.channels[0]!.unresolved).toBeUndefined();
    expect(status).toMatchObject({ execution: "idle" });
  } finally { await harness.close(); }
}, 15000);

test("crash after a tool's external effect, before its result commits: reported uncertain and never replayed", async () => {
  const crashed = await crashAt("tool:1");
  expect(effects(crashed.log)).toEqual(["effect"]);
  // Events are not durable: whatever the dying process had published may or may
  // not have reached the client, but a completed result certainly did not.
  expect(crashed.seen.map(event => event.event).filter(event => event.type === "tool_call" && event.status === "completed")).toEqual([]);
  const harness = await reopen(crashed.home, crashed.log);
  try {
    expect(harness.loaded).toMatchObject({
      status: { execution: "idle", channels: [{ channel: "a", unresolved: { turnId: "1", state: "interrupted", uncertainCalls: ["rec-1"] } }] },
      turns: [{ turnId: "1", state: "interrupted", uncertainCalls: ["rec-1"] }], items: [{ id: "m1", milestone: "seen", turnId: "1" }] });
    // Nothing runs on reopen: wait well past any scheduling, then check the effect log.
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(events(harness.wire)).toEqual([]);
    expect(effects(crashed.log)).toEqual(["effect"]);
    const done = turnEnded(harness, "2");
    await harness.client.push(push("m2", "fresh"));
    expect((await done).event).toMatchObject({ outcome: "completed" });
    // The fresh turn answered without any tool call, and the old call stayed uncertain.
    expect(events(harness.wire).filter(event => event.event.type === "tool_call")).toEqual([]);
    expect(effects(crashed.log)).toEqual(["effect"]);
    const after = await inspectOperatorView(harness.client, { sessionId: "crash", config: setup.config });
    expect(after.turns).toMatchObject([{ turnId: "1", state: "interrupted", uncertainCalls: ["rec-1"] }, { turnId: "2", state: "completed" }]);
  } finally { await harness.close(); }
}, 15000);

test("a committed reply the client never received is recovered by load, and the channel continues", async () => {
  // The second model response commits before the process publishes it.
  const crashed = await crashAt("commitResponse:2");
  const delivered = crashed.seen.map(event => event.event).flatMap(event => event.type === "message_completed" ? [event.parts![0]!.text] : []);
  expect(delivered).not.toContain("First reply.");
  const harness = await reopen(crashed.home, crashed.log);
  try {
    expect(harness.loaded.messages.map(message => message.parts![0]!.text)).toEqual(["Recording.", "First reply."]);
    const missed = harness.loaded.messages[1]!;
    expect(missed).toMatchObject({ channel: "a", turnId: "1" });
    // Its turn had not committed completion, so it is interrupted with nothing uncertain.
    expect(harness.loaded.turns).toMatchObject([{ turnId: "1", state: "interrupted", uncertainCalls: [] }]);
    const done = turnEnded(harness, "2");
    await harness.client.push(push("m2", "fresh"));
    expect((await done).event).toMatchObject({ outcome: "completed" });
    const replies = events(harness.wire).map(event => event.event).flatMap(event => event.type === "message_completed" ? [event.parts![0]!.text] : []);
    expect(replies).toEqual(["Second reply."]);
    // Message IDs are stable: a later load repeats the recovered IDs and lists
    // the live message under the ID its event carried.
    const live = events(harness.wire).map(event => event.event).find(event => event.type === "message_completed")!;
    const again = await inspectOperatorView(harness.client, { sessionId: "crash", config: setup.config });
    expect(again.messages.slice(0, 2)).toEqual(harness.loaded.messages);
    expect(again.messages[2]).toMatchObject({ messageId: live.type === "message_completed" ? live.messageId : "", turnId: "2", parts: [{ text: "Second reply." }] });
    expect(effects(crashed.log)).toEqual(["effect"]);
  } finally { await harness.close(); }
}, 15000);

test("crash after receipt evidence and before reply commit keeps the receipt without a reply", async () => {
  // Non-streaming evidence commits before the response transaction.
  const crashed = await crashAt("confirm:2");
  expect(effects(crashed.log)).toEqual([]);
  const harness = await reopen(crashed.home, crashed.log);
  try {
    expect(harness.loaded.messages).toEqual([]);
    expect(harness.loaded.items).toMatchObject([{ id: "m1", milestone: "seen", turnId: "1" }]);
    // No response was committed or dispatched; there is no uncertain tool effect.
    expect(harness.loaded.turns).toMatchObject([{ turnId: "1", state: "interrupted", uncertainCalls: [] }]);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(effects(crashed.log)).toEqual([]);
  } finally { await harness.close(); }
}, 15000);

test("the open response precedes recovered work and its events have newer revisions", async () => {
  const crashed = await crashAt("acceptItem:1");
  const harness = spawnHarness({ home: crashed.home, effects: crashed.log });
  try {
    await harness.client.initialize();
    const done = turnEnded(harness, "1");
    const opened = await harness.client.openSession({ sessionId: "crash", config: setup.config });
    await done;
    const wire = harness.wire as any[];
    const response = wire.findIndex(message => message.result?.sessionId === "crash" && message.result?.revision === opened.revision);
    const firstEvent = wire.findIndex(message => message.method === "channel/event");
    expect(response).toBeGreaterThan(-1);
    expect(firstEvent).toBeGreaterThan(response);
    const revisions = events(wire).flatMap(event => event.revision === undefined ? [] : [event.revision]);
    expect(Math.min(...revisions)).toBeGreaterThan(opened.revision);
    expect(revisions).toEqual([...revisions].sort((x, y) => x - y));
  } finally { await harness.close(); }
}, 15000);

test("a second process cannot open a session that is owned; missing and existing sessions fail clearly", async () => {
  const home = mkdtempSync(join(root, `case-${++n}-`));
  const owner = spawnHarness({ home }), other = spawnHarness({ home });
  try {
    await owner.client.initialize(); await other.client.initialize();
    await expect(other.client.openSession({ sessionId: "crash", config: setup.config })).rejects.toMatchObject({ code: "not_found" });
    expect((await owner.client.initialize().catch(error => error)).code).toBe("already_exists");
    await owner.client.createSession(setup);
    await expect(other.client.openSession({ sessionId: "crash", config: setup.config })).rejects.toMatchObject({ code: "owner_conflict" });
    await expect(other.client.createSession(setup)).rejects.toMatchObject({ code: "already_exists" });
    await expect(other.client.createSession({ ...setup, sessionId: "../escape" })).rejects.toMatchObject({ code: "invalid_config" });
    // The refused process did not disturb the owner.
    expect(await owner.client.push(push("m1", "first"))).toMatchObject({ accepted: true });
  } finally { await Promise.all([owner.close(), other.close()]); }
}, 15000);
