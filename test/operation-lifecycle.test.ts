import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, type AgentConfig } from "../src/agent.ts";
import { AgentConversation, AgentSession, type AgentConversationConfig } from "../src/agent-session.ts";
import { createConversationRecoveryCheckpointId } from "../src/checkpointing/ids.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures/lifecycle-agent.ts");
const command = [process.execPath, FIXTURE];

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A detached conversation on the lifecycle fixture, with its harness state in a fresh directory. */
async function conversation(extra: Partial<AgentConversationConfig> = {}) {
  const directory = await tempDir("acp-lifecycle-");
  const value = await AgentConversation.create({
    adapterId: "mock",
    adapter: { command, cancelGraceMs: 80 },
    env: { LIFECYCLE_STATE: join(directory, "sessions.json") },
    metering: { pricing: false },
    ...extra,
  });
  cleanups.push(() => value.stop());
  return value;
}

/** An Agent with sqlite persistence whose conversations run on `fixture`. */
async function ownedAgent(
  directory: string,
  env: Record<string, string>,
  extra: Partial<AgentConfig> = {},
  fixture = FIXTURE,
  cancelGraceMs = 30,
) {
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
    adapters: { mock: { command: [process.execPath, fixture], cancelGraceMs } },
    defaultAdapterId: "mock",
    conversationDefaults: { metering: { pricing: false }, env },
    ...extra,
  });
  cleanups.push(() => agent.close());
  return agent;
}

function recordEvents(value: { subscribe(listener: (notification: { event: any }) => void): unknown }): any[] {
  const events: any[] = [];
  value.subscribe(({ event }) => events.push(event));
  return events;
}

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition timed out");
    await Bun.sleep(5);
  }
}

const harnessPid = (text: string) => Number(/pid=(\d+)/.exec(text)![1]);

/** A permission handler that never answers, and the signal it was given. */
function hangingPermission() {
  const seen: { signal?: AbortSignal } = {};
  const onPermissionRequest = (_request: unknown, abort?: AbortSignal) => {
    seen.signal = abort;
    return new Promise<never>(() => {});
  };
  return { seen, onPermissionRequest };
}

test("interrupt answers an open permission, aborts its handler, and permits the next prompt", async () => {
  const value = await conversation();
  const { seen, onPermissionRequest } = hangingPermission();
  const pending = value.prompt("[lifecycle:permission]", { onPermissionRequest });
  await until(() => !!seen.signal);
  expect(value.state.operation?.stage).toBe("awaiting_permission");
  value.interrupt();
  const result = await pending;
  expect(seen.signal!.aborted).toBe(true);
  expect(result.status).toBe("cancelled");
  expect(result.cancel).toBe("acknowledged");
  expect((await value.prompt("next")).status).toBe("completed");
});

test("ignored cancel is bounded, sent twice, and exposes cancelling", async () => {
  const outgoing: string[] = [];
  const value = await conversation({ wire: (entry) => { if (entry.dir === "out") outgoing.push(entry.line); } });
  const pending = value.prompt("[lifecycle:ignore]");
  await until(() => value.state.operation !== null);
  await Bun.sleep(20);
  const start = Date.now();
  value.interrupt();
  expect(value.state.operation?.stage).toBe("cancelling");
  const result = await pending;
  expect(Date.now() - start).toBeLessThan(1000);
  expect(result.cancel).toBe("forced");
  expect(result.endedBy).toBe("interrupt");
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
    expect(error.metering.outcome).toBe("cancelled");
    expect(error.cancel).toBe("forced");
    expect(Date.now() - start).toBeLessThan(1000);
    expect((await value.prompt("after stall")).status).toBe("completed");
  }
});

