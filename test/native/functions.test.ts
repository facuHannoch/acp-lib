/**
 * The public checkpoint of the tools and host callbacks spec: acp-client's conversation interface
 * driving a real scripted harness child process over stdio, with consumer functions served by this
 * process. Deterministic barriers: a handler waits on a promise the test controls; an `ask` policy
 * keeps a call waiting for approval; `HARNESS_TEST_FAULT=<storage point>:<n>` kills the harness right
 * after that commit. Every channel runs its own copy of the script, so handlers decide by channel.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../../src/agent.ts";
import type { AgentSession } from "../../src/agent-session.ts";
import { type NativeFunction, type NativeFunctionContext, type NativeFunctionsConfig } from "../../src/native/functions.ts";
import { NativeTurnError } from "../../src/native/controller.ts";
import { createInProcessHarness } from "../../src/native-harness/src/testing.ts";
import type { PermissionOutcome, PermissionRequest } from "../../src/types.ts";
import { nativeRig, reply, until, type NativeRig, type Step } from "./support.ts";

const rigs: NativeRig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.clean(); });
async function rigWith(...args: Parameters<typeof nativeRig>) {
  const rig = await nativeRig(...args);
  rigs.push(rig);
  rig.env.HARNESS_TEST_REQUESTS = join(rig.directory, "requests.log");
  return rig;
}
const two = async (agent: Agent) => [await agent.conversations.create({ title: "Alice" }), await agent.conversations.create({ title: "Bob" })] as unknown as [AgentSession, AgentSession];
const call = (name: string, args: Record<string, unknown>, id = "t1"): Step => ({ content: null, calls: [{ id, name, arguments: args }] });
const track = <T>(promise: Promise<T>) => {
  const state: { settled: boolean; value?: T; error?: any } = { settled: false };
  promise.then((value) => { state.settled = true; state.value = value; }, (error) => { state.settled = true; state.error = error; });
  return state;
};
function gate<T = unknown>() { let open!: (value: T) => void; const promise = new Promise<T>((resolve) => { open = resolve; }); return { promise, open }; }
const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false };
const fn = (handler: NativeFunction["handler"], extra: Partial<NativeFunction> = {}): NativeFunction => ({ description: "A host function", parameters: schema, handler, ...extra });
/** Every inference request the harness made: the channel, the tools offered and the messages sent. */
function requests(rig: NativeRig): Array<{ channel: string; tools: string[]; messages: Array<{ role: string; content: string; callId?: string }> }> {
  const path = rig.env.HARNESS_TEST_REQUESTS!;
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}
const toolResults = (rig: NativeRig, channel: string) => {
  const last = requests(rig).filter((request) => request.channel === channel).at(-1);
  return (last?.messages ?? []).filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
};
const open = (rig: NativeRig, functions: NativeFunctionsConfig, overrides: Record<string, unknown> = {}) => {
  rig.harness.functions = functions;
  return rig.open(overrides as never);
};
const allow = (request: PermissionRequest): PermissionOutcome => ({ outcome: "selected", optionId: request.options.find((option) => option.kind === "allow_once")!.optionId });

