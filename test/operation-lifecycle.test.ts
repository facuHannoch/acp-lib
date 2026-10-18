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
  expect((await value.prompt("after forced interrupt")).status).toBe("completed");
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
    expect((await value.prompt("after stall")).status).toBe("completed");
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
test("a stalled adoption recap succeeds with its failure detail and baseline checkpoint floor", async () => {
  const { Agent } = await import("../src/agent.ts");
  const { writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "acp-recap-stall-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "history.json");
  await writeFile(file, JSON.stringify({ adopted: Array.from({ length: 60 }, (_, index) => [
    { sessionUpdate: "user_message_chunk", messageId: `u${index}`, content: { type: "text", text: `remember kiwi ${index}` } },
    { sessionUpdate: "agent_message_chunk", messageId: `a${index}`, content: { type: "text", text: `remembered ${index}` } },
  ]).flat() }));
  const agent = await Agent.open({ persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
    adapters: { mock: { command: [process.execPath, resolve(import.meta.dir, "fixtures/replay-agent.ts")], cancelGraceMs: 50 } },
    defaultAdapterId: "mock", capture: { message: "content", error: "raw" },
    checkpointing: { schedule: { milestones: [100], everyAfterMilestones: 100 } },
    operationLifecycle: { recap: { firstOutputMs: 30, nextOutputMs: 30 } },
    conversationDefaults: { metering: { pricing: false }, env: { REPLAY_AGENT_FILE: file, REPLAY_AGENT_STALL_RECAP: "1" } } });
  cleanups.push(() => agent.close());
  const value = await agent.conversations.create({ adopt: { providerSessionId: "adopted", recap: true, importHistory: true } });
  const records = (await agent.persistence.records.list(value.id, { limit: 1000 })).records;
  expect(records.find((record: any) => record.kind === "error" && record.code === "adoption_recap_failed")).toMatchObject({ details: { providerCode: "stalled", phase: "no_response" } });
  expect(await agent.persistence.recoveryCheckpoints!.latest(value.id)).toMatchObject({ source: "adoption_baseline" });
});
test("a killed provider is loaded on the next prompt with context and the same conversation object", async () => {
  const value = await conversation(); const events: any[] = [];
  value.subscribe(({ event }) => events.push(event));
  const first = await value.prompt("remember pineapple"); const id = value.internalSessionId;
  const pid = Number(/pid=(\d+)/.exec(first.text)![1]);
  const pending = value.prompt("[lifecycle:ignore]"); const failed = pending.catch((error) => error);
  await until(() => value.state.operation !== null); await Bun.sleep(20);
  process.kill(pid, "SIGKILL");
  expect((await failed).name).toBe("AgentSessionOperationError");
  const next = await value.prompt("what did I ask you to remember?");
  expect(next.text).toContain("remember pineapple"); expect(value.internalSessionId).toBe(id);
  expect(events.some((event) => event.kind === "provider_reconnected" && event.via === "loaded")).toBe(true);
  expect(value.state.providerConnection).toBe("connected");
});
test("a frozen harness stalls, is forcibly killed, then loads with its earlier context", async () => {
  const value = await conversation({ operationLifecycle: { turns: { firstOutputMs: 40, nextOutputMs: 40 } } });
  const first = await value.prompt("remember plum"); const pid = Number(/pid=(\d+)/.exec(first.text)![1]);
  process.kill(pid, "SIGSTOP");
  const error = await value.prompt("frozen turn").catch((error) => error);
  expect(error.code).toBe("stalled"); expect(error.phase).toBe("no_response"); expect(error.cancel).toBe("forced");
  expect(value.state.providerConnection).toBe("disconnected");
  const next = await value.prompt("remember what?"); expect(next.text).toContain("remember plum");
}, 5000);
test("missing provider history recovers from checkpoint in the same owned conversation", async () => {
  const { Agent } = await import("../src/agent.ts");
  const { createConversationRecoveryCheckpointId } = await import("../src/checkpointing/ids.ts");
  const { writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "acp-inplace-recovery-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, "sessions.json");
  const agent = await Agent.open({ persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
    adapters: { mock: { command: [process.execPath, resolve(import.meta.dir, "fixtures/lifecycle-agent.ts")], cancelGraceMs: 30 } }, defaultAdapterId: "mock",
    checkpointing: { schedule: { milestones: [100], everyAfterMilestones: 100 }, recovery: { onLoadFailure: "recover" } },
    conversationDefaults: { metering: { pricing: false }, env: { LIFECYCLE_STATE: state } } }); cleanups.push(() => agent.close());
  const value = await agent.conversations.create(); const events: any[] = []; value.subscribe(({ event }) => events.push(event));
  await value.prompt("remember nectarines"); const previous = value.internalSessionId;
  const sequence = await agent.persistence.recoveryCheckpoints!.latestMessageSequence(value.id);
  await agent.persistence.recoveryCheckpoints!.publish({ checkpointId: createConversationRecoveryCheckpointId(), agentConversationId: value.id,
    source: "adoption_recap", summary: "The user asked to remember nectarines.", coveredSequence: sequence });
  await value.connection.forceStop(); await writeFile(state, "{}");
  const result = await value.prompt("what fruit?");
  expect(result.text).toContain("nectarines"); expect(value.internalSessionId).not.toBe(previous);
  expect(events.some((event) => event.kind === "provider_reconnected" && event.via === "recovered")).toBe(true);
  expect((await agent.conversations.open(value.id)).conversation).toBe(value);
  expect((await agent.persistence.providerSessions.active(value.id))!.internalSessionId).toBe(value.internalSessionId);
});
test("a failed detached reload leaves the conversation retryable on the next prompt", async () => {
  const { readFile, writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "acp-load-retry-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, "sessions.json");
  const value = await conversation({ env: { LIFECYCLE_STATE: state } });
  await value.prompt("remember guava"); const id = value.internalSessionId;
  const saved = await readFile(state, "utf8"); await value.connection.forceStop(); await writeFile(state, "{}");
  expect((await value.prompt("first reconnect").catch((error) => error)).code).toBe("provider_session_load_failed");
  expect(value.state.providerConnection).toBe("disconnected"); expect(value.internalSessionId).toBe(id);
  await writeFile(state, saved);
  expect((await value.prompt("second reconnect")).text).toContain("guava");
});
test("a stall combines recovery steers, holds queued messages, then releases them in order", async () => {
  const value = await conversation({ operationLifecycle: { turns: { firstOutputMs: 40, nextOutputMs: 40 } } });
  const events: any[] = []; value.subscribe(({ event }) => events.push(event));
  const first = value.prompt("[lifecycle:partial]"); const failure = first.catch((error) => error);
  await until(() => value.state.operation !== null);
  const queued = value.prompt({ text: "queued happy path", delivery: "queue" });
  const steer1 = value.prompt({ text: "what happened?", delivery: "steer" });
  const steer2 = value.prompt({ text: "please continue", delivery: "steer" });
  const error = await failure; expect(error.code).toBe("stalled"); expect(error.followedBy).toEqual([steer1.id, steer2.id]);
  const [a, b, q] = await Promise.all([steer1, steer2, queued]);
  expect(a.operationId).toBe(b.operationId); expect(q.operationId).not.toBe(a.operationId);
  expect(events.find((event) => event.kind === "message_delivered" && event.via === "stall")?.ids).toEqual([steer1.id, steer2.id]);
  expect(events.some((event) => event.kind === "message_held" && event.id === queued.id && event.failedTurnId === first.id)).toBe(true);
  expect(events.some((event) => event.kind === "message_released" && event.id === queued.id)).toBe(true);
  expect(value.state.pendingHold).toBeNull();
});
test("idle hold respects explicit queue, permits withdrawal, and releases only after a successful steer", async () => {
  const value = await conversation({ operationLifecycle: { turns: { firstOutputMs: 30, nextOutputMs: 30 } } });
  const first = value.prompt("[lifecycle:silent]"); const failure = first.catch((error) => error);
  const held = value.prompt({ text: "old queued", delivery: "queue" }); await failure;
  await until(() => !value.isBusy);
  expect(value.state.pendingHold?.failedTurnId).toBe(first.id);
  expect(value.pendingMessages[0]?.heldBy).toBe(first.id);
  const another = value.prompt({ text: "new queued", delivery: "queue" });
  const withdrawn = value.prompt({ text: "withdraw this", delivery: "queue" }); expect(withdrawn.withdraw()).toBe(true);
  expect((await withdrawn).status).toBe("cancelled");
  await Bun.sleep(30); expect(value.pendingMessages.map((message) => message.id)).toEqual([held.id, another.id]);
  await value.prompt({ text: "repair", delivery: "steer" });
  const results = await Promise.all([held, another]); expect(results.every((result) => result.status === "completed")).toBe(true);
  expect(value.state.pendingHold).toBeNull();
});
