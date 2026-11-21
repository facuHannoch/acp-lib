import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FunctionError, type ChannelEvent, type FunctionCall, type FunctionResult, type HarnessClient, type ProtocolConfig, type ResultRead, type ToolCatalogInput, type ToolRegistration } from "../src/client.ts";
import { createInProcessHarness } from "../src/testing.ts";
import { spawnHarness } from "./helpers/stdio.ts";

// Decision 0021 over the protocol: catalog on open, `functions/call` from the
// harness to the host, cancellation, result references, in process and over
// real `serve --stdio` children.
const root = mkdtempSync(join(tmpdir(), "harness-tools-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(res => { resolve = res; }); return { promise, resolve }; }
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 800; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${what}`);
}
let scripts = 0;
/** One script file; every channel runs its own copy from the first response. */
function script(responses: { content: string | null; calls?: { id: string; name: string; arguments: Record<string, unknown> }[] }[]) {
  const path = join(root, `script-${++scripts}.json`);
  writeFileSync(path, JSON.stringify({ version: 1, responses }));
  return path;
}
const callThen = (name: string, args: Record<string, unknown>, ...more: { content: string | null; calls?: any[] }[]) =>
  script([{ content: null, calls: [{ id: "t1", name, arguments: args }] }, ...(more.length ? more : [{ content: "done" }])]);
const config = (path: string, fallback: "allow" | "ask" = "allow"): ProtocolConfig => ({ version: 1, system: "Tools", model: { protocol: "scripted", script: path },
  defaultPolicy: "main", policies: { main: { fallback, tools: {} } } });
const tool = (name: string, group: ToolRegistration["group"] = "fixed", extra: Partial<ToolRegistration> = {}): ToolRegistration => ({ name, group, handler: `${name}_handler`,
  description: `Test tool ${name}`, parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false }, ...extra });
const push = (channel: string, id: string, text = "go") => ({ channel, item: { id, kind: "user_message" as const, sender: `user-${channel}`, content: [{ type: "text" as const, text }] } });
const hello = (functions?: string[]) => ({ protocolVersion: 1 as const, host: { name: "test", version: "0" }, callbacks: functions ? ["functions/call"] : [],
  ...(functions ? { functions } : {}), approval: true, subscription: { text: "final" as const, tools: "full" as const } });
function watch(client: HarnessClient) {
  const events: ChannelEvent[] = [];
  client.onChannelEvent(event => { events.push(event); });
  const ended = (channel: string, count = 1) => events.filter(event => event.channel === channel && event.event.type === "turn_ended").length >= count;
  const toolEvents = (channel: string) => events.flatMap(event => event.channel === channel && event.event.type === "tool_call" ? [event.event] : []);
  const output = (channel: string, status = "completed") => JSON.parse(toolEvents(channel).findLast(event => event.status === status)!.output!);
  return { events, ended, toolEvents, output };
}
type Harness = { client: HarnessClient; close(): void | Promise<void> };
const open = (transport: "in-process" | "stdio", options: Parameters<typeof spawnHarness>[0] = {}): Harness => transport === "stdio" ? spawnHarness(options) : createInProcessHarness(options);

for (const transport of ["in-process", "stdio"] as const) {
  test(`${transport}: concurrent callbacks answer the right requests; status stays responsive and shows the tool phase`, async () => {
    const harness = open(transport), { client } = harness, seen = watch(client);
    const calls: FunctionCall[] = [], gates = { a: deferred<FunctionResult>(), b: deferred<FunctionResult>() };
    client.serveFunctions(call => { calls.push(call); return gates[call.channel as "a" | "b"].promise; });
    try {
      const described = await client.initialize(hello(["lookup_handler"]));
      expect(described.description.capabilities.functions).toBe(true);
      await client.createSession({ sessionId: "s", config: config(callThen("lookup", { q: "x" })), participants: [], channels: {}, tools: { catalog: [tool("lookup")] } });
      expect((await client.tools()).tools).toEqual([{ name: "lookup", group: "fixed", handler: "lookup_handler", available: true }, { name: "read_tool_result", group: "builtin", available: true }]);
      await client.push(push("a", "a1")); await client.push(push("b", "b1"));
      await until(() => calls.length === 2, "both callbacks");
      expect(calls.map(call => [call.channel, call.tool, call.handler, call.sessionId, call.arguments])).toContainEqual(["a", "lookup", "lookup_handler", "s", { q: "x" }]);
      const ids = Object.fromEntries(calls.map(call => [call.channel, call.invocationId]));
      expect(new Set(Object.values(ids)).size).toBe(2);
      // The control connection answers while both handlers are quiet.
      const status = await client.status();
      for (const channel of status.channels) {
        expect(channel.activeTurn).toMatchObject({ state: "running", phase: { kind: "tool", id: ids[channel.channel] } });
        expect(Date.parse(channel.activeTurn!.phase!.since)).toBeLessThanOrEqual(Date.now());
      }
      expect((await client.toolInvocation(ids.a!)).invocation).toMatchObject({ state: "started", channel: "a", tool: "lookup", toolCallId: "t1" });
      // Answer in the opposite order of the requests: each result lands in its own channel.
      gates.b.resolve({ output: "for-b" });
      await until(() => seen.ended("b"), "b");
      expect(seen.ended("a")).toBe(false);
      gates.a.resolve({ output: "for-a" });
      await until(() => seen.ended("a"), "a");
      expect(seen.output("a")).toEqual({ ok: true, output: "for-a" });
      expect(seen.output("b")).toEqual({ ok: true, output: "for-b" });
      expect(seen.toolEvents("a").map(event => [event.status, event.invocationId])).toEqual([["started", ids.a], ["completed", ids.a]]);
      expect((await client.toolInvocations("1")).invocations).toHaveLength(1);
      expect(calls).toHaveLength(2);
      await expect(client.toolInvocation("99:nope")).rejects.toMatchObject({ code: "not_found" });
    } finally { await harness.close(); }
  });

  test(`${transport}: a deadline or an interrupt cancels exactly its own call; late answers are ignored; a typed error reaches the model`, async () => {
    const harness = open(transport), { client } = harness, seen = watch(client);
    const running = new Map<string, { call: FunctionCall; signal: AbortSignal; answer: ReturnType<typeof deferred<FunctionResult>> }>();
    client.serveFunctions((call, signal) => {
      if (call.channel === "e") throw new FunctionError("quota_exceeded", "No quota left");
      const answer = deferred<FunctionResult>(); running.set(call.channel, { call, signal, answer }); return answer.promise;
    });
    try {
      await client.initialize(hello(["quick_handler", "slow_handler"]));
      const path = script([{ content: null, calls: [{ id: "t1", name: "slow", arguments: { q: "x" } }] }, { content: "done" }]);
      await client.createSession({ sessionId: "s", config: config(path), participants: [], channels: {}, tools: { catalog: [tool("quick", "fixed", { deadlineMs: 60 }), tool("slow")] } });
      await client.push(push("a", "a1")); await client.push(push("b", "b1")); await client.push(push("e", "e1"));
      await until(() => running.has("a") && running.has("b"), "two untimed callbacks");
      // A typed handler error is a paired failure and that turn completes.
      await until(() => seen.ended("e"), "typed error turn");
      expect(seen.output("e", "failed")).toMatchObject({ ok: false, code: "quota_exceeded", message: "No quota left" });
      // Interrupt a's turn: only a's handler is cancelled.
      await client.interruptTurn({ channel: "a", turn: running.get("a")!.call.turnId, reason: "operator" });
      await until(() => running.get("a")!.signal.aborted, "a's cancellation");
      expect((running.get("a")!.signal.reason as Error).message).toBe("operator");
      expect(running.get("b")!.signal.aborted).toBe(false);
      expect((await client.toolInvocation(running.get("a")!.call.invocationId)).invocation).toMatchObject({ state: "interrupted", effect: "unknown" });
      // A late answer for the interrupted call starts nothing.
      running.get("a")!.answer.resolve({ output: "late" });
      running.get("b")!.answer.resolve({ output: "on time" });
      await until(() => seen.ended("b"), "b");
      expect(seen.output("b")).toEqual({ ok: true, output: "on time" });
      expect(seen.events.filter(event => event.channel === "a" && event.event.type === "turn_ended").map(event => (event.event as any).outcome)).toEqual(["interrupted"]);
      expect(seen.toolEvents("a").map(event => event.status)).toEqual(["started"]);
    } finally { await harness.close(); }

    // The deadline: a separate session whose script calls the short-deadline tool.
    const second = open(transport), late = deferred<FunctionResult>(), signals: AbortSignal[] = [], view = watch(second.client);
    second.client.serveFunctions((_call, signal) => { signals.push(signal); return late.promise; });
    try {
      await second.client.initialize(hello(["quick_handler"]));
      await second.client.createSession({ sessionId: "s", config: config(callThen("quick", { q: "x" }, { content: "after timeout" })), participants: [], channels: {},
        tools: { catalog: [tool("quick", "fixed", { deadlineMs: 60 })] } });
      await second.client.push(push("q", "q1"));
      await until(() => view.ended("q"), "timed out turn");
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
      expect((signals[0]!.reason as Error).message).toBe("tool deadline");
      expect(view.output("q", "interrupted")).toMatchObject({ ok: false, code: "tool_timeout", effect: "unknown" });
      expect(view.events.findLast(event => event.event.type === "turn_ended")!.event).toMatchObject({ outcome: "completed" });
      expect(view.events.filter(event => event.event.type === "message_completed")).toHaveLength(1);
      late.resolve({ output: "too late" });
      await new Promise(resolve => setTimeout(resolve, 60));
      expect((await second.client.toolInvocations("1")).invocations).toMatchObject([{ state: "interrupted", code: "tool_timeout" }]);
      expect(view.events.filter(event => event.event.type === "message_completed")).toHaveLength(1);
      expect(signals).toHaveLength(1);
    } finally { await second.close(); }
  });
}

test("stdio: a result larger than one frame crosses by reference; only the producing channel reads it, by ID", async () => {
  const requests = join(root, "large-requests.log");
  // Channel a: produce, read a part, then try a path. Channel b runs the same
  // script: its own call is small, and its read of a's ID is refused.
  const path = script([{ content: null, calls: [{ id: "t1", name: "lookup", arguments: { q: "big" } }] },
    { content: null, calls: [{ id: "t2", name: "read_tool_result", arguments: { result_id: "res-1", offset: 2_000_000, length: 16 } }] },
    { content: null, calls: [{ id: "t3", name: "read_tool_result", arguments: { result_id: "/etc/passwd" } }] }, { content: "done" }]);
  const harness = spawnHarness({ requests }), { client } = harness, seen = watch(client);
  const full = "abcdefghij".repeat(300_000); // 3 MB: three protocol frames
  const store = new Map<string, string>(), reads: ResultRead[] = [];
  client.serveFunctions(call => {
    if (call.channel !== "a") return { output: "small" };
    store.set("res-1", full);
    return { preview: full.slice(0, 32), reference: { resultId: "res-1", bytes: full.length, retention: "temporary", expiresAt: new Date(Date.now() + 60_000).toISOString() } };
  }, read => {
    reads.push(read);
    const text = store.get(read.resultId);
    if (text === undefined) throw new FunctionError("result_expired", "That result is gone");
    const part = text.slice(read.offset, read.offset + read.length);
    return { text: part, eof: read.offset + part.length >= text.length, totalBytes: text.length };
  });
  try {
    await client.initialize(hello(["lookup_handler"]));
    await client.createSession({ sessionId: "s", config: config(path), participants: [], channels: {}, tools: { catalog: [tool("lookup")] } });
    await client.push(push("a", "a1"));
    await until(() => seen.ended("a"), "a");
    const outputs = seen.toolEvents("a").filter(event => event.status !== "started").map(event => JSON.parse(event.output!));
    expect(outputs[0]).toMatchObject({ ok: true, preview: full.slice(0, 32), result_id: "res-1", bytes: 3_000_000 });
    expect(outputs[1]).toEqual({ ok: true, text: full.slice(2_000_000, 2_000_016), total_bytes: 3_000_000, eof: false, next_offset: 2_000_016 });
    expect(outputs[2]).toMatchObject({ ok: false, code: "result_not_found" });
    expect(reads).toEqual([{ resultId: "res-1", invocationId: "1:t1", channel: "a", offset: 2_000_000, length: 16 }]);
    expect((await client.toolInvocation("1:t1")).invocation).toMatchObject({ state: "succeeded", reference: { resultId: "res-1", bytes: 3_000_000, retention: "temporary" } });
    // The model saw the preview and the ID, never the bytes.
    const sent = readFileSync(requests, "utf8");
    expect(sent.length).toBeLessThan(200_000);
    expect(sent).toContain("res-1");
    // Another channel, which sees the ID in shared history, cannot read it.
    await client.push(push("b", "b1"));
    await until(() => seen.ended("b"), "b");
    const other = seen.toolEvents("b").filter(event => event.status !== "started").map(event => JSON.parse(event.output!));
    expect(other[0]).toEqual({ ok: true, output: "small" });
    expect(other[1]).toMatchObject({ ok: false, code: "result_forbidden" });
    expect(reads).toHaveLength(1);
    // The producer dropped the bytes: reading reports expiry; the call keeps its outcome.
    store.clear();
    await client.push(push("a", "a2"));
    await until(() => seen.ended("a", 2), "a again");
  } finally { await harness.close(); }
});

test("stdio: revoking a tool while its approval is pending skips the call; the next inference omits it; the revocation survives reopen", async () => {
  const home = mkdtempSync(join(root, "revoke-")), requests = join(home, "requests.log");
  const path = callThen("send", { q: "x" }, { content: "skipped it" }, { content: "second turn" });
  const tools: ToolCatalogInput = { catalog: [tool("send", "revocable"), tool("lookup")] };
  const offered = () => readFileSync(requests, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line).tools as string[]);
  const first = spawnHarness({ home, requests }), seen = watch(first.client);
  let handled = 0;
  first.client.serveFunctions(() => { handled++; return { output: "ran" }; });
  await first.client.initialize(hello(["send_handler", "lookup_handler"]));
  await first.client.createSession({ sessionId: "s", config: config(path, "ask"), participants: [], channels: {}, tools });
  await first.client.push(push("a", "a1"));
  await until(() => seen.events.some(event => event.event.type === "approval_requested"), "approval request");
  const request = seen.events.find(event => event.event.type === "approval_requested")!.event as Extract<ChannelEvent["event"], { type: "approval_requested" }>;
  expect(request).toMatchObject({ tool: "send", toolCallId: "t1", arguments: '{"q":"x"}' });
  expect((await first.client.status()).channels[0]!.activeTurn).toMatchObject({ phase: { kind: "approval", id: request.requestId } });
  expect((await first.client.toolInvocation("1:t1")).invocation.state).toBe("waiting_for_approval");
  expect((await first.client.revokeTool("send")).tool).toEqual({ name: "send", group: "revocable", handler: "send_handler", available: false, reason: "revoked" });
  // The old request can no longer authorize anything.
  await expect(first.client.respondApproval(request.requestId, "allow_once")).rejects.toMatchObject({ code: "not_found" });
  await until(() => seen.ended("a"), "turn");
  expect(handled).toBe(0);
  expect(seen.toolEvents("a").map(event => event.status)).toEqual(["skipped"]);
  expect(seen.output("a", "skipped")).toMatchObject({ ok: false, code: "tool_unavailable" });
  expect((await first.client.toolInvocation("1:t1")).invocation).toMatchObject({ state: "skipped", code: "tool_unavailable", effect: "none" });
  expect(offered()).toEqual([["echo", "record", "hold", "lookup", "read_tool_result", "send"], ["echo", "record", "hold", "lookup", "read_tool_result"]]);
  await expect(first.client.revokeTool("lookup")).rejects.toMatchObject({ code: "invalid_state" });
  await expect(first.client.removeTool("send")).rejects.toMatchObject({ code: "invalid_state" });
  await expect(first.client.revokeTool("nope")).rejects.toMatchObject({ code: "not_found" });
  await first.close();

  // Reopen in a new process: the grant is still revoked; a handler this
  // connection does not serve makes its tool unavailable too.
  const second = spawnHarness({ home, requests }), again = watch(second.client);
  try {
    await second.client.initialize(hello(["send_handler"]));
    await second.client.loadSession({ sessionId: "s", tools });
    expect((await second.client.tools()).tools).toEqual([
      { name: "send", group: "revocable", handler: "send_handler", available: false, reason: "revoked" },
      { name: "lookup", group: "fixed", handler: "lookup_handler", available: false, reason: "handler_missing" },
      { name: "read_tool_result", group: "builtin", available: true }]);
    expect((await second.client.toolInvocation("1:t1")).invocation).toMatchObject({ state: "skipped", code: "tool_unavailable" });
    await second.client.push(push("a", "a2"));
    await until(() => again.ended("a"), "second turn");
    expect(offered().at(-1)).toEqual(["echo", "record", "hold", "read_tool_result"]);
    // A repeated load with the same catalog is a view; a different one is refused.
    await second.client.loadSession({ sessionId: "s", tools });
    await expect(second.client.loadSession({ sessionId: "s", tools: { catalog: [tool("other")] } })).rejects.toMatchObject({ code: "invalid_state" });
    expect((await second.client.restoreTool("send")).tool.available).toBe(true);
  } finally { await second.close(); }
});

test("stdio: a callback whose outcome is lost stays uncertain after reopen and its handler never runs again", async () => {
  const home = mkdtempSync(join(root, "lost-"));
  const path = callThen("lookup", { q: "x" }, { content: "done" }, { content: "fresh" });
  const tools: ToolCatalogInput = { catalog: [tool("lookup")] };
  let handled = 0;
  const first = spawnHarness({ home });
  first.client.serveFunctions(() => { handled++; return new Promise<FunctionResult>(() => {}); });
  await first.client.initialize(hello(["lookup_handler"]));
  await first.client.createSession({ sessionId: "s", config: config(path), participants: [], channels: {}, tools });
  await first.client.push(push("a", "a1"));
  await until(() => handled === 1, "the callback");
  // The process dies after dispatch, before any answer.
  first.child.kill("SIGKILL"); await first.child.exited; first.client.close();

  const second = spawnHarness({ home }), seen = watch(second.client);
  second.client.serveFunctions(() => { handled++; return { output: "again" }; });
  try {
    await second.client.initialize(hello(["lookup_handler"]));
    const loaded = await second.client.loadSession({ sessionId: "s", tools });
    expect(loaded.status.channels[0]!.unresolved).toMatchObject({ state: "interrupted", uncertainCalls: ["t1"] });
    expect((await second.client.toolInvocation("1:t1")).invocation).toMatchObject({ state: "interrupted", effect: "unknown", tool: "lookup", arguments: '{"q":"x"}' });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(handled).toBe(1);
    expect(seen.events.filter(event => event.event.type === "tool_call")).toEqual([]);
  } finally { await second.close(); }
});

test("negotiation and catalog validation: bad input opens nothing; a server refuses callbacks it was not offered", async () => {
  const harness = createInProcessHarness(), { client } = harness;
  try {
    await expect(client.initialize({ ...hello(), callbacks: ["other/callback"] })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(client.initialize({ ...hello(), functions: ["x"] })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(client.initialize({ ...hello(["x"]), functions: ["x", "x"] })).rejects.toMatchObject({ code: "invalid_params" });
    await client.initialize(hello(["lookup_handler"]));
    const base = { sessionId: "s", config: config(callThen("lookup", { q: "x" })), participants: [], channels: {} };
    for (const catalog of [[tool("a"), tool("a")], [tool("echo")], [tool("read_tool_result")], [{ ...tool("a"), group: "odd" }]])
      await expect(client.createSession({ ...base, tools: { catalog: catalog as ToolRegistration[] } })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(client.createSession({ ...base, tools: { catalog: [tool("a")], enabled: ["a"] } })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(client.status()).rejects.toMatchObject({ code: "not_ready" });
    // Nothing was opened by the refused requests: the same ID can still be created, without a catalog.
    await client.createSession(base);
    expect((await client.tools()).tools).toEqual([]);
    await expect(client.revokeTool("lookup")).rejects.toMatchObject({ code: "not_found" });
  } finally { harness.close(); }
});

test("stdio: invalid callback arguments are paired without approval or dispatch", async () => {
  const requests = join(root, "invalid-arguments-requests.log");
  const harness = spawnHarness({ requests });
  const { client } = harness;
  const seen = watch(client);
  let handled = 0;
  client.serveFunctions(() => { handled++; return { output: "unexpected" }; });
  try {
    await client.initialize(hello(["lookup_handler"]));
    await client.createSession({ sessionId: "s", config: config(callThen("lookup", { q: 42 }), "ask"),
      participants: [], channels: {}, tools: { catalog: [tool("lookup")] } });
    await client.push(push("a", "a1"));
    await until(() => seen.ended("a"), "turn completion");
    expect(handled).toBe(0);
    expect(seen.events.some(event => event.event.type === "approval_requested")).toBe(false);
    expect(seen.toolEvents("a").map(event => event.status)).toEqual(["skipped"]);
    expect(seen.output("a", "skipped")).toMatchObject({ ok: false, code: "invalid_arguments" });
    const [, next] = readFileSync(requests, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const paired = next.messages.find((message: { role: string }) => message.role === "tool");
    expect(paired.callId).toBe("t1");
    expect(JSON.parse(paired.content)).toMatchObject({ code: "invalid_arguments" });
  } finally { await harness.close(); }
});
