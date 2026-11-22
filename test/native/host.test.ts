import { modelScenario } from "../../src/native-harness/test/helpers/scenario.ts";
/**
 * The shared native host against an in-process harness (same client interface as stdio, no process):
 * start once, the open sequence, channel changes made while stopped, saved submissions, reopening
 * (acp-client integration plan, Gate 2). Real processes are in `checkpoint.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessClientError, type ChannelEvent, type HarnessClient, type ProtocolConfig } from "../../src/native-harness/src/client.ts";
import { createInProcessHarness } from "../../src/native-harness/src/testing.ts";
import { HarnessIncompatibleError, HarnessUnavailableError, NativeHarnessHost, type NativeApprovalResponder, type ChannelPort, type ChannelView, type NativeConnection } from "../../src/native/host.ts";
import { NativeController } from "../../src/native/controller.ts";
import { createFileHostRecords, createMemoryHostRecords } from "../../src/native/records.ts";
import { prepareNativeLaunch } from "../../src/launcher.ts";
import { SqliteAgentPersistence, type ChannelPersistence } from "../../src/persistence/index.ts";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await Promise.resolve(clean()).catch(() => undefined); });
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
}
const until = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 600; i++) { if (predicate()) return; await tick(); }
  throw new Error(`timed out waiting for ${what}`);
};

/** A harness whose storage outlives each connection, and a host connected to it through the test seam. */
async function rig(options: {
  steps?: Parameters<typeof modelScenario>[0];
  restart?: { limit: number; windowMs: number };
  startupTimeoutMs?: number;
  approvalResponder?: NativeApprovalResponder;
  durable?: boolean;
  configureChannels?: (channels: ChannelPersistence) => void;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "acp-native-host-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "script.jsonl"), effects = join(directory, "effects.log");
  await writeFile(script, modelScenario(options.steps ?? Array.from({ length: 8 }, (_, i) => ({ content: `reply ${i + 1}`, calls: [] }))));
  const config: ProtocolConfig = { version: 1, system: "Host test", model: { protocol: "scripted", script }, defaultPolicy: "open",
    policies: { open: { fallback: "allow", tools: {} }, strict: { fallback: "deny", tools: {} }, ask: { fallback: "ask", tools: {} } } };
  // Durable through the harness's public testing entry point: SQLite sessions under this home.
  const home = join(directory, "home");
  /** Every client call, in order, across connections. */
  const calls: string[] = [];
  /** Per method: runs instead of the real call when set; receives the real call. */
  const intercept: Record<string, ((real: (...args: any[]) => Promise<any>, ...args: any[]) => Promise<any>) | undefined> = {};
  const connections: Array<{ crash(): void; client: HarnessClient }> = [];
  let failConnect: Error | null = null;
  const connect = async (): Promise<NativeConnection> => {
    if (failConnect) throw failConnect;
    const harness = createInProcessHarness({ home, effects });
    let closed!: () => void;
    const gone = new Promise<void>((resolve) => { closed = resolve; });
    const end = () => { harness.close(); closed(); };
    const client = new Proxy(harness.client, { get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function" || typeof key !== "string" || key.startsWith("on") || key === "close") return typeof value === "function" ? value.bind(target) : value;
      return (...args: unknown[]) => {
        calls.push(key);
        const real = (...actual: unknown[]) => (value as (...a: unknown[]) => Promise<unknown>).apply(target, actual);
        return intercept[key] ? intercept[key]!(real, ...args) : real(...args);
      };
    } });
    connections.push({ crash: end, client });
    cleanups.push(end);
    return { client, closed: gone, async kill() { end(); } };
  };
  const records = createMemoryHostRecords();
  const persistence = options.durable ? await SqliteAgentPersistence.open({ path: join(directory, "agent.sqlite") }) : undefined;
  if (persistence) {
    cleanups.push(() => persistence.close());
    options.configureChannels?.(persistence.channels);
  }
  const blocked: unknown[] = [];
  const host = new NativeHarnessHost({ sessionId: "agent-1", config, home: directory, records, connect, requestTimeoutMs: 2000,
    approvalResponder: options.approvalResponder, onChannelChangeBlocked: (result) => blocked.push(result), ...(options.restart ? { restart: options.restart } : {}),
    ...(options.startupTimeoutMs ? { startupTimeoutMs: options.startupTimeoutMs } : {}) }, persistence?.channels);
  cleanups.push(() => host.stop());
  const attach = (channel: string, busy = false) => {
    const events: ChannelEvent[] = [], views: ChannelView[] = [], notes: string[] = [];
    const port: ChannelPort = { event: (event) => { events.push(event); }, reconcile: (view) => { views.push(view); },
      disconnected: () => { notes.push("disconnected"); }, failed: (error) => { notes.push(`failed:${error.name}`); }, busy: () => busy };
    host.attach(channel, port);
    return { events, views, notes };
  };
  return { host, records, calls, intercept, connections, blocked, attach, config, effects, failConnect: (error: Error | null) => { failConnect = error; } };
}
const input = (id: string, channel = "a", text = "hello") => ({ id, channel, sender: "ana", text });

