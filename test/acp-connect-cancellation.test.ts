import { expect, test } from "bun:test";
import { AcpClient, ConnectionCancelledError, HarnessController, ProcessCrashError } from "../src/index.ts";
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