describe("tools and host callbacks: the public checkpoint", () => {
  test("1: an approved host function runs once while its handler is held; Bob finishes; status shows Alice's tool; silence does not cancel it; the result reaches the next inference", async () => {
    const rig = await rigWith({ defaultPolicy: "ask", policies: { ask: { fallback: "allow", tools: { lookup: "ask" } } } });
    rig.script([call("lookup", { q: "weather" }), reply("Done."), reply("Later.")]);
    const barrier = gate<unknown>(), contexts: NativeFunctionContext[] = [], args: unknown[] = [];
    let alice!: AgentSession, bob!: AgentSession;
    const agent = await open(rig, { tools: { lookup: fn((input, context) => {
      contexts.push(context); args.push(input);
      return context.channel === alice.id ? barrier.promise : { temperature: 5 };
    }) } }, {
      // The host's ordinary output-silence limits, far shorter than the handler's wait below.
      operationLifecycle: { turns: { firstOutputMs: 150, nextOutputMs: 150, toolMs: 150 } },
    });
    [alice, bob] = await two(agent);
    const host = agent.nativeHarness!;
    expect(alice.conversationCapabilities).toMatchObject({ supervision: "backend" });

    const asked: PermissionRequest[] = [];
    const a1 = track(alice.prompt("a1", { onPermissionRequest: (request) => { asked.push(request); return allow(request); } }));
    await until(() => contexts.some((context) => context.channel === alice.id), "Alice's handler to be called");
    // The approval was for this exact call.
    expect(asked).toHaveLength(1);
    expect(JSON.stringify(asked[0])).toContain("lookup");
    expect(args[0]).toEqual({ q: "weather" });
    const aliceCall = contexts.find((context) => context.channel === alice.id)!;
    expect(aliceCall.policyNames).toEqual(["ask"]);

    // Bob's whole turn runs while Alice's handler is held.
    const b1 = await bob.prompt("b1", { onPermissionRequest: allow });
    expect(b1.text).toBe("Done.");
    expect(a1.settled).toBe(false);

    // Status answers while the handler is quiet, and names the invocation and when the phase began.
    const status = await host.status();
    const phase = status.channels.find((channel) => channel.channel === alice.id)!.activeTurn!.phase!;
    expect(phase).toMatchObject({ kind: "tool", id: aliceCall.invocationId });
    expect(await host.toolInvocation(aliceCall.invocationId)).toMatchObject({ state: "started", tool: "lookup", channel: alice.id });

    // Well past the silence limits: the turn is still running and was not cancelled.
    await Bun.sleep(600);
    expect(a1.settled).toBe(false);
    expect(aliceCall.signal.aborted).toBe(false);
    expect(Date.now() - Date.parse(phase.since)).toBeGreaterThan(500);
    expect((await host.status()).channels.find((channel) => channel.channel === alice.id)!.activeTurn!.phase).toEqual(phase);

    barrier.open({ temperature: 21 });
    await until(() => a1.settled, "Alice's turn");
    expect(a1.error).toBeUndefined();
    expect(a1.value!.text).toBe("Done.");
    // One invocation per channel, and the committed result is what the next inference received.
    expect(contexts.filter((context) => context.channel === alice.id)).toHaveLength(1);
    expect(toolResults(rig, alice.id)).toEqual([{ ok: true, output: { temperature: 21 } }]);
    expect(await host.toolInvocation(aliceCall.invocationId)).toMatchObject({ state: "succeeded" });
    expect(await host.toolInvocations(aliceCall.turnId)).toHaveLength(1);
  }, 60_000);

  test("2: revoking a tool while its approval is pending skips the call; the old request authorizes nothing; the next inference omits the tool; the revocation survives a reopen", async () => {
    const rig = await rigWith({ defaultPolicy: "ask", policies: { ask: { fallback: "ask", tools: {} } } });
    rig.script([call("send", { q: "x" }), reply("Skipped."), reply("Second.")]);
    let ran = 0;
    const functions: NativeFunctionsConfig = { tools: {
      send: fn(() => { ran++; return "sent"; }, { group: "revocable" }),
      extra: fn(() => "extra", { group: "runtime" }),
      keep: fn(() => "kept"),
    } };
    const agent = await open(rig, functions);
    const host = agent.nativeHarness!;
    const alice = await agent.conversations.create({ title: "Alice" }) as unknown as AgentSession;
    const pending = gate<PermissionOutcome>(), asked: PermissionRequest[] = [];
    const a1 = track(alice.prompt("a1", { onPermissionRequest: (request) => { asked.push(request); return pending.promise; } }));
    await until(() => asked.length === 1, "the approval request");
    expect(Object.fromEntries((await host.tools()).map((tool) => [tool.name, tool.available ? "available" : tool.reason]))).toEqual(
      { send: "available", extra: "not_enabled", keep: "available", read_tool_result: "available" });
    expect(await host.revokeTool("send")).toMatchObject({ name: "send", available: false, reason: "revoked" });
    await until(() => a1.settled, "the turn");
    expect(a1.value!.text).toBe("Skipped.");
    // The consumer answers the old request late: nothing runs.
    pending.open(allow(asked[0]!));
    await Bun.sleep(100);
    expect(ran).toBe(0);
    const [offered, next] = requests(rig).map((request) => request.tools);
    expect(offered).toContain("send");
    expect(next).not.toContain("send");
    expect(next).toContain("keep");
    expect(toolResults(rig, alice.id)).toMatchObject([{ ok: false, code: "tool_unavailable" }]);
    const turn = (await host.status()).channels[0]!;
    expect(turn.activeTurn).toBeUndefined();
    expect(await host.toolInvocations("1")).toMatchObject([{ state: "skipped", code: "tool_unavailable", effect: "none", tool: "send" }]);
    // Fixed registrations cannot be removed or revoked; runtime ones are enabled and removed by name.
    await expect(host.revokeTool("keep")).rejects.toMatchObject({ code: "invalid_state" });
    await expect(host.removeTool("keep")).rejects.toMatchObject({ code: "invalid_state" });
    expect(await host.enableTool("extra")).toMatchObject({ available: true });
    await agent.close();

    // A new acp-client and a new harness process: the revocation is stored with the session.
    const again = await open(rig, functions);
    await again.nativeHarness!.ensureStarted();
    const tools = Object.fromEntries((await again.nativeHarness!.tools()).map((tool) => [tool.name, tool.available ? "available" : tool.reason]));
    // The runtime selection lived in the first process's memory; this one supplies its own (none).
    expect(tools).toEqual({ send: "revoked", extra: "not_enabled", keep: "available", read_tool_result: "available" });
    expect(await again.nativeHarness!.restoreTool("send")).toMatchObject({ available: true });
  }, 60_000);

  test("3: a result larger than a stdio frame is stored by the host and crosses by reference; only the producing conversation can read it; a path and an expired ID are refused", async () => {
    const rig = await rigWith();
    const resultId = "00000000-0000-4000-8000-000000000001";
    rig.script([call("lookup", { q: "big" }, "t1"), call("read_tool_result", { result_id: resultId, offset: 2_000_000, length: 20 }, "t2"),
      call("read_tool_result", { result_id: "/etc/passwd" }, "t3"), reply("Read."), call("read_tool_result", { result_id: resultId }, "t4"), reply("Expired.")]);
    const full = "0123456789".repeat(300_000); // 3 MB of text: more than one 1 MB frame
    let alice!: AgentSession;
    const results = join(rig.directory, "host-results");
    const agent = await open(rig, { resultDirectory: results, resultTtlMs: 4000, newResultId: () => resultId,
      tools: { lookup: fn((_input, context) => context.channel === alice.id ? full : "small") } });
    const bob = await (async () => { const pair = await two(agent); alice = pair[0]; return pair[1]; })();
    const host = agent.nativeHarness!;

    expect((await alice.prompt("a1")).text).toBe("Read.");
    // The bytes are in the host's own directory; the harness home holds no copy of them.
    expect(readdirSync(results)).toEqual([resultId]);
    const serialized = JSON.stringify(full);
    const [produced, part, path] = toolResults(rig, alice.id);
    expect(produced).toMatchObject({ ok: true, result_id: resultId, bytes: serialized.length, preview: serialized.slice(0, 512) });
    expect(part).toEqual({ ok: true, text: serialized.slice(2_000_000, 2_000_020), total_bytes: serialized.length, eof: false, next_offset: 2_000_020 });
    expect(path).toMatchObject({ ok: false, code: "result_not_found" });
    expect(await host.toolInvocation("1:t1")).toMatchObject({ state: "succeeded", reference: { resultId, bytes: serialized.length, retention: "temporary" } });
    // No inference request ever carried the bytes.
    expect(readFileSync(rig.env.HARNESS_TEST_REQUESTS!, "utf8").length).toBeLessThan(100_000);

    // Bob runs the same script: his own call is small, and Alice's ID is refused for him.
    expect((await bob.prompt("b1")).text).toBe("Read.");
    expect(toolResults(rig, bob.id).slice(0, 2)).toMatchObject([{ ok: true, output: "small" }, { ok: false, code: "result_forbidden" }]);

    // After its lifetime the result is reported expired; the original call keeps its outcome.
    await Bun.sleep(4100);
    expect((await alice.prompt("a2")).text).toBe("Expired.");
    expect(toolResults(rig, alice.id).at(-1)).toMatchObject({ ok: false, code: "result_expired" });
    expect(await host.toolInvocation("1:t1")).toMatchObject({ state: "succeeded" });
  }, 60_000);

  test("4a: a callback whose outcome is lost stays uncertain after reopen, and its handler never runs again", async () => {
    const rig = await rigWith();
    rig.script([call("lookup", { q: "x" }), reply("Done."), reply("Fresh.")]);
    let ran = 0;
    const signals: AbortSignal[] = [];
    const functions: NativeFunctionsConfig = { tools: { lookup: fn((_input, context) => { ran++; signals.push(context.signal); return new Promise(() => {}); }) } };
    const agent = await open(rig, functions);
    const host = agent.nativeHarness!;
    const alice = await agent.conversations.create({ title: "Alice" }) as unknown as AgentSession;
    const a1 = track(alice.prompt("a1"));
    await until(() => ran === 1, "the handler");
    // The harness goes away with the call dispatched and unanswered.
    await host.stop();
    await until(() => a1.settled, "the turn to fail");
    expect(a1.error).toBeDefined();
    expect(signals[0]!.aborted).toBe(true);

    await host.restart();
    await host.ensureStarted();
    expect(await host.toolInvocation("1:t1")).toMatchObject({ state: "interrupted", effect: "unknown", tool: "lookup" });
    const channel = (await host.status()).channels.find((value) => value.channel === alice.id)!;
    expect(channel.unresolved).toMatchObject({ uncertainCalls: ["t1"] });
    await Bun.sleep(150);
    expect(ran).toBe(1);
  }, 60_000);

  test("4b: a crash between dispatch evidence and the callback is reported uncertain too, and the handler is not called on recovery", async () => {
    const rig = await rigWith();
    rig.script([call("lookup", { q: "x" }), reply("Done.")]);
    let ran = 0;
    // The harness process exits right after it commits the dispatch evidence, before sending the call.
    rig.env.HARNESS_TEST_FAULT = "markToolDispatched:1";
    const agent = await open(rig, { tools: { lookup: fn(() => { ran++; return "ran"; }) } });
    const host = agent.nativeHarness!;
    const alice = await agent.conversations.create({ title: "Alice" }) as unknown as AgentSession;
    const a1 = track(alice.prompt("a1"));
    await until(() => rig.launches.length === 1, "the first launch");
    delete rig.env.HARNESS_TEST_FAULT;
    await until(() => a1.settled, "the turn to settle after the crash", 30_000);
    expect(a1.error.cause).toBeInstanceOf(NativeTurnError);
    expect(a1.error.cause).toMatchObject({ outcome: "interrupted", uncertainCalls: ["t1"] });
    expect(await host.toolInvocation("1:t1")).toMatchObject({ state: "interrupted", effect: "unknown" });
    expect(ran).toBe(0);
  }, 60_000);

  test("4c: a stalled callback times out while its turn stays live: one paired timeout result reaches the next inference, and a late reply changes nothing", async () => {
    const rig = await rigWith();
    rig.script([call("lookup", { q: "x" }), reply("After the timeout."), reply("Next.")]);
    const late = gate<unknown>(), signals: AbortSignal[] = [];
    const agent = await open(rig, { tools: { lookup: fn((_input, context) => { signals.push(context.signal); return late.promise; }, { deadlineMs: 200 }) } });
    const host = agent.nativeHarness!;
    const alice = await agent.conversations.create({ title: "Alice" }) as unknown as AgentSession;
    expect((await alice.prompt("a1")).text).toBe("After the timeout.");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(toolResults(rig, alice.id)).toMatchObject([{ ok: false, code: "tool_timeout", effect: "unknown" }]);
    const before = requests(rig).length;
    late.open("too late");
    await Bun.sleep(200);
    expect(requests(rig)).toHaveLength(before);
    expect(await host.toolInvocations("1")).toMatchObject([{ state: "interrupted", code: "tool_timeout", effect: "unknown" }]);
    expect(signals).toHaveLength(1);
    // A typed failure from a handler is a paired result as well, and the conversation keeps working.
    expect((await alice.prompt("a2")).text).toBe("Next.");
  }, 60_000);

  test("4d: interrupting a whole turn cancels its handler; a late reply starts no further work for it", async () => {
    const rig = await rigWith();
    rig.script([call("lookup", { q: "x" }), reply("Never."), reply("Fresh.")]);
    const late = gate<unknown>(), signals: AbortSignal[] = [];
    const agent = await open(rig, { tools: { lookup: fn((_input, context) => { signals.push(context.signal); return late.promise; }) } });
    const host = agent.nativeHarness!;
    const alice = await agent.conversations.create({ title: "Alice" }) as unknown as AgentSession;
    const a1 = track(alice.prompt("a1"));
    await until(() => signals.length === 1, "the handler");
    await alice.connection.forceStop();
    await until(() => a1.settled && signals[0]!.aborted, "the interruption");
    const before = requests(rig).length;
    late.open("late");
    await Bun.sleep(200);
    expect(requests(rig)).toHaveLength(before);
    expect(await host.toolInvocation("1:t1")).toMatchObject({ state: "interrupted", effect: "unknown" });
    expect(signals).toHaveLength(1);
    // The conversation takes fresh input afterwards.
    expect((await alice.prompt("a2")).text).toBe("Never.");
  }, 60_000);
});