describe("starting", () => {
  test("concurrent first uses share one start; handlers are attached before initialize; create follows a confirmed not_found", async () => {
    const { host, calls, connections } = await rig();
    expect(host.state).toBe("stopped");
    const pushes = Promise.all([host.push(input("m1", "a")), host.push(input("m2", "b")), host.ensureStarted()]);
    expect(host.state).toBe("starting");
    const [first, second] = await pushes;
    expect(host.launches).toBe(1);
    expect(connections).toHaveLength(1);
    expect(host.state).toBe("running");
    expect(first).toMatchObject({ id: "m1", channel: "a", milestone: "received" });
    expect(second).toMatchObject({ id: "m2", channel: "b" });
    // Load first; the session did not exist, so it was created and then loaded for its view.
    expect(calls.slice(0, 4)).toEqual(["initialize", "openSession", "createSession", "status"]);
    await host.ensureStarted();
    expect(host.launches).toBe(1);
  });

  test("a failed start rejects whoever needed it and is not retried by itself; the next use tries again", async () => {
    const { host, failConnect, records } = await rig();
    failConnect(new Error("cannot spawn"));
    await expect(host.push(input("m1"))).rejects.toThrow("cannot spawn");
    expect(host.state).toBe("stopped");
    expect(host.launches).toBe(0);
    // Nothing was written for it and its caller was told it failed: it must never run later.
    expect(records.submission("m1")).toBeUndefined();
    failConnect(null);
    expect(await host.push(input("m1"))).toMatchObject({ id: "m1" });
    expect(host.launches).toBe(1);
  });

  test("a harness that does not open within the startup deadline is killed and the start fails", async () => {
    const { host, intercept, connections } = await rig({ startupTimeoutMs: 60 });
    intercept.initialize = () => new Promise(() => undefined);
    await expect(host.ensureStarted()).rejects.toBeInstanceOf(HarnessUnavailableError);
    expect(host.state).toBe("stopped");
    expect(connections).toHaveLength(1);
    intercept.initialize = undefined;
    await host.ensureStarted();
    expect(host.state).toBe("running");
  });

  test("a connection returned after the startup deadline is killed before initialize", async () => {
    let resolveConnection!: (connection: NativeConnection) => void;
    const pending = new Promise<NativeConnection>(resolve => { resolveConnection = resolve; });
    const host = new NativeHarnessHost({ sessionId: "late", home: tmpdir(), startupTimeoutMs: 20, connect: () => pending });
    let initialized = 0, killed = 0;
    const client = { async initialize() { initialized++; throw new Error("unexpected initialize"); }, onChannelEvent() {} } as unknown as HarnessClient;
    await expect(host.ensureStarted()).rejects.toBeInstanceOf(HarnessUnavailableError);
    resolveConnection({ client, closed: new Promise(() => {}), async kill() { killed++; } });
    await tick();
    expect({ initialized, killed, state: host.state }).toEqual({ initialized: 0, killed: 1, state: "stopped" });
  });

  test("a harness without a required capability is refused before any session is opened", async () => {
    const { host, intercept, calls } = await rig();
    intercept.initialize = async (real, ...args) => {
      const result = await real(...args);
      delete result.description.capabilities.startupChannelChanges;
      return result;
    };
    await expect(host.ensureStarted()).rejects.toBeInstanceOf(HarnessIncompatibleError);
    expect(calls).toEqual(["initialize"]);
  });

  test("the host launcher receives the native-harness kind and its environment is used as returned", async () => {
    const seen: unknown[] = [];
    const prepared = await prepareNativeLaunch({ async prepare(request) { seen.push(request); return { command: ["docker", "exec", "-i", "box", ...request.targetCommand], spawnEnv: { ONLY: "this" } }; } },
      { command: ["harness", "serve"], env: { IGNORED: "by a launcher" } });
    expect(seen).toEqual([{ kind: "native-harness", targetCommand: ["harness", "serve"] }]);
    expect(prepared).toMatchObject({ command: ["docker", "exec", "-i", "box", "harness", "serve"], spawnEnv: { ONLY: "this" } });
    const plain = await prepareNativeLaunch(undefined, { command: ["harness"], env: { EXTRA: "1" }, cwd: "/work" });
    expect(plain.spawnCwd).toBe("/work");
    expect(plain.spawnEnv.EXTRA).toBe("1");
    await expect(prepareNativeLaunch(undefined, { command: [] })).rejects.toThrow("cannot be empty");
  });
});

