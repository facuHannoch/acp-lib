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

test("silence and partial silence reject with the phase and captured messages", async () => {
  for (const mode of ["silent", "partial"]) {
    const value = await conversation({ operationLifecycle: { turns: { firstOutputMs: 30, nextOutputMs: 30 } } });
    const start = Date.now();
    const error = await value.prompt(`[lifecycle:${mode}]`).catch((error) => error);
    expect(error.code).toBe("stalled");
    expect(error.phase).toBe(mode === "silent" ? "no_response" : "incomplete_response");
    expect(error.messages.map((message: any) => message.text).join("")).toBe(mode === "partial" ? "partial reply" : "");
    expect(error.metering.outcome).toBe("cancelled"); expect(error.cancel).toBe("forced");
    expect(Date.now() - start).toBeLessThan(1000);
  }
});
test("a tool and pending permission explain silence; optional toolMs bounds a tool", async () => {
  const limits = { firstOutputMs: 20, nextOutputMs: 20 };
  const value = await conversation({ operationLifecycle: { turns: limits } });
  expect((await value.prompt("[lifecycle:tool]")).status).toBe("completed");
  let signal: AbortSignal | undefined;
  const pending = value.prompt("[lifecycle:permission]", { onPermissionRequest: (_request, abort) => { signal = abort; return new Promise(() => {}); } });
  await until(() => !!signal); await Bun.sleep(70);
  expect(value.state.operation?.stage).toBe("awaiting_permission");
  value.interrupt(); expect((await pending).status).toBe("cancelled");
  const bounded = await conversation({ operationLifecycle: { turns: { ...limits, toolMs: 20 } } });
  expect((await bounded.prompt("[lifecycle:tool]").catch((error) => error)).code).toBe("stalled");
});
test("an owned partial stall persists failed reply, one error, cancelled metering, and publishes the error", async () => {
  const { Agent } = await import("../src/agent.ts");
  const directory = await mkdtemp(join(tmpdir(), "acp-owned-stall-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const agent = await Agent.open({ persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
    adapters: { mock: { command: [process.execPath, resolve(import.meta.dir, "fixtures/lifecycle-agent.ts")], cancelGraceMs: 50 } },
    defaultAdapterId: "mock", capture: { message: "content", error: "raw" },
    operationLifecycle: { turns: { firstOutputMs: 30, nextOutputMs: 30 } },
    conversationDefaults: { metering: { pricing: false }, env: { LIFECYCLE_STATE: join(directory, "sessions.json") } } });
  cleanups.push(() => agent.close());
  const published: any[] = [];
  agent.events.subscribe((notification) => published.push(notification.event.record));
  const value = await agent.conversations.create();
  const error = await value.prompt("[lifecycle:partial]").catch((error) => error);
  expect(error.code).toBe("stalled");
  const records = (await agent.persistence.records.list(value.id, { limit: 1000 })).records;
  const errors = records.filter((record) => record.kind === "error");
  expect(errors.length).toBe(1);
  expect(published.some((record) => record.recordId === errors[0]!.recordId)).toBe(true);
  expect(errors[0]).toMatchObject({ code: "stalled", source: "operation", recoverability: "retryable", operationId: error.operationId, details: { phase: "incomplete_response" } });
  expect(records.some((record: any) => record.kind === "message" && record.role === "assistant" && record.status === "failed" && record.content === "partial reply")).toBe(true);
});
