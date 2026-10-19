#!/usr/bin/env bun
// Operation lifecycle smoke test: freezes, kills and cancels a real (or mock) harness and checks that
// every request ends visibly and the conversation keeps working. Scenarios and variables: README.md.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Agent, ADAPTERS, AcpClient, type Adapter } from "../../src/index.ts";
import { ToolTracker } from "../../src/operations/activity-tracker.ts";

const env = (key: string) => process.env[`ACP_TEST13_${key}`];
const adapterId = env("ADAPTER") ?? "mock";
const mock = adapterId === "mock";
/** The mock prompt (a fixture mode) or the real one. */
const ask = (mockPrompt: string, realPrompt: string) => (mock ? mockPrompt : realPrompt);

const base: Adapter | undefined = mock
  ? { command: [process.execPath, resolve(import.meta.dir, "../../test/fixtures/lifecycle-agent.ts")] }
  : (ADAPTERS as Record<string, Adapter>)[adapterId];
if (!base) throw new Error(`unknown adapter ${adapterId}`);

const directory = resolve(env("DATA_DIR") ?? import.meta.dir);
await mkdir(directory, { recursive: true });
// The launcher records only the PID of the harness it spawns; signals never target any other process.
const pidFile = join(directory, "harness.pid");
const adapter: Adapter = {
  ...base,
  cancelGraceMs: Number(env("CANCEL_GRACE_MS") ?? 1000),
  command: ["sh", "-c", 'echo $$ > "$1"; shift; exec "$@"', "lifecycle-launch", pidFile, ...base.command],
};
const harnessEnv = mock ? { env: { LIFECYCLE_STATE: join(directory, "sessions.json") } } : {};

const database = join(directory, "agent.sqlite");
for (const suffix of ["", "-wal", "-shm", ".agent-owner.sqlite"]) await rm(database + suffix, { force: true });
const agent = await Agent.open({
  persistence: { kind: "sqlite", path: database },
  adapters: { [adapterId]: adapter },
  defaultAdapterId: adapterId,
  operationLifecycle: {
    turns: {
      firstOutputMs: Number(env("FIRST_OUTPUT_MS") ?? 5000),
      nextOutputMs: Number(env("NEXT_OUTPUT_MS") ?? 5000),
    },
  },
  conversationDefaults: { metering: { pricing: false }, ...harnessEnv },
});

type Conversation = Awaited<ReturnType<typeof agent.conversations.create>>;
const measurements: unknown[] = [];
const failures: { scenario: string; error: string }[] = [];
let activeScenario = "startup";
let scenarioStartedAt = Date.now();
let current: Conversation | undefined;
const heartbeat = setInterval(() => {
  console.log(`${adapterId} ${activeScenario}: ${Math.round((Date.now() - scenarioStartedAt) / 1000)}s elapsed`);
}, 10000);

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function harnessPid(): Promise<number> {
  return Number((await readFile(pidFile, "utf8")).trim());
}

async function newConversation(config?: Parameters<typeof agent.conversations.create>[0]): Promise<Conversation> {
  current = await agent.conversations.create(config);
  return current;
}

function recordEvents(conversation: Conversation): any[] {
  const events: any[] = [];
  conversation.subscribe(({ event }) => events.push(event));
  return events;
}

/** A failing scenario is recorded and the run continues; its conversation is always stopped. */
async function runScenario(name: string, run: () => Promise<void>): Promise<void> {
  activeScenario = name;
  scenarioStartedAt = Date.now();
  try {
    await run();
  } catch (error) {
    failures.push({ scenario: name, error: String(error) });
    console.log(`${name} FAIL: ${String(error)}`);
  } finally {
    await current?.stop().catch(() => {});
    current = undefined;
  }
}