for (const durable of [false, true]) describe(durable ? "channel changes (SQLite)" : "channel changes (memory)", () => {
  test("changes made while stopped never start the harness, are coalesced, go inside the open, and are cleared when confirmed", async () => {
    const { host, records, calls } = await rig({ durable });
    expect(await host.changeChannel("a", { displayName: "First" })).toEqual({ state: "pending" });
    expect(await host.changeChannel("a", { displayName: "Alice", policy: "strict" })).toEqual({ state: "pending" });
    expect(await host.changeChannel("b", { lifecycle: "suspended" })).toEqual({ state: "pending" });
    expect(host.state).toBe("stopped");
    expect((await host.pendingChannelChanges()).map((change) => [change.channel, change.desire])).toEqual([
      ["a", { displayName: "Alice", policy: "strict" }], ["b", { lifecycle: "suspended" }]]);
    await host.ensureStarted();
    expect(await host.pendingChannelChanges()).toEqual([]);
    const status = await host.status();
    expect(status.channels).toMatchObject([{ channel: "a", displayName: "Alice", policy: "strict", lifecycle: "open" }, { channel: "b", lifecycle: "suspended" }]);
    // Nothing went through the live channel methods: the open carried it all.
    expect(calls.filter((call) => call.endsWith("Channel"))).toEqual([]);
    await expect(host.push(input("m1", "b"))).rejects.toMatchObject({ code: "channel_suspended" });
    expect(records.submission("m1")).toBeUndefined(); // a definite refusal leaves nothing to retry
  });

  test("an edit made during the open is not cleared by the open's acknowledgment; it is sent live, before fresh input", async () => {
    const { host, calls, intercept } = await rig({ durable });
    await host.changeChannel("a", { displayName: "Sent with open" });
    const created = barrier(), acknowledge = barrier();
    cleanups.push(acknowledge.release);
    intercept.createSession = async (real, ...args) => {
      const result = await real(...args);
      created.release();
      await acknowledge.reached;
      return result;
    };
    const pushed = host.push(input("m1", "a"));
    await created.reached;
    // Past the cutoff: this version was not in the batch.
    expect(await host.changeChannel("a", { displayName: "Edited during open" })).toEqual({ state: "pending" });
    expect(await host.pendingChannelChanges()).toMatchObject([{ channel: "a", version: 2 }]);
    acknowledge.release();
    await pushed;
    expect(await host.pendingChannelChanges()).toEqual([]);
    expect((await host.status()).channels).toMatchObject([{ channel: "a", displayName: "Edited during open", pending: expect.any(Array) }]);
    // The live edit reached the harness before the input that was waiting for the open.
    expect(calls.indexOf("editChannel")).toBeGreaterThan(calls.indexOf("createSession"));
    expect(calls.indexOf("editChannel")).toBeLessThan(calls.indexOf("push"));
  });

  test("while running, a change is applied live in order with that channel's inputs; null clears and a missing field is left alone", async () => {
    const { host, calls } = await rig({ durable });
    await host.ensureStarted();
    expect(await host.changeChannel("a", { displayName: "Alice", policy: "strict" })).toEqual({ state: "applied" });
    expect(await host.changeChannel("a", { policy: null })).toEqual({ state: "applied" });
    expect((await host.status()).channels[0]).toMatchObject({ channel: "a", displayName: "Alice" });
    expect((await host.status()).channels[0]!.policy).toBeUndefined();
    expect(await host.changeChannel("a", { lifecycle: "suspended" })).toEqual({ state: "applied" });
    await expect(host.push(input("m1", "a"))).rejects.toMatchObject({ code: "channel_suspended" });
    const resumed = host.changeChannel("a", { lifecycle: "open" });
    const pushed = host.push(input("m2", "a"));
    expect(await resumed).toEqual({ state: "applied" });
    expect(await pushed).toMatchObject({ id: "m2" });
    expect(calls.lastIndexOf("resumeChannel")).toBeLessThan(calls.lastIndexOf("push"));
    expect(await host.pendingChannelChanges()).toEqual([]);
  });

  test("a retired channel cannot be reopened: the change is blocked, reported, and stays pending for the host; a repeated retirement is applied", async () => {
    const { host, blocked } = await rig({ durable });
    await host.ensureStarted();
    expect(await host.changeChannel("a", { displayName: "Alice" })).toEqual({ state: "applied" });
    expect(await host.changeChannel("a", { lifecycle: "retired" })).toEqual({ state: "applied" });
    expect(await host.changeChannel("a", { lifecycle: "retired" })).toEqual({ state: "applied" });
    expect(await host.changeChannel("a", { displayName: "Back", lifecycle: "open" })).toEqual({ state: "blocked", reason: "channel_retired" });
    expect(blocked).toEqual([{ channel: "a", changeId: expect.any(String), outcome: "blocked", reason: "channel_retired" }]);
    expect(await host.pendingChannelChanges()).toMatchObject([{ channel: "a", desire: { displayName: "Back", lifecycle: "open" } }]);
    expect((await host.status()).channels[0]).toMatchObject({ channel: "a", displayName: "Alice", lifecycle: "retired" });
  });

  test("a delete that finds pending work suspends the channel instead, keeps the work, is reported and stays pending; the next open sends it again", async () => {
    const steps = [{ content: "Working.", calls: [{ id: "hold-1", name: "hold", arguments: { key: "k" } }] }, { content: "Finished.", calls: [] }, { content: "Next.", calls: [] }];
    const { host, blocked, attach, effects, calls } = await rig({ steps, durable });
    const channel = attach("a", true);
    await host.push(input("a1", "a", "start"));
    await until(() => channel.events.some((event) => event.event.type === "tool_call"), "the tool to start");
    await host.push(input("a2", "a", "accepted while the tool runs"));
    const deleting = host.changeChannel("a", { lifecycle: "retired" });
    // The suspension waits for the running tool; release it so the turn can reach its boundary.
    await until(() => host.channel("a")?.lifecycle === "suspending", "the suspension to begin");
    writeFileSync(`${effects}.release-k`, "");
    expect(await deleting).toEqual({ state: "blocked", reason: "channel_busy" });
    expect(blocked).toEqual([{ channel: "a", changeId: expect.any(String), outcome: "blocked", reason: "channel_busy" }]);
    const retirement = await host.pendingChannelChanges();
    expect(retirement).toMatchObject([{ channel: "a", desire: { lifecycle: "retired" } }]);
    const status = (await host.status()).channels[0]!;
    expect(status).toMatchObject({ channel: "a", lifecycle: "suspended", waitingForResume: true });
    expect([...status.pending, ...(status.activeTurn ? ["checkpoint"] : [])].length).toBeGreaterThan(0);
    await expect(host.resumeChannel("a")).rejects.toMatchObject({ code: "channel_retired" });
    expect(calls).not.toContain("resumeChannel");
    expect(await host.pendingChannelChanges()).toEqual(retirement);
    expect((await host.status()).channels[0]).toMatchObject({
      lifecycle: "suspended", waitingForResume: true, pending: status.pending,
    });
    // Stopped and started again: the delete is still the host's desired state and is re-evaluated.
    await host.stop();
    await host.ensureStarted();
    expect(blocked).toHaveLength(2);
    expect(await host.pendingChannelChanges()).toMatchObject([{ channel: "a", desire: { lifecycle: "retired" } }]);
    expect((await host.status()).channels[0]).toMatchObject({ lifecycle: "suspended" });
  });
});

