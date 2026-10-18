import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentConversation, type AgentConversationConfig } from "../src/agent-session.ts";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function conversation(extra: Partial<AgentConversationConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "acp-lifecycle-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const value = await AgentConversation.create({ adapterId: "mock", adapter: { command: [process.execPath, resolve(import.meta.dir, "fixtures/lifecycle-agent.ts")], cancelGraceMs: 80 },
    env: { LIFECYCLE_STATE: join(directory, "sessions.json") }, metering: { pricing: false }, ...extra });
  cleanups.push(() => value.stop()); return value;
}
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) throw new Error("condition timed out"); await Bun.sleep(5); }
}
test("interrupt answers an open permission, aborts its handler, and permits the next prompt", async () => {
  const value = await conversation(); let signal: AbortSignal | undefined;
  const pending = value.prompt("[lifecycle:permission]", { onPermissionRequest: (_request, abort) => { signal = abort; return new Promise(() => {}); } });
  await until(() => !!signal);
  expect(value.state.operation?.stage).toBe("awaiting_permission");
  value.interrupt(); const result = await pending;
  expect(signal!.aborted).toBe(true); expect(result.status).toBe("cancelled"); expect(result.cancel).toBe("acknowledged");
  expect((await value.prompt("next")).status).toBe("completed");
});
test("ignored cancel is bounded, sent twice, and exposes cancelling", async () => {
  const outgoing: string[] = [];
  const value = await conversation({ wire: (entry) => { if (entry.dir === "out") outgoing.push(entry.line); } });
  const pending = value.prompt("[lifecycle:ignore]"); await until(() => value.state.operation !== null);
  await Bun.sleep(20); const start = Date.now(); value.interrupt();
  expect(value.state.operation?.stage).toBe("cancelling");
  const result = await pending;
  expect(Date.now() - start).toBeLessThan(1000); expect(result.cancel).toBe("forced"); expect(result.endedBy).toBe("interrupt");
  expect(outgoing.filter((line) => line.includes('"method":"session/cancel"')).length).toBe(2);
});