test("a tool and pending permission explain silence; optional toolMs bounds a tool", async () => {
  const limits = { firstOutputMs: 20, nextOutputMs: 20 };
  const value = await conversation({ operationLifecycle: { turns: limits } });
  expect((await value.prompt("[lifecycle:tool]")).status).toBe("completed");

  const { seen, onPermissionRequest } = hangingPermission();
  const pending = value.prompt("[lifecycle:permission]", { onPermissionRequest });
  await until(() => !!seen.signal);
  await Bun.sleep(70);
  expect(value.state.operation?.stage).toBe("awaiting_permission");
  value.interrupt();
  expect((await pending).status).toBe("cancelled");

  const bounded = await conversation({ operationLifecycle: { turns: { ...limits, toolMs: 20 } } });
  expect((await bounded.prompt("[lifecycle:tool]").catch((error) => error)).code).toBe("stalled");
});

test("an owned partial stall persists failed reply, one error, cancelled metering, and publishes the error", async () => {
  const directory = await tempDir("acp-owned-stall-");
  const agent = await ownedAgent(directory, { LIFECYCLE_STATE: join(directory, "sessions.json") }, {
    capture: { message: "content", error: "raw" },
    operationLifecycle: { turns: { firstOutputMs: 30, nextOutputMs: 30 } },
  }, FIXTURE, 50);
  const published: any[] = [];
  agent.events.subscribe((notification) => published.push(notification.event.record));
  const value = await agent.conversations.create();

  const error = await value.prompt("[lifecycle:partial]").catch((error) => error);
  expect(error.code).toBe("stalled");
  const records = (await agent.persistence.records.list(value.id, { limit: 1000 })).records;
  const errors = records.filter((record) => record.kind === "error");
  expect(errors.length).toBe(1);
  expect(published.some((record) => record.recordId === errors[0]!.recordId)).toBe(true);
  expect(errors[0]).toMatchObject({
    code: "stalled",
    source: "operation",
    recoverability: "retryable",
    operationId: error.operationId,
    details: { phase: "incomplete_response" },
  });
  const failedReply = records.some((record: any) =>
    record.kind === "message" && record.role === "assistant" && record.status === "failed" && record.content === "partial reply");
  expect(failedReply).toBe(true);
});

test("a stalled adoption recap succeeds with its failure detail and baseline checkpoint floor", async () => {
  const directory = await tempDir("acp-recap-stall-");
  const file = join(directory, "history.json");
  const adopted = Array.from({ length: 60 }, (_, index) => [
    { sessionUpdate: "user_message_chunk", messageId: `u${index}`, content: { type: "text", text: `remember kiwi ${index}` } },
    { sessionUpdate: "agent_message_chunk", messageId: `a${index}`, content: { type: "text", text: `remembered ${index}` } },
  ]).flat();
  await writeFile(file, JSON.stringify({ adopted }));
  const agent = await ownedAgent(directory, { REPLAY_AGENT_FILE: file, REPLAY_AGENT_STALL_RECAP: "1" }, {
    capture: { message: "content", error: "raw" },
    checkpointing: { schedule: { milestones: [100], everyAfterMilestones: 100 } },
    operationLifecycle: { recap: { firstOutputMs: 30, nextOutputMs: 30 } },
  }, resolve(import.meta.dir, "fixtures/replay-agent.ts"), 50);

  const value = await agent.conversations.create({ adopt: { providerSessionId: "adopted", recap: true, importHistory: true } });
  const records = (await agent.persistence.records.list(value.id, { limit: 1000 })).records;
  const recapFailure = records.find((record: any) => record.kind === "error" && record.code === "adoption_recap_failed");
  expect(recapFailure).toMatchObject({ details: { providerCode: "stalled", phase: "no_response" } });
  expect(await agent.persistence.recoveryCheckpoints!.latest(value.id)).toMatchObject({ source: "adoption_baseline" });
});

test("a killed provider is loaded on the next prompt with context and the same conversation object", async () => {
  const value = await conversation();
  const events = recordEvents(value);
  const first = await value.prompt("remember pineapple");
  const id = value.internalSessionId;

  const failed = value.prompt("[lifecycle:ignore]").catch((error) => error);
  await until(() => value.state.operation !== null);
  await Bun.sleep(20);
  process.kill(harnessPid(first.text), "SIGKILL");
  expect((await failed).name).toBe("AgentSessionOperationError");

  const next = await value.prompt("what did I ask you to remember?");
  expect(next.text).toContain("remember pineapple");
  expect(value.internalSessionId).toBe(id);
  expect(events.some((event) => event.kind === "provider_reconnected" && event.via === "loaded")).toBe(true);
  expect(value.state.providerConnection).toBe("connected");
});