/** s4: freeze with a queued message and two steers pending; the steers recover, the queue is held then released. */
async function s4(): Promise<void> {
  console.log(`${adapterId} s4: freezing with queued messages and recovery steers`);
  const conversation = await newConversation();
  const events = recordEvents(conversation);
  await conversation.prompt("Remember cherry. Reply ready.");
  process.kill(await harnessPid(), "SIGSTOP");

  const failure = conversation.prompt("Reply ready.").catch((error) => error);
  const queued = conversation.prompt({ text: "Now reply done.", delivery: "queue" });
  const a = conversation.prompt({ text: "What happened?", delivery: "steer" });
  const b = conversation.prompt({ text: "Continue with a short reply.", delivery: "steer" });
  const error = await failure;
  check(error.code === "stalled" && JSON.stringify(error.followedBy) === JSON.stringify([a.id, b.id]),
    "s4: missing stall follow-up");

  const [one, two, final] = await Promise.all([a, b, queued]);
  check(one.operationId === two.operationId && final.status === "completed", "s4: wrong recovery delivery");
  const has = (predicate: (event: any) => boolean) => events.some(predicate);
  check(has((event) => event.kind === "message_delivered" && event.via === "stall")
    && has((event) => event.kind === "message_held" && event.id === queued.id)
    && has((event) => event.kind === "message_released" && event.id === queued.id),
    "s4: missing hold/delivery/release events");

  measurements.push({ scenario: "s4", status: "passed", events: events.filter((event) => event.kind.startsWith("message_")) });
  console.log("s4 PASS: steers combined via stall, queued message held then released");
}

/** s2 freezes the harness (SIGSTOP) before a prompt, s3 kills it (SIGKILL) during one; the next prompt reloads. */
async function freezeOrKill(scenario: "s2" | "s3"): Promise<void> {
  console.log(`${adapterId} ${scenario}: preparing a disposable session`);
  const conversation = await newConversation();
  const events = recordEvents(conversation);
  const keyword = `fruit${Date.now()}`;
  await conversation.prompt(`Remember the keyword ${keyword}. Reply ready.`);
  const originalSession = conversation.internalSessionId;
  const pid = await harnessPid();

  let error: any;
  if (scenario === "s2") {
    process.kill(pid, "SIGSTOP");
    console.log(`s2: froze harness ${pid}, waiting for stale cancellation`);
    error = await conversation.prompt("Reply with the keyword.").catch((error) => error);
    check(error.code === "stalled" && error.phase === "no_response" && error.cancel === "forced", `s2: wrong stall ${error}`);
    const records = (await agent.persistence.records.list(conversation.id, { limit: 1000 })).records;
    check(records.some((record: any) => record.kind === "error" && record.code === "stalled"), "s2: no stored stall error");
  } else {
    const pending = conversation.prompt(ask("[lifecycle:ignore]", "Write a very long story about fruit.")).catch((error) => error);
    await Bun.sleep(25);
    process.kill(pid, "SIGKILL");
    console.log(`s3: killed harness ${pid}`);
    error = await pending;
    check(error instanceof Error, "s3: killed turn did not reject");
  }

  const next = await conversation.prompt("What exact keyword did I ask you to remember? Reply with it.");
  check(next.text.includes(keyword), `${scenario}: context was not retained`);
  check(events.some((event) => event.kind === "provider_reconnected" && event.via === "loaded"), `${scenario}: no loaded event`);
  check(conversation.internalSessionId === originalSession, `${scenario}: changed provider session`);
  measurements.push({ scenario, error: String(error), nextStatus: next.status });
  console.log(`${scenario} PASS: failed turn, reconnected, next prompt retained context`);
}

/** s5: a tool that runs longer than both silence limits is not stale. */
async function s5(): Promise<void> {
  console.log(`${adapterId} s5: running a tool longer than both silence limits`);
  const limitMs = mock ? 100 : 15000;
  const conversation = await newConversation({
    runtime: { defaultPermission: "approve", operationLifecycle: { turns: { firstOutputMs: limitMs, nextOutputMs: limitMs } } },
  });
  const started = Date.now();
  let toolSeen = false;
  const result = await conversation.prompt(ask("[lifecycle:tool]",
    "Run sleep 20 in a terminal tool. Allow at least 25000 milliseconds for it and wait for it to exit before replying done."), {
    onActivity: (activity) => { if (activity.kind === "tool") toolSeen = true; },
  });
  check(toolSeen && Date.now() - started >= (mock ? 100 : 20000), "s5: harness did not execute the requested long tool");
  check(result.status === "completed", "s5: long tool did not complete");
  measurements.push({ scenario: "s5", status: result.status, elapsedMs: Date.now() - started, toolSeen });
  console.log("s5 PASS: long tool did not become stale");
}