test("an in-process callback exposes the same native handler policy context", async () => {
  const rig = await rigWith();
  rig.script([call("lookup", { q: "weather" }), reply("Done.")]);
  rig.harness.connect = async () => {
    const harness = createInProcessHarness({ home: rig.home });
    let close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    return { client: harness.client, closed, async kill() { harness.close(); close(); } };
  };
  const contexts: NativeFunctionContext[] = [];
  const agent = await open(rig, { tools: { lookup: fn((_args, context) => { contexts.push(context); return true; }) } });
  const conversation = await agent.conversations.create({ title: "Policy context" }) as unknown as AgentSession;
  expect((await conversation.prompt("look up weather")).text).toBe("Done.");
  expect(contexts.map(context => context.policyNames)).toEqual([["open"]]);
});

test.each(["reject", "cancel"] as const)("an unanswered native approval with %s never calls the tool", async (unanswered) => {
  const rig = await rigWith({ defaultPolicy: "ask", policies: { ask: { fallback: "deny", tools: { lookup: "ask" } } } });
  rig.script([call("lookup", { q: "weather" }), reply("Carried on.")]);
  let calls = 0;
  const agent = await open(rig, { tools: { lookup: fn(() => { calls++; return "should not run"; }) } },
    { permissions: { default: "ask", unanswered } });
  const conversation = await agent.conversations.create();
  const events = rig.watch(conversation);
  const result = await conversation.prompt("Look up the weather.");
  expect(calls).toBe(0);
  expect(events.filter(event => event.kind === "permission_resolved")).toMatchObject([
    { by: "default", outcome: unanswered === "cancel" ? "cancelled" : "denied" },
  ]);
  expect(result.status).toBe(unanswered === "cancel" ? "cancelled" : "completed");
  expect(result.text).toBe(unanswered === "cancel" ? "" : "Carried on.");
  expect(requests(rig)).toHaveLength(unanswered === "cancel" ? 1 : 2);
}, 30_000);

test("native system text is replaced on reopening the saved session", async () => {
  const rig = await rigWith();
  const first = await rig.open();
  const conversation = await first.conversations.create();
  expect((await conversation.prompt("first")).status).toBe("completed");
  await first.close();

  rig.harness.config = {
    version: 1, system: "Replacement system instructions",
    model: { protocol: "scripted", script: join(rig.directory, "script.jsonl") },
    defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } },
  };
  const reopened = await rig.open();
  const restored = await reopened.conversations.open(conversation.id);
  expect((await restored.conversation.prompt("second")).status).toBe("completed");
  const systemTexts = requests(rig).map(request => request.messages.filter(message => message.role === "system").map(message => message.content));
  expect(systemTexts.map(texts => texts.length)).toEqual([1, 1]);
  const initial = "Native integration test";
  const before = systemTexts[0]![0]!;
  expect(before.startsWith(initial + "\n")).toBe(true);
  const harnessInstructions = before.slice(initial.length);
  expect(systemTexts[1]![0]).toBe("Replacement system instructions" + harnessInstructions);
}, 30_000);
