import { expect, test } from "bun:test";
import { AcpClient, Agent, AgentSession, AgentSessionHandoffError, ConnectionCancelledError, HarnessController, ProcessCrashError } from "../src/index.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger } from "../src/logger.ts";
import type { AcpLauncher, PreparedLaunch } from "../src/launcher.ts";

const command = [process.execPath, new URL("./fixtures/lifecycle-agent.ts", import.meta.url).pathname];
const ptyCommand = [process.execPath, new URL("./fixtures/idle-pty-agent.ts", import.meta.url).pathname];
const adapter = { command, ptyCommand };

function waitingForHang(method: string, resist = false) {
  const seen = Promise.withResolvers<number>();
  return {
    seen: seen.promise,
    env: { LIFECYCLE_HANG_CONTROL: method, LIFECYCLE_REPORT_HANG: "1", ...(resist ? { LIFECYCLE_IGNORE_SIGTERM: "1" } : {}) },
    logger: { ...noopLogger, debug(event: string, metadata?: Record<string, unknown>) {
      if (event !== "agent_stderr") return;
      const line = String(metadata?.line);
      if (line.startsWith(`hang:${method}:`)) seen.resolve(Number(line.split(":").at(-1)));
    } },
  };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 7_000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const operation of ["start", "startFresh", "reconnect", "setMode"] as const) {
  test(`stop cancels ACP ${operation} and reaps its process`, async () => {
    const method = operation === "start" ? "initialize" : operation === "reconnect" ? "session/load" : "session/new";
    const { seen, env, logger } = waitingForHang(method, operation === "startFresh");
    const controller = new HarnessController({ adapter, adapterId: "test", mode: operation === "setMode" ? "degraded" : "normal", env, logger });
    try {
      if (operation === "setMode") await controller.start();
      const pending = operation === "reconnect" ? controller.reconnect("recorded")
        : operation === "setMode" ? controller.setMode("normal") : controller[operation]();
      const rejected = pending.catch(error => error);
      const pid = await bounded(seen, method);
      await bounded(Promise.all([controller.stop(), controller.stop()]), "both stop callers");
      expect(await rejected).toBeInstanceOf(ConnectionCancelledError);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(controller.isConnected).toBe(false);
      expect(controller.currentSessionId).toBeNull();
      if (operation === "setMode") expect(controller.currentMode).toBe("degraded");
    } finally { await controller.stop(); }
  }, 18_000);
}

test("equivalent starts share one attempt and an incompatible fresh start waits for cancellation", async () => {
  const { seen, env, logger } = waitingForHang("initialize");
  let launches = 0;
  const launcher: AcpLauncher = {
    async prepare({ targetCommand }) {
      return { command: [...targetCommand], spawnEnv: launches++ === 0 ? env : {} };
    },
  };
  const controller = new HarnessController({ adapter, adapterId: "test", logger, launcher });
  try {
    const first = controller.start();
    expect(controller.start()).toBe(first);
    const cancelled = first.catch(error => error);
    const pid = await bounded(seen, "first initialize");
    const replacement = await bounded(controller.startFresh(), "replacement start");
    expect(await cancelled).toBeInstanceOf(ConnectionCancelledError);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(launches).toBe(2);
    expect(controller.currentSessionId).toBe(replacement.sessionId);
    expect((await controller.prompt("ready")).status).toBe("completed");
  } finally { await controller.stop(); }
}, 18_000);

test("a launcher that returns after cancellation is disposed without spawning over the replacement", async () => {
  const preparing = Promise.withResolvers<void>(), late = Promise.withResolvers<PreparedLaunch>();
  const disposed = Promise.withResolvers<void>();
  let opens = 0, disposeCalls = 0;
  const client = new AcpClient({ adapter, launcher: {
    async prepare() {
      if (opens++ === 0) { preparing.resolve(); return late.promise; }
      return { command, spawnEnv: {} };
    },
  } });
  try {
    const pending = client.connect();
    expect(client.connect()).toBe(pending);
    const cancelled = pending.catch(error => error);
    await bounded(preparing.promise, "launcher entry");
    await bounded(client.stop(), "stop while launcher is pending");
    expect(await cancelled).toBeInstanceOf(ConnectionCancelledError);
    await bounded(client.connect(), "replacement handshake");
    const result = await client.startSession();
    late.resolve({ command: ["must-not-spawn"], spawnEnv: {}, dispose() {
      disposeCalls++;
      disposed.resolve();
    } });
    await bounded(disposed.promise, "late launch disposal");
    expect(disposeCalls).toBe(1);
    expect(client.currentSessionId).toBe(result.sessionId);
    expect(client.isConnected).toBe(true);
  } finally { await client.stop(); }
}, 18_000);