test("a frozen harness stalls, is forcibly killed, then loads with its earlier context", async () => {
  const value = await conversation({ operationLifecycle: { turns: { firstOutputMs: 40, nextOutputMs: 40 } } });
  const first = await value.prompt("remember plum");
  process.kill(harnessPid(first.text), "SIGSTOP");

  const error = await value.prompt("frozen turn").catch((error) => error);
  expect(error.code).toBe("stalled");
  expect(error.phase).toBe("no_response");
  expect(error.cancel).toBe("forced");
  expect(value.state.providerConnection).toBe("disconnected");

  const next = await value.prompt("remember what?");
  expect(next.text).toContain("remember plum");
}, 5000);

test("missing provider history recovers from checkpoint in the same owned conversation", async () => {
  const directory = await tempDir("acp-inplace-recovery-");
  const state = join(directory, "sessions.json");
  const agent = await ownedAgent(directory, { LIFECYCLE_STATE: state }, {
    checkpointing: { schedule: { milestones: [100], everyAfterMilestones: 100 }, recovery: { onLoadFailure: "recover" } },
  });
  const value = await agent.conversations.create();
  const events = recordEvents(value);
  await value.prompt("remember nectarines");
  const previous = value.internalSessionId;
  const sequence = await agent.persistence.recoveryCheckpoints!.latestMessageSequence(value.id);
  await agent.persistence.recoveryCheckpoints!.publish({
    checkpointId: createConversationRecoveryCheckpointId(),
    agentConversationId: value.id,
    source: "adoption_recap",
    summary: "The user asked to remember nectarines.",
    coveredSequence: sequence,
  });

  await value.connection.forceStop();
  await writeFile(state, "{}");
  const result = await value.prompt("what fruit?");
  expect(result.text).toContain("nectarines");
  expect(value.internalSessionId).not.toBe(previous);
  expect(events.some((event) => event.kind === "provider_reconnected" && event.via === "recovered")).toBe(true);
  expect((await agent.conversations.open(value.id)).conversation).toBe(value);
  expect((await agent.persistence.providerSessions.active(value.id))!.internalSessionId).toBe(value.internalSessionId);
});

test("a transient reload failure leaves the conversation retryable on the next prompt", async () => {
  const directory = await tempDir("acp-load-retry-");
  const flag = join(directory, "fail-load");
  const value = await conversation({ env: { LIFECYCLE_STATE: join(directory, "sessions.json"), LIFECYCLE_FAIL_LOAD_FILE: flag } });
  await value.prompt("remember guava");
  const id = value.internalSessionId;

  await writeFile(flag, "1");
  await value.connection.forceStop();
  expect((await value.prompt("first reconnect").catch((error) => error)).code).toBe("provider_session_load_failed");
  expect(value.state.providerConnection).toBe("disconnected");
  expect(value.internalSessionId).toBe(id);
  expect(value.promptability.promptable).toBe(true);

  await unlink(flag);
  expect((await value.prompt("second reconnect")).text).toContain("guava");
});

