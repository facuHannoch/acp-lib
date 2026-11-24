import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRehearsal, type RehearsalOptions } from "./rehearsal.ts";
import { until } from "./support.ts";
import type { ScenarioRecord, ScenarioSend } from "../../src/native-harness/src/testing.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const send = (channelId: string, inputId: string, atMs = 0): ScenarioSend => ({
  type: "send", atMs, channelId, inputId, participantId: "operator", text: inputId,
});
const reply = (channelId: string, content: string): ScenarioRecord => ({ type: "model", channelId, content });
const call = (channelId: string, id: string, name: string, args: Record<string, unknown> = {}): ScenarioRecord => ({
  type: "model", channelId, content: null, calls: [{ id, name, arguments: args }],
});
const hold = () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release };
};
async function rehearsal(records: ScenarioRecord[], options: Omit<RehearsalOptions, "deadlineMs"> & { deadlineMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "rehearsal-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "test.jsonl");
  await writeFile(path, [{ type: "scenario", version: 1, name: "deterministic" }, ...records].map(record => JSON.stringify(record)).join("\n") + "\n");
  const run = await createRehearsal(path, { deadlineMs: 12_000, ...options, env: { HARNESS_TEST_ATTEMPTS: join(directory, "attempts.jsonl"), ...options.env } });
  cleanup.push(() => run.close());
  return run;
}

test("rehearsal schedules a burst and waits for a notice-only turn after the last input ends", async () => {
  const entered = hold(), release = hold();
  const run = await rehearsal([
    send("alice", "a"), send("bob", "b"), call("alice", "notify", "notify_channel", { channelId: "notice", text: "wake" }),
    reply("alice", "sent notice"), reply("bob", "Bob finished"),
    call("notice", "quiet", "quiet"), reply("notice", "Notice completed"),
  ], { exactConsumption: true, functions: { tools: { quiet: {
    description: "A controlled quiet callback", parameters: { type: "object" },
    async handler() { entered.release(); await release.waiting; return { done: true }; },
  } } } });
  let complete = false;
  const summary = run.run().then(value => { complete = true; return value; });
  await entered.waiting;
  try {
    await until(() => run.activity.filter(event => event.kind === "completed" && event.channel !== "notice").length === 2);
    expect(complete).toBe(false);
    expect(run.sends.map(send => send.inputId)).toEqual(["a", "b"]);
  } finally { release.release(); }
  const result = await summary;
  expect(result.sends.map(send => send.outcome)).toEqual(["completed", "completed"]);
  expect(result.replies.notice).toHaveLength(1);
  expect(result.effects).toMatchObject([{ tool: "quiet", channel: "notice", outcome: "completed" }]);
  expect(run.exits).toEqual([0]);
}, 20_000);

test("real stdio streaming, host approval, steering evidence, and targeted interruption", async () => {
  const second = hold(), release = hold(), entered = hold();
  let calls = 0, approvals = 0;
  const run = await rehearsal([
    { type: "model", channelId: "alice", content: "Working", chunks: [{ afterMs: 0, text: "Work" }, { afterMs: 0, text: "ing" }],
      calls: [{ id: "quiet", name: "quiet", arguments: {} }] },
    reply("alice", "Steered"),
    call("alice", "interrupt", "quiet"),
    reply("bob", "Bob completed"),
  ], { expected: { interrupted: "interrupted" }, policies: { rehearsal: { fallback: "allow", tools: { quiet: "ask" } } },
    approvalResponder: async (_request, answer) => { approvals++; expect(await answer("allow_once")).toBe(true); },
    functions: { tools: { quiet: {
      description: "A test callback that waits", parameters: { type: "object" },
      async handler(_args, context) {
        if (++calls === 1) { entered.release(); await release.waiting; return { effect: "once" }; }
        second.release();
        await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("interrupted callback");
      },
    } } } });
  await run.setup();
  await run.issue(send("alice", "first"));
  await entered.waiting;
  expect(run.activity.filter(event => event.channel === "alice" && event.kind === "text_delta").reduce((n, event) => n + (event.characters ?? 0), 0)).toBe(7);
  await run.issue(send("bob", "bob"));
  await until(() => run.activity.some(event => event.channel === "bob" && event.kind === "completed"));
  await run.issue(send("alice", "steer"));
  release.release();
  await until(() => run.activity.some(event => event.channel === "alice" && event.kind === "completed"));
  await run.issue(send("alice", "interrupted"));
  await second.waiting;
  const active = (await run.host.status()).channels.find(channel => channel.channel === "alice")?.activeTurn;
  expect(await run.host.interrupt("alice", active!.turnId)).toBe(true);
  const result = await run.finish();
  expect(result.sends[0]?.turnId).toBe(result.sends[2]?.turnId);
  expect(result.sends[3]?.outcome).toBe("interrupted");
  const attempts = readFileSync(run.env.HARNESS_TEST_ATTEMPTS!, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(attempts.filter(attempt => attempt.channel === "alice").map(attempt => attempt.itemIds)).toEqual([["first"], ["steer"], ["interrupted"]]);
  expect(approvals).toBe(2);
  expect(result.effects.filter(effect => effect.outcome === "completed")).toHaveLength(1);
}, 20_000);

test("deadline reports active work and reaps the stdio child", async () => {
  const run = await rehearsal([send("alice", "pending"), { type: "model", channelId: "alice", wait: "cancel" }],
    { deadlineMs: 600, cleanupMs: 800 });
  await expect(run.run()).rejects.toThrow(/blocking status:.*"stage":"(channel settlement|inbox acknowledgments)".*"sample":\["pending"\].*"workingChannels":1.*"phase":\{"kind":"model"/);
  expect(run.exits).toHaveLength(1);
  expect(run.children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
}, 12_000);

test("detached notice recovery and a suspended callback survive real child replacement", async () => {
  const entered = hold(), release = hold();
  let effects = 0;
  const run = await rehearsal([
    reply("alice", "baseline"), reply("alice", "detached reply"), call("alice", "pause", "pause"), reply("alice", "resumed reply"),
    call("bob", "notify", "notify_channel", { channelId: "alice", text: "wake" }), reply("bob", "notice sent"),
  ], { functions: { tools: { pause: {
    description: "A checkpoint callback", parameters: { type: "object" },
    async handler() { effects++; entered.release(); await release.waiting; return { recorded: true }; },
  } } } });
  await run.setup();
  await run.issue(send("alice", "baseline"));
  await until(() => run.activity.some(event => event.channel === "alice" && event.kind === "completed"));
  const cursor = (await run.host.conversationMessages({ channel: "alice", limit: 1 })).messages[0]!.position;
  run.unobserve("alice");
  await run.issue(send("bob", "notice"));
  await until(async () => (await run.host.status()).execution === "idle");
  await run.recover("alice", cursor);
  await run.issue(send("alice", "checkpoint"));
  await entered.waiting;
  const pause = run.host.suspend();
  await until(async () => (await run.host.status()).lifecycle === "suspending");
  release.release();
  expect((await pause).lifecycle).toBe("suspended");
  await run.host.stop();
  await run.host.start();
  expect((await run.host.status()).lifecycle).toBe("suspended");
  await run.host.resume();
  const summary = await run.finish();
  expect(effects).toBe(1);
  expect(summary.replies.alice).toHaveLength(3);
  expect(summary.replies.bob).toHaveLength(1);
  expect(summary.unused).toEqual({ alice: 0, bob: 0 });
  expect(run.children).toHaveLength(2);
}, 20_000);

for (const fault of ["startAttempt:1", "tool:1"]) test(`rehearsal preserves the reserved step and fences effects after ${fault}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "rehearsal-crash-effects-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const effectsPath = join(directory, "effects.log");
  const run = await rehearsal([
    call("alice", "effect", "record", { text: "external effect" }), reply("alice", "fresh reply"),
  ], { expected: { crashed: "interrupted" }, env: { HARNESS_TEST_FAULT: fault, HARNESS_TEST_EFFECTS: effectsPath } });
  await run.setup();
  delete run.env.HARNESS_TEST_FAULT;
  await run.issue(send("alice", "crashed"));
  await until(() => run.children.length === 2 && run.host.state === "running", "replacement after crash");
  const before = (await run.host.status()).channels[0]?.unresolved;
  expect(before?.state).toBe("interrupted");
  expect(before?.uncertainCalls).toEqual(fault === "tool:1" ? ["effect"] : []);
  await run.issue(send("alice", "fresh"));
  const summary = await run.finish();
  expect(summary.unused.alice).toBe(0);
  const calls = (await run.host.modelCalls()).calls;
  expect(calls.flatMap(call => call.attempts.map(attempt => attempt.scriptStep))).toEqual([0, 1]);
  const effects = await Bun.file(effectsPath).exists() ? readFileSync(effectsPath, "utf8").trim().split("\n") : [];
  expect(effects).toEqual(fault === "tool:1" ? ["external effect"] : []);
  expect(summary.replies.alice).toHaveLength(1);
}, 20_000);

test("an unexpected paired tool failure fails a completed rehearsal", async () => {
  const run = await rehearsal([send("alice", "a"), call("alice", "failed", "fail"), reply("alice", "completed")], {
    functions: { tools: { fail: {
      description: "Fails intentionally", parameters: { type: "object" },
      handler() { throw new Error("callback failed"); },
    } } },
  });
  await expect(run.run()).rejects.toThrow("Unexpected tool failed: fail on alice");
  expect(run.exits).toEqual([0]);
}, 12_000);

test("an explicitly expected model timeout is reported as a terminal input outcome", async () => {
  const run = await rehearsal([send("alice", "slow"), { type: "model", channelId: "alice", wait: "cancel" }],
    { expected: { slow: "timeout" }, env: { HARNESS_TEST_MODEL_TIMEOUT_MS: "100" } });
  const output = await run.run();
  expect(output.sends).toMatchObject([{ inputId: "slow", outcome: "failed", reason: "timeout" }]);
  expect(output.replies.alice).toEqual([]);
  expect(run.exits).toEqual([0]);
}, 12_000);

test("the timed fixture runs in CI with shortened offsets and the same bounded handlers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rehearsal-short-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const long = new URL("./fixtures/rehearsal-two-minutes.jsonl", import.meta.url);
  const { loadScenario } = await import("../../src/native-harness/src/testing.ts");
  const { createTimedRehearsal } = await import("./rehearsal-cli.ts");
  const scenario = await loadScenario(long.pathname);
  const lines = readFileSync(long, "utf8").trimEnd().split("\n").map(line => {
    const record = JSON.parse(line) as ScenarioRecord;
    if (record.type === "send") return JSON.stringify({ ...record, atMs: record.atMs / 1000 });
    if (record.type === "model" && record.calls)
      return JSON.stringify({ ...record, calls: record.calls.map(call => call.name === "quiet"
        ? { ...call, arguments: { delayMs: Number(call.arguments.delayMs) / 10 } } : call) });
    return line;
  });
  const path = join(directory, "short.jsonl");
  await writeFile(path, lines.join("\n") + "\n");
  const channelCompleted = (channel: string, count: number) =>
    run.activity.filter(event => event.channel === channel && event.kind === "completed").length >= count;
  const run = await createTimedRehearsal(path, 12_000, async channel => {
    if (channel === "alice") await until(() => channelCompleted("bob", 1), "Bob's first turn");
    if (channel === "follow-up") await until(() => channelCompleted("alice", 3), "Alice's final turn");
  });
  cleanup.push(() => run.close());
  const output = await run.run(async offset => {
    if (!offset) return;
    const required = offset === 45 ? 1 : 2;
    await until(() => channelCompleted("alice", required) && channelCompleted("bob", required), "previous burst");
  });
  expect(output.fileDigest).not.toBe(scenario.fileDigest);
  expect(output.sends.map(send => send.inputId)).toEqual(["a-early", "b-early", "b-mid", "a-mid", "a-final"]);
  expect(output.sends.every(send => send.outcome === "completed")).toBe(true);
  expect(output.unused).toEqual({ alice: 0, bob: 0, "follow-up": 0 });
  expect(output.effects).toHaveLength(4);
  const earlyAlice = output.sends.find(send => send.inputId === "a-early")!;
  const earlyBob = output.sends.find(send => send.inputId === "b-early")!;
  const completedAt = (channel: string, turnId?: string) =>
    output.activity.find(event => event.channel === channel && event.kind === "completed" && (turnId === undefined || event.turnId === turnId))!.elapsed;
  expect(completedAt("bob", earlyBob.turnId)).toBeLessThan(completedAt("alice", earlyAlice.turnId));
  expect(completedAt("follow-up")).toBeGreaterThan(completedAt("alice", output.sends.at(-1)?.turnId));
  expect(output.replies["follow-up"]).toHaveLength(1);
  expect(output.historyPages).toBe(3);
  expect(run.exits).toEqual([0]);
}, 20_000);

test("settlement accounts for more than one reconcile page of inputs", async () => {
  const entered = hold(), release = hold();
  const records = Array.from({ length: 105 }, (_, index) => send("alice", `input-${index}`));
  // The first inference takes one input. The remaining 104 take seven
  // batches of at most 16 before the turn can finish.
  const replies = Array.from({ length: 7 }, () => reply("alice", "ok"));
  const run = await rehearsal([...records, call("alice", "batch", "hold_batch"), ...replies], {
    deadlineMs: 20_000, exactConsumption: true,
    functions: { tools: { hold_batch: {
      description: "Hold one turn while the test submits a batch of inputs", parameters: { type: "object" },
      async handler() { entered.release(); await release.waiting; return { done: true }; },
    } } },
  });
  await run.setup();
  try {
    await run.issue(records[0]!);
    await entered.waiting;
    await Promise.all(records.slice(1).map(record => run.issue(record)));
  } finally { release.release(); }
  const report = await run.finish();
  expect(report.sends).toHaveLength(105);
  expect(report.sends.every(send => send.outcome === "completed" && send.turnId !== undefined)).toBe(true);
  expect(new Set(report.sends.map(send => send.turnId)).size).toBe(1);
  await run.close();
  expect(run.exits).toEqual([0]);
}, 30_000);

test("cumulative real stdio phase searches and reads an attributed timeline source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeline-rehearsal-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const requests = join(directory, "requests.jsonl");
  const run = await createRehearsal(new URL("./fixtures/rehearsal-cumulative.jsonl", import.meta.url).pathname, {
    deadlineMs: 15_000, exactConsumption: true, timelineTools: true,
    env: { HARNESS_TEST_REQUESTS: requests, HARNESS_TEST_ATTEMPTS: join(directory, "attempts.jsonl") },
  });
  const summary = await run.run(async offset => {
    if (offset) await until(() => run.activity.filter(event => event.kind === "completed").length >= offset, "previous phase completed");
  });
  expect(summary.sends.every(send => send.outcome === "completed")).toBe(true);
  const captures = readFileSync(requests, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.channel === "review");
  expect(captures).toHaveLength(4);
  const result = (index: number, call: string) => {
    const row = captures[index].messages.find((message: { role: string; callId?: string }) => message.role === "tool" && message.callId === call);
    return JSON.parse(row.content);
  };
  expect(result(1, "timeline-search").hits).toContainEqual(expect.objectContaining({
    message_id: "item:launch-decision", channel: "decisions", sender: "Rin",
  }));
  expect(result(2, "timeline-read").messages).toContainEqual(expect.objectContaining({
    message_id: "item:launch-correction", channel: "decisions", sender: "Rin", text: "Launch correction: ship Monday.",
  }));
  const later = JSON.stringify(captures[3].messages);
  expect(later).toContain("Launch correction: ship Monday.");
  expect(later).not.toContain("timeline-search");
  expect(later).not.toContain("timeline-read");
}, 30_000);

test("cumulative real stdio rehearsal includes a managed image provider phase", async () => {
  const { imageValidationAvailable } = await import("../../src/native-harness/src/capabilities/attachments/image-validation.ts");
  if (!imageValidationAvailable()) return;
  const { createHash } = await import("node:crypto");
  const directory = await mkdtemp(join(tmpdir(), "attachment-rehearsal-"));
  const requests = join(directory, "requests.jsonl");
  const projected: any[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    projected.push(await request.json());
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "fixture" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const run = await createRehearsal(new URL("./fixtures/rehearsal-cumulative-attachments.jsonl", import.meta.url).pathname, {
    deadlineMs: 25000, exactConsumption: true, timelineTools: true, imageInput: true,
    env: { HARNESS_TEST_REQUESTS: requests, HARNESS_TEST_ATTEMPTS: join(directory, "attempts.jsonl"), HARNESS_TEST_PROVIDER_ENDPOINT: `http://127.0.0.1:${provider.port}/` },
  });
  try {
    await run.setup();
    await run.schedule(async offset => { if (offset) await until(() => run.activity.filter(event => event.kind === "completed").length >= offset, "previous phase completed"); });
    await until(() => run.activity.filter(event => event.kind === "completed").length >= 4, "earlier phases completed");
    const client = run.client();
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4y8AARAwQCgAfrgP19hgqWQAAAABJRU5ErkJggg==", "base64");
    const begun = await client.beginAttachment({ channel: "vision", filename: "fixture.png", mediaType: "image/png", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    await client.writeAttachment({ channel: "vision", uploadId: begun.uploadId, offset: 0, data: bytes.toString("base64") });
    await client.finalizeAttachment({ channel: "vision", uploadId: begun.uploadId });
    expect((await client.push({ channel: "vision", item: { id: "image-phase", kind: "user_message", sender: "operator", content: [{ type: "text", text: "Look" }, { type: "attachment", id: begun.attachmentId }] } })).accepted).toBe(true);
    await until(() => run.activity.some(event => event.channel === "vision" && event.kind === "completed"), "image phase completed");
    expect(Buffer.from((await client.readAttachment({ channel: "vision", id: begun.attachmentId, offset: 0 })).data, "base64")).toEqual(bytes);
    const summary = await run.finish();
    expect(Object.values(summary.unused).every(count => count === 0)).toBe(true);
    expect(projected).toHaveLength(1);
    const message = projected[0].messages.find((item: any) => Array.isArray(item.content) && item.content.some((part: any) => part.type === "image_url"));
    expect(message.content.some((part: any) => part.type === "image_url" && part.image_url.url === `data:image/png;base64,${bytes.toString("base64")}`)).toBe(true);
    const captures = readFileSync(requests, "utf8");
    expect(captures).toContain("launch-correction");
    expect(captures).not.toContain(bytes.toString("base64"));
  } finally { await run.close(); provider.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 35000);