test("stop from acquired progress prevents installing the late startup result", async () => {
  const controller = new HarnessController({ adapter, adapterId: "test" });
  let stopping: Promise<void> | undefined;
  try {
    const result = controller.start(event => {
      if (event.stage === "internal_session_acquired") stopping = controller.stop();
    });
    await expect(result).rejects.toBeInstanceOf(ConnectionCancelledError);
    await stopping;
    expect(controller.isConnected).toBe(false);
    expect(controller.currentSessionId).toBeNull();
  } finally { await controller.stop(); }
}, 12_000);

test("unexpected child death rejects the session handshake as a process crash", async () => {
  const { seen, env, logger } = waitingForHang("session/new");
  const controller = new HarnessController({ adapter, adapterId: "test", env, logger });
  try {
    const start = controller.start();
    const failure = start.catch(error => error);
    process.kill(await bounded(seen, "session/new"), "SIGKILL");
    expect(await bounded(failure, "unexpected exit")).toBeInstanceOf(ProcessCrashError);
    expect(controller.isConnected).toBe(false);
  } finally { await controller.stop(); }
}, 12_000);

test("a stopped raw load does not fall back to session/new", async () => {
  const { seen, env, logger } = waitingForHang("session/load");
  const outgoing: string[] = [];
  const client = new AcpClient({ adapter, env, logger, wire: entry => {
    if (entry.dir === "out") outgoing.push(JSON.parse(entry.line).method);
  } });
  try {
    await client.connect();
    const pending = client.startSession({ sessionId: "recorded" }).catch(error => error);
    const pid = await bounded(seen, "raw session/load");
    await bounded(client.stop(), "raw client stop");
    expect(await pending).toBeInstanceOf(ConnectionCancelledError);
    expect(outgoing).not.toContain("session/new");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await client.stop(); }
}, 12_000);

test("a genuine session creation failure retains the initialized client for authentication", async () => {
  const controller = new HarnessController({ adapter, adapterId: "test", env: { LIFECYCLE_FAIL_CONTROL: "session/new" } });
  try {
    expect(await controller.start()).toEqual({ sessionId: "", resumed: false });
    expect(controller.isConnected).toBe(true);
    expect(controller.currentSessionId).toBeNull();
  } finally { await controller.stop(); }
});

test("a delayed crash callback cannot clear the replacement transport and session", async () => {
  const disposing = Promise.withResolvers<void>(), finishDisposal = Promise.withResolvers<void>();
  let launches = 0;
  const client = new AcpClient({ adapter, launcher: {
    async prepare() {
      const first = launches++ === 0;
      return { command, spawnEnv: {}, ...(first ? { async dispose() {
        disposing.resolve();
        await finishDisposal.promise;
      } } : {}) };
    },
  } });
  try {
    await client.connect();
    await client.startSession();
    const response = await client.prompt("identify the fixture");
    const pid = Number(/pid=(\d+)/.exec(response.text)?.[1]);
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, "SIGKILL");
    await bounded(disposing.promise, "old transport crash disposal");
    await client.connect();
    const replacement = await client.startSession();
    finishDisposal.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(client.currentSessionId).toBe(replacement.sessionId);
    expect((await client.prompt("replacement stays ready")).status).toBe("completed");
  } finally {
    finishDisposal.resolve();
    await client.stop();
  }
}, 12_000);

test("a direct factory caller can abort a session while its handshake is in flight", async () => {
  const { seen, env, logger } = waitingForHang("initialize");
  const abort = new AbortController();
  const opening = AgentSession.create({ adapter, adapterId: "test", env, logger, signal: abort.signal }).catch(error => error);
  const pid = await bounded(seen, "direct factory handshake");
  abort.abort();
  expect(await bounded(opening, "direct factory cancellation")).toBeInstanceOf(ConnectionCancelledError);
  expect(() => process.kill(pid, 0)).toThrow();
}, 12_000);