test("a detached conversation whose provider lost the session follows its load-failure rule", async () => {
  const directory = await tempDir("acp-load-missing-");
  const state = join(directory, "sessions.json");

  // Started new: the rule is "new", so a fresh session replaces it and the event says the context is gone.
  const fresh = await conversation({ env: { LIFECYCLE_STATE: state } });
  const events = recordEvents(fresh);
  await fresh.prompt("remember guava");
  const id = fresh.internalSessionId!;
  await fresh.connection.forceStop();
  await writeFile(state, "{}");
  expect((await fresh.prompt("after crash")).text).not.toContain("guava");
  expect(fresh.internalSessionId).not.toBe(id);
  expect(events.some((event) => event.kind === "provider_reconnected" && event.via === "fresh")).toBe(true);
  await fresh.stop();

  // Loaded with onFailure "error": the conversation stops accepting prompts instead of failing each one.
  const strict = await conversation({
    env: { LIFECYCLE_STATE: state },
    providerSession: { kind: "load", internalSessionId: fresh.internalSessionId!, onFailure: "error" },
  });
  await strict.connection.forceStop();
  await writeFile(state, "{}");
  expect((await strict.prompt("after crash").catch((error) => error)).code).toBe("provider_session_missing");
  expect(strict.promptability.blockers).toContain("continuation_unavailable");
  const refused = await Promise.resolve().then(() => strict.prompt("again")).catch((error) => error);
  expect(refused.name).toBe("AgentSessionPromptBlockedError");
});

test("a SessionManager conversation whose provider lost the session applies its continuation strategies", async () => {
  const root = await tempDir("acp-continuation-reconnect-");
  const state = join(root, "sessions.json");
  const base = {
    adapterId: "mock",
    adapter: { command, cancelGraceMs: 80 },
    env: { LIFECYCLE_STATE: state },
    metering: { pricing: false as const },
    persistence: { root },
    agentSessionId: "reconnect-continuation",
  };
  const created = await AgentSession.create({ ...base, creationId: "reconnect-continuation-1" });
  await created.prompt("remember quince");
  await created.stop();

  // Default strategies (load only): nothing is left, so the conversation reports it cannot continue.
  const loadOnly = (await AgentSession.open(base)).session;
  cleanups.push(() => loadOnly.stop());
  const saved = await Bun.file(state).text();
  await loadOnly.connection.forceStop();
  await writeFile(state, "{}");
  expect((await loadOnly.prompt("after crash").catch((error) => error)).name).toBe("ContinuationUnavailableError");
  expect(loadOnly.promptability.blockers).toContain("continuation_unavailable");
  await loadOnly.stop();
  await writeFile(state, saved);

  // With a transcript builder configured, a replacement session is seeded and the prompt runs.
  let built = 0;
  const rebuilt = (await AgentSession.open({
    ...base,
    continuation: {
      strategies: [
        { kind: "load_internal_session" },
        {
          kind: "new_from_transcript",
          strategyId: "test-v1",
          buildContinuation: async () => {
            built++;
            return { continuation: "The user asked to remember quince." };
          },
        },
      ],
    },
  })).session;
  cleanups.push(() => rebuilt.stop());
  const events = recordEvents(rebuilt);
  const previous = rebuilt.internalSessionId;
  await rebuilt.connection.forceStop();
  await writeFile(state, "{}");
  expect((await rebuilt.prompt("what fruit?")).text).toContain("quince");
  expect(built).toBe(1);
  expect(rebuilt.internalSessionId).not.toBe(previous);
  expect(events.some((event) => event.kind === "provider_reconnected" && event.via === "recovered")).toBe(true);
});

test("an Agent-owned conversation without checkpoint recovery reports it cannot continue", async () => {
  const directory = await tempDir("acp-owned-missing-");
  const state = join(directory, "sessions.json");
  const agent = await ownedAgent(directory, { LIFECYCLE_STATE: state });
  const value = await agent.conversations.create();
  await value.prompt("remember figs");
  await value.connection.forceStop();
  await writeFile(state, "{}");
  expect((await value.prompt("after crash").catch((error) => error)).code).toBe("provider_session_missing");
  expect(value.promptability.blockers).toContain("continuation_unavailable");
});

