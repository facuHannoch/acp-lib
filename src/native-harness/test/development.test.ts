import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDevelopment } from "../src/interfaces/cli/development.ts";
import { serveInspector } from "../src/interfaces/inspector/server.ts";
import { controlLocal, sendLocal, serveLocal } from "../src/interfaces/protocol/local.ts";
import { composeSystemPrompt } from "../src/capabilities/context/load-instructions.ts";
import { buildSharedContext } from "../src/capabilities/context/build.ts";
import { ask, turnsEnd } from "./helpers/session.ts";

const root = mkdtempSync(join(tmpdir(), "harness-dev-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const script = new URL("./fixtures/development-lifecycle.jsonl", import.meta.url).pathname;
const systemPrompt = "Development test system";
function holdTool(wait: () => Promise<void>) {
  return {
    tools: [{ name: "test_hold", description: "Wait until the test releases the turn.", parameters: { type: "object" } }],
    async executeTool() { await wait(); return JSON.stringify({ ok: true }); },
  };
}
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${what}`);
}

test("a reopened development session shows its restored timeline and status in the inspector before any new message", async () => {
  const database = join(mkdtempSync(join(root, "db-")), "session.sqlite");
  await expect(openDevelopment({ systemPrompt, database, script })).rejects.toThrow("Pass --create");
  const first = await openDevelopment({ systemPrompt, database, create: true, script, scriptedTools: holdTool(async () => {}) });
  first.session.start();
  expect(await ask(first.session, { channelId: "channel2", participantId: "bob", text: "Hi, I am Bob" })).toBe("Hello Bob.");
  // Alice's channel notifies Bob's, which answers in a notice-started turn.
  const noticed = turnsEnd(first.session, 2);
  first.local.agent.send({ channelId: "channel1", participantId: "alice", text: "Send the verification notice to Bob" });
  await noticed.done;
  const before = first.inspection.status();
  const liveBefore = first.inspection.liveContext();
  const callsBefore = before.channels.map(channel => first.inspection.modelCalls(channel.id).modelCalls);
  expect(before.session).toMatchObject({ storage: database, lifecycle: "running", execution: "idle" });
  first.close();
  await expect(openDevelopment({ systemPrompt, database, create: true, script })).rejects.toThrow("already_exists");

  const second = await openDevelopment({ systemPrompt, database, script, scriptedTools: holdTool(async () => {}) });
  const server = serveInspector(second.inspection, 0);
  try {
    // Nothing has been sent, started or resumed in this process.
    const state = second.inspection.status();
    const live = second.inspection.liveContext();
    expect(live.entries).toEqual(liveBefore.entries);
    expect(live.entries.map(entry => `${entry.channelId}:${entry.message.role}`).sort()).toEqual([
      "channel1:assistant", "channel1:assistant", "channel1:tool", "channel1:user", "channel2:assistant", "channel2:assistant", "channel2:user", "channel2:user"]);
    expect(live.base).toEqual(buildSharedContext(second.session.store.snapshot(), composeSystemPrompt(systemPrompt)));
    expect(live.base[1]!.content).toContain("Verification notice from channel1.");
    expect(state.channels.map(channel => [channel.id, channel.pending, channel.running])).toEqual([
      ["channel2", 0, false], ["channel1", 0, false]]);
    expect(state.session).toMatchObject({ storage: database, sessionId: "development", lifecycle: "running", execution: "idle", revision: before.session.revision });
    const calls = state.channels.map(channel => second.inspection.modelCalls(channel.id).modelCalls);
    expect(calls).toEqual(callsBefore);
    expect(calls.flat().every(call => call.outcome === "succeeded")).toBe(true);
    // The served page data is the same restored state.
    expect(await (await fetch(new URL("/state", server.url))).json()).toEqual(state);
    expect((await (await fetch(server.url)).text())).toContain("session ' + session.lifecycle");
    // New work continues the same session: IDs and each channel's script carry on.
    second.session.start();
    expect(await ask(second.session, { channelId: "channel2", participantId: "bob", text: "Anything new?" })).toBe("Bob, I received your later message.");
    expect(second.session.snapshot().turns.map(turn => turn.turnId)).toEqual([1, 2, 3, 4]);
  } finally { await server.stop(true); second.close(); }
});

test("development startup controls: suspend over the local socket, reopen paused, inspect, then resume", async () => {
  const directory = mkdtempSync(join(root, "db-")), database = join(directory, "session.sqlite"), socket = join(directory, "agent.sock");
  let releaseHold!: () => void;
  const holdGate = new Promise<void>(resolve => { releaseHold = resolve; });
  let waits = 0;
  const first = await openDevelopment({ systemPrompt, database, create: true, script, scriptedTools: holdTool(() => { waits++; return holdGate; }) });
  first.session.start();
  const firstServer = serveLocal(first.local, socket, undefined, first.session);
  try {
    expect(await sendLocal(socket, { channelId: "channel2", participantId: "bob", text: "Hi" })).toBe("Hello Bob.");
    expect(await sendLocal(socket, { channelId: "channel1", participantId: "alice", text: "Tell Bob" })).toBe("Test: the harness accepted the notice for Bob’s channel.");
    await until(() => first.session.agent.idle(), "notice turn");
    // A test callback is running when suspension is requested.
    const working = sendLocal(socket, { channelId: "channel1", participantId: "alice", text: "Run the hold tool" }).then(() => "answered", error => String(error));
    await until(() => waits === 1, "test callback to start");
    expect(await controlLocal(socket, "status")).toMatchObject({ lifecycle: "running", execution: "working" });
    const suspending = controlLocal(socket, "suspend");
    await until(() => first.inspection.status().session!.lifecycle === "suspending", "suspension to begin");
    await expect(sendLocal(socket, { channelId: "channel2", participantId: "bob", text: "too late" })).rejects.toThrow("not admitted");
    releaseHold();
    expect(await suspending).toMatchObject({ lifecycle: "suspended", execution: "suspended" });
    expect(first.inspection.status().channels.find(channel => channel.id === "channel1")).toMatchObject({ turn: "suspended", running: false });
    // The request held for that turn is released rather than left open across the suspension.
    expect(await working).toContain("suspended before this turn finished");
  } finally { await firstServer.stop(true); first.session.stop("test shutdown"); first.close(); }

  // Reopened without --resume: paused, fully visible, and inert.
  const second = await openDevelopment({ systemPrompt, database, script, scriptedTools: holdTool(async () => { waits++; }) });
  const secondServer = serveLocal(second.local, socket, undefined, second.session);
  try {
    second.session.start();
    const state = second.inspection.status();
    expect(state.session).toMatchObject({ lifecycle: "suspended", execution: "suspended" });
    expect(state.channels.find(channel => channel.id === "channel1")).toMatchObject({ turn: "suspended", running: false, pending: 0 });
    expect(second.inspection.liveContext().entries.at(-1)).toMatchObject({ channelId: "channel1", message: { role: "tool", callId: "hold-1" } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(second.inspection.status()).toEqual(state);
    expect(state.channels.every(channel => second.inspection.channel(channel.id).requests.length === 0)).toBe(true);
    await expect(sendLocal(socket, { channelId: "channel2", participantId: "bob", text: "still paused" })).rejects.toThrow("not admitted");
    // Explicit resume continues the checkpointed turn without repeating the test callback.
    const ended = turnsEnd(second.session);
    expect(await controlLocal(socket, "resume")).toMatchObject({ lifecycle: "running" });
    const events = await ended.done;
    expect(events.map(event => event.event.type)).toEqual(["turn_resumed", "message_completed", "turn_ended"]);
    expect(waits).toBe(1);
    expect(second.inspection.status().session).toMatchObject({ lifecycle: "running", execution: "idle" });
    expect(await sendLocal(socket, { channelId: "channel2", participantId: "bob", text: "back?" })).toBe("Bob, I received your later message.");
    await expect(fetch("http://localhost/session?action=delete", { unix: socket, method: "POST" }).then(response => response.status)).resolves.toBe(400);
  } finally { await secondServer.stop(true); second.close(); }
}, 15000);

test("a process that ends without suspending reopens with its unfinished turn shown as interrupted, not retried", async () => {
  const database = join(mkdtempSync(join(root, "db-")), "session.sqlite");
  let waits = 0;
  const first = await openDevelopment({ systemPrompt, database, create: true, script: new URL("./fixtures/development-lifecycle.jsonl", import.meta.url).pathname,
    scriptedTools: holdTool(() => { waits++; return new Promise(() => {}); }) });
  first.session.start();
  await ask(first.session, { channelId: "channel2", participantId: "bob", text: "Hi" });
  await ask(first.session, { channelId: "channel1", participantId: "alice", text: "Tell Bob" });
  await until(() => first.session.agent.idle(), "notice turn");
  first.local.agent.send({ channelId: "channel1", participantId: "alice", text: "Run the hold tool" });
  await until(() => waits === 1, "test callback to start");
  // Closing storage with a tool in flight is what an abrupt exit leaves behind.
  first.close();

  const second = await openDevelopment({ systemPrompt, database, script, scriptedTools: holdTool(async () => { waits++; }) });
  try {
    const channel = second.inspection.status().channels.find(candidate => candidate.id === "channel1")!;
    expect(channel).toMatchObject({ running: false, unresolved: { status: "interrupted", uncertainCallIds: ["hold-1"] } });
    expect(channel.error).toContain("interrupted");
    expect(second.inspection.liveContext().base[1]!.content).toContain('"uncertainToolCalls":["hold-1"]');
    second.session.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(waits).toBe(1);
    expect(second.session.agent.idle()).toBe(true);
  } finally { second.close(); }
});

test("opted-in Channels diagnostics annotate the actual scripted request with its context revision", async () => {
  const development = await openDevelopment({ systemPrompt, script, environment: { HARNESS_CAPTURE_SCRIPT_REQUESTS: "1" } });
  try {
    development.session.start();
    await ask(development.session, { channelId: "channel2", participantId: "bob", text: "Hello" });
    const snapshot = development.inspection.status();
    const request = development.inspection.channel("channel2").requests[0]!;
    expect(request.context!.revision).toBeLessThan(snapshot.session!.revision);
    expect(request.context!.estimatedInputBytes).toBeGreaterThan(0);
    expect(request.context!.records).toMatchObject({ included: expect.any(Array), trimmed: [] });
    const modelCall = development.inspection.modelCalls("channel2").modelCalls[0]!;
    expect(request.context!.modelCallId).toBe(modelCall.callId);
    expect(modelCall.attempts[0]?.outcome).toBe("succeeded");
    expect(request.context!.omitted).toEqual({ active: 0, local: 0, shared: 0 });
    const preview = development.inspection.liveContext().base[0];
    expect(preview?.content).toBe(composeSystemPrompt(systemPrompt));
    expect((request.body as { messages: unknown[] }).messages[0]).toEqual(preview);
    expect(request.body).toMatchObject({
      messages: expect.arrayContaining([{ role: "user", content: 'Participant: "bob"\n\nHello' }]),
      tools: expect.any(Array),
    });
  } finally { development.close(); }
});