describe("durable channel ordering", () => {
  test("an old live acknowledgement leaves a newer durable edit pending for delivery", async () => {
    const { host, intercept, calls } = await rig({ durable: true });
    await host.changeChannel("a", { displayName: "Initial" });
    await host.ensureStarted();
    const edited = barrier(), acknowledge = barrier();
    cleanups.push(acknowledge.release);
    intercept.editChannel = async (real, ...args) => {
      const result = await real(...args);
      if (args[0].displayName === "Earlier") {
        edited.release();
        await acknowledge.reached;
      }
      return result;
    };
    const earlier = host.changeChannel("a", { displayName: "Earlier" });
    await edited.reached;
    const [{ version }] = await host.pendingChannelChanges();
    const newer = host.changeChannel("a", { displayName: "Newer", policy: "strict" });
    const [pending] = await host.pendingChannelChanges();
    expect(pending).toMatchObject({ desire: { displayName: "Newer", policy: "strict" } });
    expect(pending.version).toBeGreaterThan(version);
    acknowledge.release();
    expect(await Promise.all([earlier, newer])).toEqual([{ state: "applied" }, { state: "applied" }]);
    expect(calls.filter((call) => call === "editChannel")).toHaveLength(2);
    expect((await host.status()).channels).toMatchObject([{ channel: "a", displayName: "Newer", policy: "strict" }]);
    expect(await host.pendingChannelChanges()).toEqual([]);
  });

  test("a live edit reserves its position before its durable write resolves", async () => {
    const writing = barrier(), commit = barrier();
    const { host, calls } = await rig({ durable: true, configureChannels(channels) {
      const desire = channels.desire.bind(channels);
      channels.desire = async (channel, edit) => {
        writing.release();
        await commit.reached;
        return desire(channel, edit);
      };
    } });
    cleanups.push(commit.release);
    await host.ensureStarted();
    const changing = host.changeChannel("a", { lifecycle: "suspended" });
    await writing.reached;
    const pushed = host.push(input("m1"));
    void pushed.catch(() => undefined);
    commit.release();
    expect(await changing).toEqual({ state: "applied" });
    await expect(pushed).rejects.toMatchObject({ code: "channel_suspended" });
    expect(calls.indexOf("suspendChannel")).toBeLessThan(calls.indexOf("push"));
  });

  test("an edit committed during the post-open scan is delivered before a newer push", async () => {
    const scanned = barrier(), finishScan = barrier();
    let reads = 0;
    const { host, calls } = await rig({ durable: true, configureChannels(channels) {
      const pendingChanges = channels.pendingChanges.bind(channels);
      channels.pendingChanges = async () => {
        const changes = await pendingChanges();
        if (++reads === 2) {
          scanned.release();
          await finishScan.reached;
        }
        return changes;
      };
    } });
    cleanups.push(finishScan.release);
    const started = host.ensureStarted();
    await scanned.reached;
    expect(host.state).toBe("starting");
    expect(await host.changeChannel("a", { lifecycle: "suspended" })).toEqual({ state: "pending" });
    const pushed = host.push(input("m1"));
    void pushed.catch(() => undefined);
    finishScan.release();
    await started;
    await expect(pushed).rejects.toMatchObject({ code: "channel_suspended" });
    expect(calls.indexOf("suspendChannel")).toBeLessThan(calls.indexOf("push"));
    expect(await host.pendingChannelChanges()).toEqual([]);
  });

  test("a failed durable live edit rejects its caller and releases the next push", async () => {
    const error = new Error("channel write failed");
    const { host } = await rig({ durable: true, configureChannels(channels) {
      channels.desire = async () => { throw error; };
    } });
    await host.ensureStarted();
    const changing = host.changeChannel("a", { lifecycle: "suspended" });
    const pushed = host.push(input("m1"));
    await expect(changing).rejects.toBe(error);
    await expect(pushed).resolves.toMatchObject({ id: "m1" });
    expect(await host.pendingChannelChanges()).toEqual([]);
  });

  test("stopped operator suspend and resume reject with not_running and preserve a pending retirement", async () => {
    const { host, calls } = await rig({ durable: true });
    await host.changeChannel("a", { lifecycle: "retired" });
    const before = await host.pendingChannelChanges();
    for (const invoke of [host.suspendChannel.bind(host), host.resumeChannel.bind(host)]) {
      const operation = invoke("a");
      await expect(operation).rejects.toBeInstanceOf(HarnessUnavailableError);
      await expect(operation).rejects.toMatchObject({ code: "not_running" });
    }
    expect(await host.pendingChannelChanges()).toEqual(before);
    expect(calls).toEqual([]);
  });
});