test("a stall combines recovery steers, holds queued messages, then releases them in order", async () => {
  const value = await conversation({ operationLifecycle: { turns: { firstOutputMs: 40, nextOutputMs: 40 } } });
  const events = recordEvents(value);
  const first = value.prompt("[lifecycle:partial]");
  const failure = first.catch((error) => error);
  await until(() => value.state.operation !== null);
  const queued = value.prompt({ text: "queued happy path", delivery: "queue" });
  const steer1 = value.prompt({ text: "what happened?", delivery: "steer" });
  const steer2 = value.prompt({ text: "please continue", delivery: "steer" });

  const error = await failure;
  expect(error.code).toBe("stalled");
  expect(error.followedBy).toEqual([steer1.id, steer2.id]);
  const [a, b, q] = await Promise.all([steer1, steer2, queued]);
  expect(a.operationId).toBe(b.operationId);
  expect(q.operationId).not.toBe(a.operationId);

  const isStallDelivery = (event: any) => event.kind === "message_delivered" && event.via === "stall";
  expect(events.find(isStallDelivery)?.ids).toEqual([steer1.id, steer2.id]);
  const reconnected = events.findIndex((event) => event.kind === "provider_reconnected");
  expect(reconnected).toBeGreaterThanOrEqual(0);
  expect(events.findIndex(isStallDelivery)).toBeGreaterThan(reconnected);
  const held = events.some((event) => event.kind === "message_held" && event.id === queued.id && event.failedTurnId === first.id);
  expect(held).toBe(true);
  expect(events.some((event) => event.kind === "message_released" && event.id === queued.id)).toBe(true);
  expect(value.state.pendingHold).toBeNull();
});

test("recovery steers stop at the next queued message; steers after it run after it", async () => {
  const value = await conversation({ operationLifecycle: { turns: { firstOutputMs: 40, nextOutputMs: 40 } } });
  const events = recordEvents(value);
  const failure = value.prompt("[lifecycle:partial]").catch((error) => error);
  await until(() => value.state.operation !== null);
  const steer1 = value.prompt({ text: "what happened?", delivery: "steer" });
  const queued = value.prompt({ text: "deploy the website", delivery: "queue" });
  const steer2 = value.prompt({ text: "and update the record", delivery: "steer" });

  const error = await failure;
  expect(error.code).toBe("stalled");
  expect(error.followedBy).toEqual([steer1.id]);
  const [a, q, b] = await Promise.all([steer1, queued, steer2]);
  expect(new Set([a.operationId, q.operationId, b.operationId]).size).toBe(3);
  expect(events.find((event) => event.kind === "message_delivered" && event.via === "stall")?.ids).toEqual([steer1.id]);
  const started = events.filter((event) => event.kind === "turn_started").map((event) => event.turnId);
  expect(started.slice(-3)).toEqual([steer1.id, queued.id, steer2.id]);
});

test("idle hold respects explicit queue, permits withdrawal, and releases only after a successful steer", async () => {
  const value = await conversation({ operationLifecycle: { turns: { firstOutputMs: 30, nextOutputMs: 30 } } });
  const first = value.prompt("[lifecycle:silent]");
  const failure = first.catch((error) => error);
  const held = value.prompt({ text: "old queued", delivery: "queue" });
  await failure;
  await until(() => !value.isBusy);
  expect(value.state.pendingHold?.failedTurnId).toBe(first.id);
  expect(value.pendingMessages[0]?.heldBy).toBe(first.id);

  const another = value.prompt({ text: "new queued", delivery: "queue" });
  const withdrawn = value.prompt({ text: "withdraw this", delivery: "queue" });
  expect(withdrawn.withdraw()).toBe(true);
  expect((await withdrawn).status).toBe("cancelled");
  await Bun.sleep(30);
  expect(value.pendingMessages.map((message) => message.id)).toEqual([held.id, another.id]);

  await value.prompt({ text: "repair", delivery: "steer" });
  const results = await Promise.all([held, another]);
  expect(results.every((result) => result.status === "completed")).toBe(true);
  expect(value.state.pendingHold).toBeNull();
});

