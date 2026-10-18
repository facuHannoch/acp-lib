#!/usr/bin/env bun
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Agent, ADAPTERS, type Adapter } from "../../src/index.ts";
import { ToolTracker } from "../../src/operations/activity-tracker.ts";
const env = (key: string) => process.env[`ACP_TEST13_${key}`];
const adapterId = env("ADAPTER") ?? "mock";
const adapter: Adapter = adapterId === "mock"
  ? { command: [process.execPath, resolve(import.meta.dir, "../../test/fixtures/lifecycle-agent.ts")] }
  : (ADAPTERS as Record<string, Adapter>)[adapterId]!;
if (!adapter) throw new Error(`unknown adapter ${adapterId}`);
const directory = resolve(env("DATA_DIR") ?? import.meta.dir);
await mkdir(directory, { recursive: true });
const database = join(directory, "agent.sqlite");
for (const suffix of ["", "-wal", "-shm", ".agent-owner.sqlite"]) await rm(database + suffix, { force: true });
const agent = await Agent.open({ persistence: { kind: "sqlite", path: database }, adapters: { [adapterId]: adapter },
  defaultAdapterId: adapterId, conversationDefaults: { metering: { pricing: false }, ...(adapterId === "mock" ? { env: { LIFECYCLE_STATE: join(directory, "sessions.json") } } : {}) } });
const measurements: unknown[] = [];
try {
  const only = env("ONLY")?.split(",") ?? ["m1"];
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