describe("submissions", () => {
  test("the id and payload are saved before the push is sent, and confirmed by its receipt", async () => {
    const { host, records, intercept } = await rig();
    await host.ensureStarted();
    let savedAtSend: unknown;
    intercept.push = (real, ...args) => { savedAtSend = records.submission("m1"); return real(...args); };
    await host.push({ id: "m1", channel: "a", sender: "ana", text: "exact payload", policy: "strict" });
    expect(savedAtSend).toEqual({ id: "m1", channel: "a", sender: "ana", text: "exact payload", policy: "strict", state: "unknown" });
    expect(records.submission("m0")).toBeUndefined();
    expect(records.submission("m1")).toMatchObject({ state: "accepted" });
    host.settle(["m1"]);
    expect(records.submission("m1")).toBeUndefined();
  });

  test("a push whose response is lost on a live connection is repeated with the same id and payload; the harness holds one input", async () => {
    const { host, intercept, calls } = await rig();
    await host.ensureStarted();
    const sent: unknown[] = [];
    let lose = true;
    intercept.push = async (real, ...args) => {
      sent.push(structuredClone(args[0]));
      const result = await real(...args); // the harness commits the input
      if (lose) { lose = false; throw new HarnessClientError("timeout", "Request timed out: channel/push"); }
      return result;
    };
    const item = await host.push(input("m1", "a", "only once"));
    expect(item).toMatchObject({ id: "m1" });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(calls.filter((call) => call === "push")).toHaveLength(2);
    await until(() => true, "settle");
    const status = await host.status();
    expect(status.channels).toHaveLength(1);
    expect(await host.push(input("m1", "a", "only once"))).toMatchObject({ id: "m1" });
  });

  test("a push lost with its connection is settled by the reopen: found in the view, or sent again with the same payload", async () => {
    const { host, intercept, connections, records, attach } = await rig();
    const channel = attach("a");
    await host.ensureStarted();
    // Committed by the harness, then the connection dies before the response.
    const lost = () => { throw new HarnessClientError("transport_closed", "Transport closed"); };
    // One-shot: the retry after the reopen must reach the new connection untouched.
    intercept.push = async (real, ...args) => { intercept.push = undefined; await real(...args); connections[0]!.crash(); return lost(); };
    const accepted = host.push(input("m1", "a", "committed"));
    await until(() => connections.length === 2 && host.state === "running", "the host to reopen");
    expect(await accepted).toMatchObject({ id: "m1", channel: "a" });
    expect(records.submission("m1")).toMatchObject({ state: "accepted" });
    expect(channel.notes).toContain("disconnected");
    expect(channel.views).toHaveLength(2);
    expect(channel.views[1]!.items.map((item) => item.id)).toEqual(["m1"]);
    expect(host.launches).toBe(2);

    // Never reached the harness: the connection dies before it is written.
    intercept.push = async () => { intercept.push = undefined; connections[1]!.crash(); return lost(); };
    const second = host.push(input("m2", "a", "never arrived"));
    await until(() => connections.length === 3, "a second reopen");
    expect(await second).toMatchObject({ id: "m2", milestone: "received" });
    const items = (await host.status()).channels[0]!.pending.concat();
    expect(new Set(items).size).toBe(items.length);
  });

  test("an old process's events are ignored after it is replaced, and events for an unattached channel wait for its conversation", async () => {
    const { host, attach } = await rig();
    await host.push(input("m1", "later"));
    await tick(50);
    const late = attach("later");
    expect(late.events.map((event) => event.event.type)).toContain("turn_started");
    expect(late.events.at(-1)).toMatchObject({ event: { type: "turn_ended", outcome: "completed" } });
  });
});