for (const crossAdapter of [false, true]) {
  test(`conversation stop cancels the ${crossAdapter ? "cross" : "same"}-adapter handoff candidate`, async () => {
    const { seen, env, logger } = waitingForHang("session/new");
    let launches = 0;
    const source = await AgentSession.create({
      adapter, adapterId: "source", logger,
      launcher: { async prepare({ targetCommand }) { return { command: [...targetCommand], spawnEnv: launches++ === 0 ? {} : env }; } },
    });
    const events: string[] = [];
    source.subscribe(({ event }) => events.push(event.kind));
    try {
      const handoff = source.handoff(crossAdapter ? { target: { adapterId: "other", adapter } }
        : { continuation: { kind: "none" } }).catch(error => error);
      const pid = await bounded(seen, "handoff target session/new");
      await bounded(source.stop(), "stop during target connect");
      const failure = await bounded(handoff, "cancelled handoff");
      if (crossAdapter) {
        expect(failure).toBeInstanceOf(AgentSessionHandoffError);
        expect(failure.cause).toBeInstanceOf(ConnectionCancelledError);
        expect(failure.meteringRecords).toHaveLength(1);
      } else {
        expect(failure).toBeInstanceOf(ConnectionCancelledError);
      }
      expect(() => process.kill(pid, 0)).toThrow();
      expect(events).toContain("handoff_failed");
      expect(events).not.toContain("handoff_completed");
      expect(source.adapterId).toBe("source");
    } finally { await source.stop(); }
  }, 15_000);
}

test("stop during ACP reconnect settles the active prompt and queued operations with the typed error", async () => {
  const { seen, env, logger } = waitingForHang("session/load");
  let launches = 0;
  const outbound: string[] = [];
  const session = await AgentSession.create({ adapter, adapterId: "test", logger, wire: entry => {
    if (entry.dir === "out") outbound.push(JSON.parse(entry.line).method);
  }, launcher: { async prepare({ targetCommand }) { return { command: [...targetCommand], spawnEnv: launches++ === 0 ? {} : env }; } } });
  const facts: string[] = [];
  session.subscribe(({ event }) => facts.push(event.kind));
  try {
    await session.connection.forceStop();
    const active = session.prompt("blocked by readiness").catch(error => error);
    const pid = await bounded(seen, "reconnecting session/load");
    const queued = session.prompt({ text: "queued", delivery: "queue" }).catch(error => error);
    const setting = session.setConfig("unused", "value").catch(error => error);
    await bounded(session.stop(), "conversation queue drain");
    for (const failure of await Promise.all([active, queued, setting])) expect(failure).toBeInstanceOf(ConnectionCancelledError);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(facts).not.toContain("provider_reconnected");
    expect(outbound.filter(method => method === "session/new")).toHaveLength(1);
    expect(outbound).not.toContain("session/prompt");
    expect(session.state.phase).toBe("stopped");
  } finally { await session.stop(); }
}, 15_000);

for (const stage of ["create", "reopen"] as const) {
  test(`Agent close cancels eager Provider ${stage} before the conversation handle is exposed`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-cancel-owner-"));
    const { seen, env, logger } = waitingForHang(stage === "create" ? "session/new" : "session/load");
    const options = {
      persistence: { kind: "sqlite" as const, path: join(directory, "agent.sqlite") },
      adapters: { test: adapter },
      checkpointing: { enabled: false },
    };
    let agent = await Agent.open(options);
    try {
      let id: Awaited<ReturnType<typeof agent.conversations.create>>["id"] | undefined;
      if (stage === "reopen") {
        const saved = await agent.conversations.create();
        await saved.prompt("establish recorded thread");
        id = saved.id;
        await agent.close();
      } else await agent.close();
      agent = await Agent.open({ ...options, conversationDefaults: { env, logger } });
      const opening = (id ? agent.conversations.open(id) : agent.conversations.create()).catch(error => error);
      const pid = await bounded(seen, "owner startup request");
      await bounded(agent.close(), "Agent shutdown");
      expect(await bounded(opening, "owner startup cancellation")).toBeInstanceOf(ConnectionCancelledError);
      expect(() => process.kill(pid, 0)).toThrow();
      const recovered = await Agent.open(options);
      try {
        const rows = (await recovered.conversations.list()).conversations;
        expect(rows).toHaveLength(1);
        const records = (await recovered.persistence.records.list(rows[0]!.agentConversationId)).records;
        expect(records.filter(record => record.kind === "error" && record.source === "provider_session")).toHaveLength(0);
      } finally { await recovered.close(); }
    } finally {
      await agent.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 16_000);
}
