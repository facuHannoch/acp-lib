#!/usr/bin/env bun
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Agent, ADAPTERS, type Adapter } from "../../src/index.ts";
import { ToolTracker } from "../../src/operations/activity-tracker.ts";
const env = (key: string) => process.env[`ACP_TEST13_${key}`];
const adapterId = env("ADAPTER") ?? "mock";
let adapter: Adapter = adapterId === "mock"
  ? { command: [process.execPath, resolve(import.meta.dir, "../../test/fixtures/lifecycle-agent.ts")] }
  : (ADAPTERS as Record<string, Adapter>)[adapterId]!;
if (!adapter) throw new Error(`unknown adapter ${adapterId}`);
const directory = resolve(env("DATA_DIR") ?? import.meta.dir);
await mkdir(directory, { recursive: true });
const pidFile = join(directory, "harness.pid");
adapter = { ...adapter, cancelGraceMs: Number(env("CANCEL_GRACE_MS") ?? 1000), command: ["sh", "-c", 'echo $$ > "$1"; shift; exec "$@"', "lifecycle-launch", pidFile, ...adapter.command] };
const database = join(directory, "agent.sqlite");
for (const suffix of ["", "-wal", "-shm", ".agent-owner.sqlite"]) await rm(database + suffix, { force: true });
const agent = await Agent.open({ persistence: { kind: "sqlite", path: database }, adapters: { [adapterId]: adapter },
  defaultAdapterId: adapterId, operationLifecycle: { turns: { firstOutputMs: Number(env("FIRST_OUTPUT_MS") ?? 5000), nextOutputMs: Number(env("NEXT_OUTPUT_MS") ?? 5000) } }, conversationDefaults: { metering: { pricing: false }, ...(adapterId === "mock" ? { env: { LIFECYCLE_STATE: join(directory, "sessions.json") } } : {}) } });
const measurements: unknown[] = [];
try {
  const only = env("ONLY")?.split(",") ?? ["m1"];
  for (const scenario of ["s2", "s3"]) if (only.includes(scenario)) {
    console.log(`${adapterId} ${scenario}: preparing a disposable session`);
    const conversation = await agent.conversations.create();
    const events: any[] = []; conversation.subscribe(({ event }) => events.push(event));
    const keyword = `fruit${Date.now()}`;
    await conversation.prompt(`Remember the keyword ${keyword}. Reply ready.`);
    const originalSession = conversation.internalSessionId;
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    let error: any;
    if (scenario === "s2") {
      process.kill(pid, "SIGSTOP");
      console.log(`s2: froze harness ${pid}, waiting for stale cancellation`);
      error = await conversation.prompt("Reply with the keyword.").catch((error) => error);
      if (error.code !== "stalled" || error.phase !== "no_response" || error.cancel !== "forced") throw new Error(`s2: wrong stall ${error}`);
      const records = (await agent.persistence.records.list(conversation.id, { limit: 1000 })).records;
      if (!records.some((record: any) => record.kind === "error" && record.code === "stalled")) throw new Error("s2: no stored stall error");
    } else {
      const pending = conversation.prompt(adapterId === "mock" ? "[lifecycle:ignore]" : "Write a very long story about fruit.").catch((error) => error);
      await Bun.sleep(25); process.kill(pid, "SIGKILL");
      console.log(`s3: killed harness ${pid}`); error = await pending;
      if (!(error instanceof Error)) throw new Error("s3: killed turn did not reject");
    }
    const next = await conversation.prompt("What exact keyword did I ask you to remember? Reply with it.");
    if (!next.text.includes(keyword)) throw new Error(`${scenario}: context was not retained`);
    if (!events.some((event) => event.kind === "provider_reconnected" && event.via === "loaded")) throw new Error(`${scenario}: no loaded event`);
    if (conversation.internalSessionId !== originalSession) throw new Error(`${scenario}: changed provider session`);
    measurements.push({ scenario, error: String(error), nextStatus: next.status });
    console.log(`${scenario} PASS: failed turn, reconnected, next prompt retained context`); await conversation.stop();
  }
  if (only.includes("s5")) {
    console.log(`${adapterId} s5: running a tool longer than both silence limits`);
    const conversation = await agent.conversations.create({ runtime: { operationLifecycle: { turns: { firstOutputMs: adapterId === "mock" ? 100 : 5000, nextOutputMs: adapterId === "mock" ? 100 : 5000 } } } });
    const result = await conversation.prompt(adapterId === "mock" ? "[lifecycle:tool]" : "Run sleep 8 in a terminal tool, then reply done.");
    if (result.status !== "completed") throw new Error("s5: long tool did not complete");
    measurements.push({ scenario: "s5", status: result.status }); console.log("s5 PASS: long tool did not become stale");
    await conversation.stop();
  }
  if (only.includes("s1")) {
    console.log(`${adapterId} s1: waiting for an open permission`);
    const conversation = await agent.conversations.create();
    let signal: AbortSignal | undefined;
    const pending = conversation.prompt(adapterId === "mock" ? "[lifecycle:permission]" : "Use a terminal tool to run pwd; request permission before running it.", {
      onPermissionRequest: (_request, abort) => { signal = abort; return new Promise(() => {}); },
    });
    const deadline = Date.now() + 60_000;
    while (!signal && Date.now() < deadline) await Bun.sleep(10);
    if (!signal) { conversation.interrupt(); await pending; throw new Error("s1: harness did not request permission"); }
    const start = Date.now(); conversation.interrupt(); const result = await pending;
    if (!signal.aborted || result.status !== "cancelled") throw new Error("s1: permission cancellation failed");
    const next = await conversation.prompt("Reply ready.");
    if (next.status !== "completed") throw new Error("s1: next prompt failed");
    measurements.push({ scenario: "s1", elapsedMs: Date.now() - start, cancel: result.cancel });
    console.log("s1 PASS: handler aborted, prompt cancelled, next prompt completed");
    await conversation.stop();
  }
  if (only.includes("m1")) for (let run = 0; run < Number(env("RUNS") ?? 3); run++) {
    console.log(`${adapterId} m1 run ${run + 1}: starting`);
    const conversation = await agent.conversations.create();
    const tools = new ToolTracker();
    let first: number | null = null, last = Date.now(), longestGapMs = 0;
    const started = last;
    const detach = conversation.connection.subscribeOutput((output) => {
      const now = Date.now();
      first ??= now;
      if (!tools.inFlight) longestGapMs = Math.max(longestGapMs, now - last);
      if (output.kind === "update" && output.activity) tools.observe(output.activity, now);
      last = now;
    });
    await conversation.prompt("Reply with a short sentence confirming you are ready.");
    const normalMs = Date.now() - started;
    const pending = conversation.prompt("Count slowly from one to one hundred, explaining each number.");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancelledAt = Date.now();
    conversation.interrupt();
    const result = await pending;
    const measurement = { run, firstOutputMs: first === null ? null : first - started, longestGapMs,
      normalMs, cancelLatencyMs: Date.now() - cancelledAt, cancelStatus: result.status };
    measurements.push(measurement);
    console.log(JSON.stringify(measurement));
    detach();
    await conversation.stop();
  }
} finally {
  await agent.close();
  await writeFile(join(directory, "results.json"), JSON.stringify({ adapterId, measurements }, null, 2));
}