describe("losing the harness", () => {
  test("a loss with nothing outstanding does not reopen until the next use", async () => {
    const { host, connections, attach } = await rig();
    const idle = attach("a");
    await host.ensureStarted();
    connections[0]!.crash();
    await until(() => host.state === "stopped", "the loss to be seen");
    await tick(30);
    expect(host.launches).toBe(1);
    expect(idle.notes).toEqual(["disconnected"]);
    await host.push(input("m1"));
    expect(host.launches).toBe(2);
  });

  test("a loss while a conversation has a turn reopens at once; when restarts run out the host fails explicitly until restart()", async () => {
    const { host, connections, attach, failConnect } = await rig({ restart: { limit: 2, windowMs: 60_000 } });
    const working = attach("a", true);
    await host.ensureStarted();
    connections[0]!.crash();
    await until(() => host.launches === 2 && host.state === "running", "an automatic reopen");
    expect(working.views).toHaveLength(2);
    failConnect(new Error("still down"));
    connections[1]!.crash();
    await until(() => host.state === "failed", "restarts to run out");
    expect(working.notes).toContain("failed:HarnessUnavailableError");
    await expect(host.push(input("m1"))).rejects.toBeInstanceOf(HarnessUnavailableError);
    failConnect(null);
    await host.restart();
    expect(host.state).toBe("running");
    expect(await host.push(input("m1"))).toMatchObject({ id: "m1" });
  });

  test("stop ends the process, fails what was waiting, and is never followed by an automatic reopen", async () => {
    const { host, attach, intercept } = await rig();
    const working = attach("a", true);
    await host.ensureStarted();
    intercept.push = () => new Promise(() => undefined);
    const waiting = host.push(input("m1"));
    await tick();
    await host.stop();
    await expect(waiting).rejects.toBeInstanceOf(HarnessUnavailableError);
    expect(host.state).toBe("stopped");
    await tick(30);
    expect(host.launches).toBe(1);
    expect(working.notes).toContain("failed:HarnessUnavailableError");
  });
});