test("a prompt that fails before reaching the provider holds nothing", async () => {
  const directory = await tempDir("acp-no-hold-");
  const flag = join(directory, "fail-load");
  const value = await conversation({ env: { LIFECYCLE_STATE: join(directory, "sessions.json"), LIFECYCLE_FAIL_LOAD_FILE: flag } });
  const events = recordEvents(value);
  await value.prompt("hello");

  await writeFile(flag, "1");
  await value.connection.forceStop();
  const first = value.prompt("reconnect fails").catch((error) => error);
  const queued = value.prompt({ text: "queued behind", delivery: "queue" }).catch((error) => error);
  expect((await first).code).toBe("provider_session_load_failed");
  await queued;
  expect(events.some((event) => event.kind === "message_held")).toBe(false);
  expect(value.state.pendingHold).toBeNull();
});

test("a stalled handoff target uses its own adapter cancellation grace", async () => {
  const value = await conversation({
    adapter: { command, cancelGraceMs: 2000 },
    operationLifecycle: { internalInference: { firstOutputMs: 30, nextOutputMs: 30 } },
  });
  const start = Date.now();
  const error = await value.handoff({
    continuation: { kind: "none" },
    target: { adapterId: "other", adapter: { command, cancelGraceMs: 30 } },
    targetPrompt: "[lifecycle:silent]",
  }).catch((error) => error);
  expect(error.cause?.code).toBe("stalled");
  expect(Date.now() - start).toBeLessThan(1000);
  expect((await value.prompt("source still works")).status).toBe("completed");
});

test("an unanswered session/list during a running turn neither fails nor stops the turn", async () => {
  const directory = await tempDir("acp-lifecycle-");
  const slow = await conversation({
    env: { LIFECYCLE_STATE: join(directory, "sessions.json"), LIFECYCLE_HANG_CONTROL: "session/list", LIFECYCLE_TOOL_MS: "400" },
  });
  const turn = slow.prompt("[lifecycle:tool]");
  await until(() => slow.state.operation?.stage === "tool_running");
  let listed = false;
  const list = slow.listSessions().then(() => { listed = true; }, () => { listed = true; });

  const result = await turn;
  expect(result.status).toBe("completed");
  expect(result.text).toContain("tool finished");
  expect(slow.state.providerConnection).toBe("connected");
  // Control requests have no deadline: the list waits for the harness, or for the process to end.
  expect(listed).toBe(false);
  await slow.stop();
  await list;
});

test("a failed harness listing is reported by the deprecated merged listSessions", async () => {
  const directory = await tempDir("acp-list-failure-");
  const value = await conversation({
    env: { LIFECYCLE_STATE: join(directory, "sessions.json"), LIFECYCLE_FAIL_CONTROL: "session/list" },
  });
  expect(await value.listSessions().then(() => "listed", (error) => String(error))).toContain("internal error");
});

test("a cancelled turn records why it was cancelled and how the cancel ended", async () => {
  const directory = await tempDir("acp-lifecycle-cancellation-");
  const agent = await ownedAgent(directory, {
    LIFECYCLE_STATE: join(directory, "sessions.json"),
    LIFECYCLE_TOOL_MS: "300",
  });
  const value = await agent.conversations.create();

  // Stop during a tool: the harness acknowledges.
  const stopped = value.prompt("[lifecycle:tool]");
  await until(() => value.state.operation?.stage === "tool_running");
  value.interrupt();
  const stoppedResult = await stopped;

  // A steer waits for the running tool to settle. This fixture answers in the same instant, so
  // the cancel is recorded as requested and too late; the steer is the next turn.
  const redirected = value.prompt("[lifecycle:tool]");
  await until(() => value.state.operation?.stage === "tool_running");
  const steer = value.prompt({ text: "focus on something else", delivery: "steer" });
  const redirectedResult = await redirected;
  const steerResult = await steer;

  // A harness that ignores the cancel is killed at the end of the grace period.
  const ignored = value.prompt("[lifecycle:ignore]");
  await until(() => value.state.operation?.kind === "turn" && value.state.operation.stage === "waiting");
  value.interrupt();
  const ignoredResult = await ignored;

  expect([stoppedResult.status, steerResult.status, ignoredResult.status])
    .toEqual(["cancelled", "completed", "cancelled"]);
  const records = (await agent.persistence.records.list(value.id, { kinds: ["cancellation"] })).records;
  expect(records.map((record) => record.kind === "cancellation"
    && [record.operationId, record.state, record.reason, record.outcome ?? null])).toEqual([
    [stoppedResult.operationId, "requested", "interrupt", null],
    [stoppedResult.operationId, "resolved", "interrupt", "acknowledged"],
    [redirectedResult.operationId, "requested", "steer", null],
    [redirectedResult.operationId, "resolved", "steer", redirectedResult.status === "cancelled" ? "acknowledged" : "too_late"],
    [ignoredResult.operationId, "requested", "interrupt", null],
    [ignoredResult.operationId, "resolved", "interrupt", "forced"],
  ]);
  expect(steerResult.operationId).not.toBe(redirectedResult.operationId);
}, 20_000);

