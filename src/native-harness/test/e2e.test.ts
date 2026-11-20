import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelEvent, CreateParams, ProtocolConfig } from "../src/client.ts";
import { spawnHarness } from "./helpers/stdio.ts";

// The two end-to-end scenarios of the persistence spec. Everything goes through
// the public client (src/client.ts) to real `serve --stdio --home` child
// processes with SQLite sessions and scripted models; no provider key is used.
const root = mkdtempSync(join(tmpdir(), "harness-e2e-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
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
const texts = (events: ChannelEvent[]) => events.flatMap(event => event.event.type === "message_completed" ? [event.event.parts![0]!.text] : []);
const taken = (events: ChannelEvent[]) => events.flatMap(({ event }) => event.type === "turn_started" || event.type === "turn_took" ? event.items.map(item => `${item}@${event.turnId}`) : []);

test("crash during individual suspension reopens the channel and preserves pending input", async () => {
  const config: ProtocolConfig = { version: 1, system: "Crash during channel suspension", model: { protocol: "scripted", script: fixture("hold-scenario.json") }, defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow", tools: {} } } };
  const home = mkdtempSync(join(root, "channel-crash-")), effects = join(home, "effects.log");
  const first = spawnHarness({ home, effects, fault: "beginChannelSuspend:1" });
  await first.client.initialize(); await first.client.createSession({ sessionId: "crash", config, participants: [], channels: {} });
  await first.client.push(push("a", "a1", "start"));
  await until(() => lines(effects).includes("start:k"), "tool start");
  await first.client.push(push("a", "a2", "pending"));
  void first.client.suspendChannel({ channel: "a" }).catch(() => {});
  expect(await first.child.exited).not.toBe(0);
  first.client.close();
  const second = spawnHarness({ home, effects });
  try {
    await second.client.initialize();
    const loaded = await second.client.loadSession({ sessionId: "crash", config });
    expect(loaded.status.channels).toMatchObject([{ channel: "a", lifecycle: "open", pending: ["a2"] }]);
    expect(loaded.turns).toMatchObject([{ turnId: "1", state: "interrupted", items: ["a1"], uncertainCalls: ["hold-1"] }]);
    expect(loaded.items.find(item => item.id === "a2")).toMatchObject({ milestone: "received" });
    await second.client.push(push("a", "a3", "new work"));
  } finally { await second.close(); }
}, 20000);

test("clean relocation: suspend with a tool running, export, import into a fresh home, verify, then resume exactly once", async () => {
  const config: ProtocolConfig = { version: 1, system: "Relocation system", model: { protocol: "scripted", script: fixture("hold-scenario.json") }, defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow", tools: {} } } };
  const setup: CreateParams = { sessionId: "office", participants: [], channels: {}, config };
  const effects = join(mkdtempSync(join(root, "fx-")), "effects.log");
  const sourceHome = mkdtempSync(join(root, "source-")), destinationHome = mkdtempSync(join(root, "destination-"));

  // Source process: two channels working, input accepted mid-tool, clean suspension, export.
  const source = spawnHarness({ home: sourceHome, effects });
  const sourceEvents = watch(source);
  await source.client.initialize(); await source.client.createSession(setup);
  await Promise.all([source.client.push(push("a", "a1", "start a")), source.client.push(push("b", "b1", "start b"))]);
  await until(() => lines(effects).filter(line => line === "start:k").length === 2, "both tools to start");
  expect(await source.client.push(push("a", "a2", "arrived while the tool ran"))).toMatchObject({ duplicate: false, item: { milestone: "received" } });
  const suspending = source.client.suspend();
  await until(async () => (await source.client.status()).lifecycle === "suspending", "suspension to begin");
  writeFileSync(`${effects}.release-k`, "");
  expect(await suspending).toMatchObject({ lifecycle: "suspended" });
  const sourceView = await source.client.loadSession({ sessionId: "office", config });
  const archive = await source.client.exportArchive();
  // Stop the source before the copy runs anywhere. Closing stdin is stop; a suspended session keeps its checkpoints.
  await source.close();
  expect(taken(sourceEvents).sort()).toEqual(["a1@1", "b1@2"]);
  expect(lines(effects).sort()).toEqual(["done:k", "done:k", "start:k", "start:k"]);

  // Destination process: a fresh home on the same machine stands in for another host.
  const destination = spawnHarness({ home: destinationHome, effects });
  const events = watch(destination);
  try {
    await destination.client.initialize();
    await expect(destination.client.loadSession({ sessionId: "office", config })).rejects.toMatchObject({ code: "not_found" });
    expect(await destination.client.importArchive(archive)).toMatchObject({ sessionId: "office", lifecycle: "suspended" });
    const loaded = await destination.client.loadSession({ sessionId: "office", config });
    // Verified before resuming: the same timeline messages, turn IDs and pending input as the source.
    expect(loaded).toEqual(sourceView);
    expect(loaded.status).toMatchObject({ lifecycle: "suspended", execution: "suspended" });
    expect(loaded.turns).toMatchObject([{ turnId: "1", channel: "a", state: "suspended", items: ["a1"] }, { turnId: "2", channel: "b", state: "suspended", items: ["b1"] }]);
    expect(loaded.messages.map(message => [message.channel, message.turnId, message.parts![0]!.text]).sort()).toEqual([["a", "1", "Working."], ["b", "2", "Working."]]);
    expect(loaded.items.find(item => item.id === "a2")).toMatchObject({ milestone: "received", channel: "a" });
    expect(loaded.status.channels.find(channel => channel.channel === "a")!.pending).toEqual(["a2"]);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(events).toEqual([]);

    await destination.client.resume();
    await until(() => events.filter(event => event.event.type === "turn_ended").length === 2, "both resumed turns");
    // The pending input reached exactly one turn, in exactly one process.
    expect(taken(events)).toEqual(["a2@1"]);
    expect([...taken(sourceEvents), ...taken(events)].filter(entry => entry.startsWith("a2@"))).toEqual(["a2@1"]);
    expect(events.filter(event => event.event.type === "turn_ended").map(event => event.event.type === "turn_ended" && event.event.outcome)).toEqual(["completed", "completed"]);
    expect(texts(events).sort()).toEqual(["Finished.", "Finished."]);
    // The completed tool calls ran once across both processes.
    expect(events.filter(event => event.event.type === "tool_call")).toEqual([]);
    expect(lines(effects).sort()).toEqual(["done:k", "done:k", "start:k", "start:k"]);
    const after = await destination.client.loadSession({ sessionId: "office", config });
    expect(after.turns).toMatchObject([{ turnId: "1", state: "completed", items: ["a1", "a2"] }, { turnId: "2", state: "completed", items: ["b1"] }]);
    expect(after.items.map(item => [item.id, item.milestone, item.turnId])).toEqual([["a1", "seen", "1"], ["b1", "seen", "2"], ["a2", "seen", "1"]]);
    expect(after.status).toMatchObject({ lifecycle: "running", execution: "idle" });
  } finally { await destination.close(); }
}, 30000);

test("crash recovery: kills on both sides of take, a tool effect without a result and a missed reply are all reported, and nothing is replayed", async () => {
  const config: ProtocolConfig = { version: 1, system: "Recovery system", model: { protocol: "scripted", script: fixture("crash-scenario.json") }, defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow", tools: {} } } };
  const setup: CreateParams = { sessionId: "ledger", participants: [], channels: {}, config };
  const home = mkdtempSync(join(root, "crash-")), effects = join(home, "effects.log");
  const all: ChannelEvent[] = [];
  /** One process lifetime: optional load, one action, and (when a fault is set) death at that exact commit. */
  async function life(fault: string | undefined, act: (harness: ReturnType<typeof spawnHarness>, loaded: Awaited<ReturnType<ReturnType<typeof spawnHarness>["client"]["loadSession"]>> | undefined, events: ChannelEvent[]) => Promise<void>, create = false) {
    const harness = spawnHarness({ home, effects, fault });
    const events = watch(harness);
    try {
      await harness.client.initialize();
      const loaded = create ? (await harness.client.createSession(setup), undefined) : await harness.client.loadSession({ sessionId: "ledger", config });
      await act(harness, loaded, events);
      if (fault) expect(await harness.child.exited).not.toBe(0);
    } finally { all.push(...events); if (fault) harness.client.close(); else await harness.close(); }
  }

  // 1. Killed right after the input is accepted, before any turn takes it.
  await life("acceptItem:1", async harness => { void harness.client.push(push("a", "m1", "record this")).catch(() => {}); }, true);

  // 2. The input is still pending and runs. Killed after the tool's external effect, before its result commits.
  await life("tool:1", async (_harness, loaded) => {
    expect(loaded).toMatchObject({ turns: [], items: [{ id: "m1", milestone: "received" }], status: { channels: [{ channel: "a", pending: ["m1"] }] } });
  });
  expect(lines(effects)).toEqual(["effect"]);

  // 3. The effect is reported uncertain and not replayed. A fresh message is answered, but the process
  //    is killed after that reply commits and before the client receives it.
  await life("commitResponse:1", async (harness, loaded, events) => {
    expect(loaded!.turns).toMatchObject([{ turnId: "1", state: "interrupted", items: ["m1"], uncertainCalls: ["rec-1"] }]);
    expect(loaded!.items).toMatchObject([{ id: "m1", milestone: "seen", turnId: "1" }]);
    expect(loaded!.status).toMatchObject({ execution: "idle", channels: [{ channel: "a", pending: [], unresolved: { turnId: "1" } }] });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(events).toEqual([]);
    expect(lines(effects)).toEqual(["effect"]);
    void harness.client.push(push("a", "m2", "fresh after the crash")).catch(() => {});
  });

  // 4. Load returns the reply the client missed. Killed again right after the next input is taken.
  await life("beginTurn:1", async (harness, loaded) => {
    expect(loaded!.messages.map(message => [message.turnId, message.parts![0]!.text])).toEqual([["1", "Recording."], ["2", "First reply."]]);
    expect(texts(all)).not.toContain("First reply.");
    expect(loaded!.turns).toMatchObject([{ turnId: "1", state: "interrupted", uncertainCalls: ["rec-1"] }, { turnId: "2", state: "interrupted", items: ["m2"], uncertainCalls: [] }]);
    void harness.client.push(push("a", "m3", "taken, then the process dies")).catch(() => {});
  });

  // 5. A healthy process: the taken input is attached to exactly one interrupted turn and is not run again;
  //    the same channel accepts and completes fresh work.
  await life(undefined, async (harness, loaded, events) => {
    expect(loaded!.turns).toMatchObject([{ turnId: "1", state: "interrupted" }, { turnId: "2", state: "interrupted" }, { turnId: "3", state: "interrupted", items: ["m3"], uncertainCalls: [] }]);
    expect(loaded!.items.map(item => [item.id, item.milestone, item.turnId])).toEqual([["m1", "seen", "1"], ["m2", "seen", "2"], ["m3", "taken", "3"]]);
    // m2's receipt was committed before its reply and survives the crash.
    expect(loaded!.status.channels).toMatchObject([{ channel: "a", pending: [], unresolved: { turnId: "3", state: "interrupted" } }]);
    for (const [id, text] of [["m1", "record this"], ["m2", "fresh after the crash"], ["m3", "taken, then the process dies"]] as const)
      expect(await harness.client.push(push("a", id, text))).toMatchObject({ duplicate: true });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(events).toEqual([]);
    await harness.client.push(push("a", "m4", "fresh work on the same channel"));
    await until(() => events.some(event => event.event.type === "turn_ended"), "fresh turn");
    expect(taken(events)).toEqual(["m4@4"]);
    expect(events.at(-1)!.event).toMatchObject({ type: "turn_ended", turnId: "4", outcome: "completed" });
    expect(texts(events)).toEqual(["Second reply."]);
    const final = await harness.client.loadSession({ sessionId: "ledger", config });
    expect(final.turns.map(turn => [turn.turnId, turn.state, turn.items, turn.uncertainCalls ?? []])).toEqual([
      ["1", "interrupted", ["m1"], ["rec-1"]], ["2", "interrupted", ["m2"], []], ["3", "interrupted", ["m3"], []], ["4", "completed", ["m4"], []]]);
    expect(final.messages.map(message => message.parts![0]!.text)).toEqual(["Recording.", "First reply.", "Second reply."]);
    expect(final.status).toMatchObject({ execution: "idle", channels: [{ channel: "a", pending: [] }] });
    expect(final.status.channels[0]!.unresolved).toBeUndefined();
  });

  // Across five processes: every input was taken by exactly one turn, and the recorded tool ran once.
  // Events from a dying process may be lost, but none may ever name an input twice.
  expect(new Set(taken(all).map(entry => entry.split("@")[0])).size).toBe(taken(all).length);
  expect(taken(all)).toContain("m4@4");
  expect(all.filter(event => event.event.type === "tool_call" && event.event.status === "completed")).toEqual([]);
  expect(lines(effects)).toEqual(["effect"]);
}, 60000);
