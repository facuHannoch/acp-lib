import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AcpClient } from "../src/client.ts";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function client(hang?: string, extraEnv: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "acp-control-")); cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const value = new AcpClient({ adapter: { command: [process.execPath, resolve(import.meta.dir, "fixtures/lifecycle-agent.ts")] },
    env: { LIFECYCLE_STATE: join(directory, "sessions.json"), ...(hang ? { LIFECYCLE_HANG_CONTROL: hang } : {}), ...extraEnv },
    operationLifecycle: { control: { initializeMs: 100, requestMs: 40, loadIdleMs: 80 } } });
  cleanups.push(() => value.stop()); return value;
}
test("initialize and new/list/config/delete control requests time out and disconnect", async () => {
  for (const request of ["initialize", "session/new", "session/list", "session/set_config_option", "session/delete"]) {
    const value = await client(request); let pending: Promise<unknown>;
    if (request === "initialize") pending = value.connect();
    else {
      await value.connect();
      if (request !== "session/new") await value.startSession();
      pending = request === "session/new" ? value.startSession() : request === "session/list" ? value.listSessions()
        : request === "session/delete" ? value.deleteSession(value.currentSessionId!) : value.setConfig("x", "y");
    }
    const error = await pending.catch((error) => error);
    expect(error.code).toBe("provider_request_timeout");
    expect(error.request).toBe(request);
    // list and delete change nothing about the session, so only the request fails.
    const keepsProcess = request === "session/list" || request === "session/delete";
    expect(value.isConnected).toBe(keepsProcess);
  }
});
test("load idle timeout resets for each matching replay update", async () => {
  const value = await client(undefined, { LIFECYCLE_REPLAY_INTERVAL: "45" });
  await value.connect(); await value.startSession(); await value.prompt("one"); await value.prompt("two");
  const start = Date.now(); const replay: unknown[] = [];
  expect((await value.loadSession(value.currentSessionId!, { onUpdate: (update) => replay.push(update) })).resumed).toBe(true);
  expect(Date.now() - start).toBeGreaterThan(100); expect(replay.length).toBe(2);
});
test("a silent load times out while interactive authenticate has no deadline", async () => {
  const value = await client("session/load"); await value.connect(); await value.startSession();
  expect((await value.loadSession(value.currentSessionId!).catch((error) => error)).code).toBe("provider_request_timeout");
  const login = await client("authenticate"); await login.connect(); let settled = false;
  const auth = login.authenticate("interactive").then(() => { settled = true; }, () => { settled = true; });
  await Bun.sleep(100); expect(settled).toBe(false); await login.stop(); await auth;
});
test("initialize deadline excludes launcher preparation", async () => {
  const value = new AcpClient({ adapter: { command: [process.execPath, resolve(import.meta.dir, "fixtures/lifecycle-agent.ts")] },
    operationLifecycle: { control: { initializeMs: 100 } }, launcher: { async prepare({ targetCommand }) {
      await Bun.sleep(180); return { command: [...targetCommand], spawnEnv: process.env as Record<string, string> };
    } } }); cleanups.push(() => value.stop());
  await value.connect(); expect(value.isConnected).toBe(true);
});