describe("host records", () => {
  test("an older confirmation never clears a newer change, and versions never repeat", () => {
    const records = createMemoryHostRecords();
    const first = records.desire("a", { displayName: "One" });
    const second = records.desire("a", { policy: "strict" });
    expect(second).toEqual({ channel: "a", version: 2, desire: { displayName: "One", policy: "strict" } });
    expect(records.confirmChange("a", first.version)).toBe(false);
    expect(records.pendingChange("a")).toMatchObject({ version: 2 });
    expect(records.confirmChange("a", second.version)).toBe(true);
    expect(records.pendingChange("a")).toBeUndefined();
    expect(records.desire("a", { lifecycle: "retired" }).version).toBe(3);
  });

  test("a saved submission keeps its first payload; the file store survives a new instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-native-records-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "nested", "host.json");
    const first = createFileHostRecords(path);
    first.saveSubmission({ id: "m1", channel: "a", sender: "ana", text: "original", state: "unknown" });
    first.saveSubmission({ id: "m1", channel: "a", sender: "ana", text: "changed", state: "unknown" });
    first.saveSubmission({ id: "m2", channel: "b", sender: "bo", text: "other", state: "unknown" });
    first.markAccepted("m2");
    first.desire("a", { lifecycle: "suspended" });
    const second = createFileHostRecords(path);
    expect(second.submission("m1")).toEqual({ id: "m1", channel: "a", sender: "ana", text: "original", state: "unknown" });
    expect(second.submissions("b")).toEqual([{ id: "m2", channel: "b", sender: "bo", text: "other", state: "accepted" }]);
    expect(second.pendingChanges()).toEqual([{ channel: "a", version: 1, desire: { lifecycle: "suspended" } }]);
    second.settleSubmission("m1");
    expect(createFileHostRecords(path).submissions().map((submission) => submission.id)).toEqual(["m2"]);
    expect(second.desire("b", {}).version).toBe(2);
  });
});