/** s1: interrupt while a permission handler never answers; the handler is aborted and the next prompt works. */
async function s1(): Promise<void> {
  console.log(`${adapterId} s1: waiting for an open permission`);
  const conversation = await newConversation();
  let signal: AbortSignal | undefined;
  const pending = conversation.prompt(ask("[lifecycle:permission]", "Use a terminal tool to run pwd; request permission before running it."), {
    onPermissionRequest: (_request, abort) => {
      signal = abort;
      return new Promise(() => {});
    },
  });
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + 60_000;
  while (!signal && !settled && Date.now() < deadline) await Bun.sleep(10);
  if (!signal) {
    conversation.interrupt();
    await pending;
    throw new Error("s1: harness did not request permission");
  }

  const start = Date.now();
  conversation.interrupt();
  const result = await pending;
  check(signal.aborted && result.status === "cancelled", "s1: permission cancellation failed");
  const next = await conversation.prompt("Reply ready.");
  check(next.status === "completed", "s1: next prompt failed");
  measurements.push({ scenario: "s1", elapsedMs: Date.now() - start, cancel: result.cancel });
  console.log("s1 PASS: handler aborted, prompt cancelled, next prompt completed");
}

/** m1: first output, the longest gap without a running tool, cancel latency, and load/replay timing. */
async function m1(run: number): Promise<void> {
  console.log(`${adapterId} m1 run ${run + 1}: starting`);
  const conversation = await newConversation();
  const tools = new ToolTracker();
  const started = Date.now();
  let first: number | null = null;
  let last = started;
  let longestGapMs = 0;
  const detach = conversation.connection.subscribeOutput((output) => {
    const now = Date.now();
    first ??= now;
    if (!tools.inFlight) longestGapMs = Math.max(longestGapMs, now - last);
    if (output.kind === "update" && output.activity) tools.observe(output.activity, now);
    last = now;
  });

  await conversation.prompt("Reply with a short sentence confirming you are ready.");
  const normalMs = Date.now() - started;
  const historyTurns = Number(env("HISTORY_TURNS") ?? 0);
  for (let turn = 0; turn < historyTurns; turn++) {
    console.log(`${adapterId} m1 history ${turn + 1}/${historyTurns}`);
    await conversation.prompt(`Remember item ${turn + 1}: fruit-${turn + 1}. Reply with that item only.`);
  }

  const pending = conversation.prompt("Count slowly from one to one hundred, explaining each number.");
  await Bun.sleep(100);
  const cancelledAt = Date.now();
  conversation.interrupt();
  const result = await pending;
  const cancelLatencyMs = Date.now() - cancelledAt;

  const internalSessionId = conversation.internalSessionId!;
  await conversation.connection.forceStop();
  const replayClient = new AcpClient({ adapter, ...harnessEnv });
  let loadMs = 0;
  let replayCount = 0;
  let longestReplayGapMs = 0;
  try {
    await replayClient.connect();
    const loadStarted = Date.now();
    let replayAt = loadStarted;
    await replayClient.loadSession(internalSessionId, {
      onUpdate: () => {
        const now = Date.now();
        longestReplayGapMs = Math.max(longestReplayGapMs, now - replayAt);
        replayAt = now;
        replayCount++;
      },
    });
    loadMs = Date.now() - loadStarted;
  } finally {
    await replayClient.stop();
  }

  const measurement = {
    run,
    firstOutputMs: first === null ? null : first - started,
    longestGapMs,
    normalMs,
    historyTurns,
    cancelLatencyMs,
    cancelStatus: result.status,
    loadMs,
    replayCount,
    longestReplayGapMs,
  };
  measurements.push(measurement);
  console.log(JSON.stringify(measurement));
  detach();
}

try {
  const only = env("ONLY")?.split(",") ?? ["m1", "s1", "s2", "s3", "s4", "s5"];
  if (only.includes("s4")) await runScenario("s4", s4);
  for (const scenario of ["s2", "s3"] as const) {
    if (only.includes(scenario)) await runScenario(scenario, () => freezeOrKill(scenario));
  }
  if (only.includes("s5")) await runScenario("s5", s5);
  if (only.includes("s1")) await runScenario("s1", s1);
  if (only.includes("m1")) {
    for (let run = 0; run < Number(env("RUNS") ?? 3); run++) await runScenario(`m1-${run}`, () => m1(run));
  }
} finally {
  clearInterval(heartbeat);
  await agent.close();
  await writeFile(join(directory, "results.json"), JSON.stringify({ adapterId, measurements, failures }, null, 2));
}

if (failures.length) process.exitCode = 1;