test("a JSONL transcript records the cancellation of a turn", async () => {
  const root = await tempDir("acp-lifecycle-cancellation-jsonl-");
  const session = await AgentSession.create({
    adapter: { command, cancelGraceMs: 80 },
    adapterId: "mock",
    agentSessionId: "cancellation-jsonl",
    creationId: "cancellation-jsonl-create",
    env: { LIFECYCLE_STATE: join(root, "sessions.json"), LIFECYCLE_TOOL_MS: "5000" },
    metering: { pricing: false },
    persistence: { root, transcript: { preset: "activity" } },
  });
  cleanups.push(() => session.stop());
  const pending = session.prompt("[lifecycle:tool]");
  await until(() => session.state.operation?.stage === "tool_running");
  session.interrupt();
  const result = await pending;
  await session.stop();

  const lines = (await Bun.file(session.transcriptPath!).text()).trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.t === "cancellation");
  expect(lines.map((record) => [record.operationId, record.event, record.reason, record.outcome ?? null])).toEqual([
    [result.operationId, "requested", "interrupt", null],
    [result.operationId, "resolved", "interrupt", "acknowledged"],
  ]);
}, 20_000);

test("a JSONL transcript records a stalled internal prompt's cancellation and stays writable", async () => {
  const root = await tempDir("acp-lifecycle-internal-cancellation-jsonl-");
  const session = await AgentSession.create({
    adapter: { command, cancelGraceMs: 80 },
    adapterId: "mock",
    agentSessionId: "internal-cancellation-jsonl",
    creationId: "internal-cancellation-jsonl-create",
    env: { LIFECYCLE_STATE: join(root, "sessions.json") },
    metering: { pricing: false },
    operationLifecycle: { internalInference: { firstOutputMs: 30, nextOutputMs: 30 } },
    persistence: { root, transcript: { preset: "activity" } },
  });
  cleanups.push(() => session.stop());
  const error = await session.handoff({
    continuation: { kind: "none" },
    target: { adapterId: "other", adapter: { command, cancelGraceMs: 30 } },
    targetPrompt: "[lifecycle:silent]",
  }).catch((error) => error);
  expect(error.cause?.code).toBe("stalled");
  // The transcript must still accept writes: a sequence collision would have failed it.
  expect((await session.prompt("after the stall")).status).toBe("completed");
  await session.stop();

  const records = (await Bun.file(session.transcriptPath!).text()).trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records.map((record) => record.seq)).toEqual(records.map((_, index) => index + 1));
  const cancellations = records.filter((record) => record.t === "cancellation");
  expect(cancellations.map((record) => [record.event, record.reason])).toEqual([
    ["requested", "stalled"],
    ["resolved", "stalled"],
  ]);
  const target = cancellations[0]!.operationId as string;
  expect(target.endsWith(":target")).toBe(true);
  // The cancellation is written before the inference's reply and its settle.
  const resolved = records.indexOf(cancellations[1]!);
  const settled = records.findIndex((record) =>
    record.t === "operation" && record.operationId === target && record.event !== "started");
  expect(resolved).toBeLessThan(settled);
}, 20_000);