test("the host responder owns an unattached approval and answers once", async () => {
  let answer: ((decision: "allow_once" | "deny") => Promise<boolean>) | undefined;
  let closed: AbortSignal | undefined;
  let requests = 0;
  const { host, calls } = await rig({
    steps: [
      { content: null, calls: [{ id: "echo-1", name: "echo", arguments: { text: "approved" } }] },
      { content: "complete", calls: [] },
    ],
    approvalResponder(_request, respond, signal) { requests++; answer = respond; closed = signal; },
  });
  await host.start();
  await host.push({ ...input("approval-input"), policy: "ask" });
  await until(() => answer !== undefined, "host approval responder");
  const controller = new NativeController({ host, channelId: "a" });
  const observed: string[] = [];
  controller.subscribeTurns(turn => { if (turn.kind === "turn_started") observed.push(turn.turnId); });
  const first = await controller.attachObservation();
  expect(await controller.attachObservation()).toBe(first);
  expect(observed).toHaveLength(1);
  expect(calls).not.toContain("channelMessages");
  const status = await host.operatorStatus();
  expect(status.workingChannels).toBe(1);
  expect(status.stale).toBe(false);
  const requestId = status.session?.channels[0]?.activeTurn?.phase?.id;
  if (!requestId) throw new Error("Status did not show the approval");
  expect(await host.respondApproval(requestId, "allow_once")).toBe(false);
  first.dispose();
  expect(controller.attachmentStatus).toBe("disconnected");
  expect(await answer!("allow_once")).toBe(true);
  expect(await answer!("allow_once")).toBe(false);
  await until(() => Boolean(closed?.aborted), "approval closure");
  expect(requests).toBe(1);
  expect(calls.filter(method => method === "respondApproval")).toHaveLength(1);
});

test("catch-up advances only through committed pages and stays opt-in", async () => {
  const { host, calls, intercept } = await rig();
  const observer = attachForTest();
  function attachForTest() {
    const events: ChannelEvent[] = [];
    const detach = host.attach("a", { event: event => events.push(event), reconcile() {}, disconnected() {}, failed() {}, busy: () => false });
    return { events, detach };
  }
  await host.start();
  const push = async (id: string) => {
    const completed = observer.events.filter(({ event }) => event.type === "turn_ended").length;
    await host.push(input(id));
    await until(() => observer.events.filter(({ event }) => event.type === "turn_ended").length > completed, id);
  };
  await push("first");
  expect(calls).not.toContain("channelMessages");
  const newest = await host.conversationMessages({ channel: "a", limit: 1 });
  let position = newest.messages[0]!.position;
  await push("second");
  const committed: string[] = [];
  const abort = new AbortController();
  intercept.channelMessages = (real, params) => real({ ...params, limit: 1 });
  await expect(host.catchUp("a", position, async (messages, next) => {
    committed.push(...messages.map(message => message.messageId));
    position = next;
    abort.abort();
  }, abort.signal)).rejects.toThrow();
  expect(committed).toEqual(["item:second"]);
  await host.catchUp("a", position, async (messages, next) => {
    committed.push(...messages.map(message => message.messageId));
    position = next;
  });
  expect(committed).toHaveLength(2);
  expect(committed[1]).not.toBe(committed[0]);
  observer.detach();
});
