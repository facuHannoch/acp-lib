import { expect, test } from "bun:test";
import { createSession } from "../src/index.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { CatalogError, parseCatalog, sameCatalog } from "../src/capabilities/tools/runtime/catalog.ts";
import { CallbackFailure, CallbackLost } from "../src/capabilities/tools/runtime/functions.ts";
import { bindModelAttempt } from "../src/capabilities/model/attempt.ts";
import { schemaProblem } from "../src/util/schema.ts";
import type { ManagedConfig } from "../src/contracts/config-permissions.ts";
import type { ChannelEvent } from "../src/contracts/events.ts";
import type { Message, Model, ToolDefinition } from "../src/contracts/loop.ts";
import type { FunctionCall, FunctionResult, ResultRead, ToolCatalogInput, ToolRegistration } from "../src/contracts/tools.ts";
import { lastInput } from "./helpers/session.ts";

// Decision 0021 at the session: the catalog, the offered list, the dispatch
// gate and invocation records, with a controllable executor in place of the
// callback transport.
function deferred<T = void>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
async function until(check: () => boolean, label: string) { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error(`Timed out: ${label}`); }
const tool = (name: string, group: ToolRegistration["group"], extra: Partial<ToolRegistration> = {}): ToolRegistration => ({ name, group, handler: `${name}_handler`,
  description: `Test tool ${name}`, parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false }, ...extra });
const builtin: ToolDefinition = { name: "echo", description: "Built-in echo", parameters: { type: "object" } };

/** The scripted model calls the tool named by the newest input (`call <tool> <json>`),
 * and answers `done` after a tool result or for any other input. */
function rig(options: { catalog?: ToolCatalogInput; policies?: ManagedConfig["policies"]; defaultPolicy?: string; beforeDispatch?: () => Promise<void>; limits?: { inlineBytes?: number } } = {}) {
  const config: ManagedConfig = { version: 1, system: "test", model: { protocol: "scripted", script: "fixture" }, defaultPolicy: options.defaultPolicy ?? "open",
    policies: options.policies ?? { open: { fallback: "allow", tools: {} } } };
  const catalog = options.catalog ?? { catalog: [tool("lookup", "fixed"), tool("send", "revocable"), tool("extra", "runtime")] };
  const adapter = createMemoryStorageAdapter();
  let created = false;
  const open = () => {
    const opened = adapter.open({ mode: created ? "open" : "create", identity: { sessionId: "s", compatibilityKey: "k" }, config });
    if (!opened.ok) throw new Error(opened.error.message);
    created = true;
    const storage = opened.value, events: ChannelEvent[] = [];
    /** Every inference request: the tools offered and the messages sent. */
    const requests: { channel: string; tools: string[]; messages: Message[] }[] = [];
    /** Callbacks the executor received, each waiting for the test to answer. */
    const calls: { request: FunctionCall; signal: AbortSignal; answer: ReturnType<typeof deferred<FunctionResult>> }[] = [];
    const reads: ResultRead[] = [];
    const stored = new Map<string, string>();
    const session = createSession({ systemPrompt: "test", storage, config, catalog, beforeToolDispatch: options.beforeDispatch, toolLimits: options.limits,
      configureTurn(turn) {
        let n = 0;
        const model: Model = async (messages, tools) => {
          requests.push({ channel: turn.channelId, tools: tools.map(value => value.name), messages: [...messages] });
          const last = messages.at(-1)!, text = lastInput(messages);
          if (last.role === "tool" && !text.startsWith("then ")) return { role: "assistant", content: "done", calls: [] };
          const match = /^(?:then )?call (\S+) (.*)$/.exec(text);
          // "then call X": a second call after the first result, to show what the next inference sees.
          if (last.role === "tool" && messages.filter(message => message.role === "tool").length > 1) return { role: "assistant", content: "done", calls: [] };
          if (!match) return { role: "assistant", content: `said ${text}`, calls: [] };
          return { role: "assistant", content: null, calls: [{ id: `c${turn.turnId}-${++n}`, name: match[1]!, arguments: match[2]! }] };
        };
        return { tools: [builtin], model, executeTool: async () => JSON.stringify({ echoed: true }) };
      } });
    session.subscribe(event => events.push(event));
    session.approvals.setConsumer(true);
    const executor = {
      call(request: FunctionCall, signal: AbortSignal) { const answer = deferred<FunctionResult>(); calls.push({ request, signal, answer }); return answer.promise; },
      async read(request: ResultRead) {
        reads.push(request);
        const text = stored.get(request.resultId);
        if (text === undefined) throw new CallbackFailure("result_expired", "gone");
        const part = text.slice(request.offset, request.offset + request.length);
        return { text: part, eof: request.offset + part.length >= text.length, totalBytes: text.length };
      },
    };
    session.tools!.serve(catalog.catalog.map(entry => entry.handler), executor);
    session.start();
    const send = (channel: string, text: string, policy?: string) => session.agent.send({ channelId: channel, participantId: "u", text, ...(policy ? { policy } : {}) });
    const ended = (channel: string, count = 1) => events.filter(e => e.channel === channel && e.event.type === "turn_ended").length >= count;
    const results = () => session.snapshot().timeline.flatMap(e => e.message.role === "tool" ? [{ ...JSON.parse(e.message.content), outcome: e.message.outcome }] : []);
    const toolEvents = () => events.flatMap(e => e.event.type === "tool_call" ? [`${e.event.status}:${e.event.invocationId}`] : []);
    return { session, storage, events, requests, calls, reads, stored, executor, send, ended, results, toolEvents,
      approval: () => events.findLast(e => e.event.type === "approval_requested")?.event as Extract<ChannelEvent["event"], { type: "approval_requested" }> | undefined,
      close() { session.stop("test"); storage.close(); } };
  };
  return { open, adapter };
}

test("catalog validation rejects the whole input: duplicates, built-in conflicts, bad groups, deadlines and enabled names", () => {
  const good = { catalog: [tool("a", "fixed"), tool("b", "runtime", { deadlineMs: 50 })], enabled: ["b"], defaultDeadlineMs: 1000 };
  expect(parseCatalog(good, ["echo"])).toEqual(good);
  const bad: unknown[] = [
    { catalog: [tool("a", "fixed"), tool("a", "runtime")] },
    { catalog: [tool("echo", "fixed")] },
    { catalog: [tool("read_tool_result", "fixed")] },
    { catalog: [{ ...tool("a", "fixed"), group: "sometimes" }] },
    { catalog: [{ ...tool("a", "fixed"), handler: " " }] },
    { catalog: [{ ...tool("a", "fixed"), parameters: [] }] },
    { catalog: [{ ...tool("a", "fixed"), extra: 1 }] },
    { catalog: [tool("a", "fixed", { deadlineMs: 0 })] },
    { catalog: [tool("a", "fixed")], enabled: ["a"] },
    { catalog: [tool("a", "runtime")], enabled: ["a", "a"] },
    { catalog: [tool("a", "fixed")], defaultDeadlineMs: -1 },
    { catalog: "a" }, [], { catalog: [], other: true },
  ];
  for (const input of bad) expect(() => parseCatalog(input, ["echo"])).toThrow(CatalogError);
  expect(sameCatalog(good, structuredClone(good))).toBe(true);
  expect(sameCatalog(good, { ...good, enabled: [] })).toBe(false);
  expect(sameCatalog(good, { ...good, catalog: [good.catalog[0]!, { ...good.catalog[1]!, description: "changed" }] })).toBe(false);
});

test("argument schemas: required fields, types, unknown fields, enums, nested items and bounds", () => {
  const schema = { type: "object", required: ["q"], additionalProperties: false, properties: { q: { type: "string", minLength: 2 },
    n: { type: "integer", minimum: 1, maximum: 5 }, mode: { enum: ["a", "b"] }, tags: { type: "array", items: { type: "string" } } } };
  expect(schemaProblem(schema, { q: "ok", n: 3, mode: "a", tags: ["x"] })).toBeUndefined();
  expect(schemaProblem(schema, {})).toBe("arguments.q is required");
  expect(schemaProblem(schema, { q: 1 })).toBe("arguments.q must be string");
  expect(schemaProblem(schema, { q: "ok", extra: 1 })).toBe("arguments.extra is not an accepted field");
  expect(schemaProblem(schema, { q: "ok", n: 9 })).toBe("arguments.n must be at most 5");
  expect(schemaProblem(schema, { q: "ok", n: 1.5 })).toBe("arguments.n must be integer");
  expect(schemaProblem(schema, { q: "ok", mode: "c" })).toContain("must be one of");
  expect(schemaProblem(schema, { q: "ok", tags: ["x", 2] })).toBe("arguments.tags[1] must be string");
  expect(schemaProblem(schema, { q: "o" })).toContain("at least 2 characters");
  expect(schemaProblem({ unknownKeyword: true }, { anything: 1 })).toBeUndefined();
});

test("fixed entries cannot be removed or revoked; revocations are durable; runtime entries are enabled and removed in memory", async () => {
  const r = rig({ catalog: { catalog: [tool("lookup", "fixed"), tool("send", "revocable"), tool("extra", "runtime"), tool("spare", "runtime")], enabled: ["extra"] } });
  const first = r.open(), tools = first.session.tools!;
  const names = (session: typeof first.session) => Object.fromEntries(session.tools!.list().map(entry => [entry.name, entry.available ? "available" : entry.reason]));
  expect(names(first.session)).toEqual({ lookup: "available", send: "available", extra: "available", spare: "not_enabled", read_tool_result: "available" });
  for (const act of [tools.revoke, tools.restore, tools.enable, tools.remove]) expect(act("lookup")).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  expect(tools.revoke("nope")).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(tools.enable("send")).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  expect(tools.revoke("extra")).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  expect(names(first.session)).toMatchObject({ lookup: "available" });

  expect(tools.revoke("send")).toMatchObject({ ok: true, value: { name: "send", group: "revocable", available: false, reason: "revoked" } });
  expect(tools.remove("extra")).toMatchObject({ ok: true, value: { available: false, reason: "not_enabled" } });
  expect(tools.enable("spare")).toMatchObject({ ok: true, value: { available: true } });
  expect(first.session.snapshot().revokedTools).toEqual(["send"]);
  first.close();

  // Reopen: the revocation is stored with the session; the runtime selection is supplied again by the consumer.
  const second = r.open();
  expect(names(second.session)).toEqual({ lookup: "available", send: "revoked", extra: "available", spare: "not_enabled", read_tool_result: "available" });
  expect(second.session.tools!.restore("send")).toMatchObject({ ok: true, value: { available: true } });
  expect(second.session.snapshot().revokedTools).toEqual([]);
  // A handler the connection does not serve makes its tool unavailable, whatever its group.
  second.session.tools!.serve(["send_handler"], second.executor);
  expect(names(second.session)).toMatchObject({ lookup: "handler_missing", send: "available", extra: "handler_missing" });
  second.close();
});

test("each inference offers built-ins, then fixed entries, then changeable ones, omitting denied and unavailable tools; changes apply to the next inference", async () => {
  const r = rig({ catalog: { catalog: [tool("zeta", "fixed"), tool("alpha", "fixed"), tool("send", "revocable"), tool("extra", "runtime"), tool("banned", "fixed")], enabled: ["extra"] },
    policies: { open: { fallback: "allow", tools: { banned: "deny" } }, strict: { fallback: "deny", tools: { alpha: "allow" } } } });
  const s = r.open();
  try {
    s.send("a", "hello"); await until(() => s.ended("a"), "first turn");
    expect(s.requests[0]!.tools).toEqual(["echo", "notify_channel", "schedule_reminder", "list_reminders", "cancel_reminder", "alpha", "zeta", "read_tool_result", "extra", "send"]);
    s.session.tools!.revoke("send"); s.session.tools!.remove("extra");
    s.send("a", "again"); await until(() => s.ended("a", 2), "second turn");
    expect(s.requests[1]!.tools).toEqual(["echo", "notify_channel", "schedule_reminder", "list_reminders", "cancel_reminder", "alpha", "zeta", "read_tool_result"]);
    // A turn whose input carries a stricter policy sees only what that policy does not deny.
    s.send("b", "hello", "strict"); await until(() => s.ended("b"), "strict turn");
    expect(s.requests[2]!.tools).toEqual(["alpha"]);
  } finally { s.close(); }
});

test("a retry of one model call offers the list frozen for that call, even if a tool was revoked in between", async () => {
  const catalog = { catalog: [tool("send", "revocable")] };
  const config: ManagedConfig = { version: 1, system: "test", model: { protocol: "scripted", script: "fixture" }, defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } } };
  const opened = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "s", compatibilityKey: "k" }, config });
  if (!opened.ok) throw new Error(opened.error.message);
  const offered: string[][] = [], events: ChannelEvent[] = [];
  let attempts = 0, revoke = () => {};
  const model: Model = async () => ({ role: "assistant", content: "unused", calls: [] });
  bindModelAttempt(model, { scripted: false, settings: { retryDelayMs: 5 }, create: () => async function* (request) {
    offered.push(request.tools.map(value => value.name));
    if (++attempts === 1) { revoke(); yield { type: "failure", kind: "transient", message: "try again" }; return; }
    yield { type: "response", response: { role: "assistant", content: "ok", calls: [], stopReason: "complete" } };
  } });
  const session = createSession({ systemPrompt: "test", storage: opened.value, config, catalog, configureTurn: () => ({ tools: [], model, executeTool: async () => "" }) });
  session.subscribe(event => events.push(event));
  session.tools!.serve(["send_handler"]);
  revoke = () => { session.tools!.revoke("send"); };
  session.start();
  try {
    session.agent.send({ channelId: "a", participantId: "u", text: "one" });
    await until(() => events.some(e => e.event.type === "turn_ended"), "turn");
    expect(offered).toEqual([["notify_channel", "schedule_reminder", "list_reminders", "cancel_reminder", "read_tool_result", "send"], ["notify_channel", "schedule_reminder", "list_reminders", "cancel_reminder", "read_tool_result", "send"]]);
    session.agent.send({ channelId: "a", participantId: "u", text: "two" });
    await until(() => events.filter(e => e.event.type === "turn_ended").length === 2, "second turn");
    expect(offered[2]).toEqual(["notify_channel", "schedule_reminder", "list_reminders", "cancel_reminder", "read_tool_result"]);
  } finally { session.stop("test"); opened.value.close(); }
});

test("a consumer call runs once through the gate: validated arguments, invocation identity, a committed result that reaches the next inference", async () => {
  const r = rig(); const s = r.open();
  try {
    s.send("a", 'call lookup {"q":"weather"}');
    await until(() => s.calls.length === 1, "the callback");
    const { request } = s.calls[0]!;
    expect(request).toEqual({ invocationId: "1:c1-1", sessionId: "s", channel: "a", turnId: "1", tool: "lookup", handler: "lookup_handler", policyNames: ["open"], arguments: { q: "weather" } });
    expect(s.session.tools!.invocation("1:c1-1")).toMatchObject({ state: "started", tool: "lookup", toolCallId: "c1-1", channel: "a", arguments: '{"q":"weather"}' });
    // The status shows what the turn is doing and which call it concerns.
    expect(s.session.status().channels[0]!.activeTurn).toMatchObject({ turnId: 1, status: "running", phase: { kind: "tool", id: "1:c1-1" } });
    // Another channel completes while this callback is outstanding.
    s.send("b", "hello"); await until(() => s.ended("b"), "bob");
    expect(s.ended("a")).toBe(false);
    s.calls[0]!.answer.resolve({ output: { temperature: 21 } });
    await until(() => s.ended("a"), "alice");
    expect(s.calls).toHaveLength(1);
    expect(s.results()).toEqual([{ ok: true, output: { temperature: 21 }, outcome: { status: "succeeded" } }]);
    expect(s.session.tools!.invocation("1:c1-1")).toMatchObject({ state: "succeeded" });
    expect(s.session.tools!.invocations(1).map(record => record.invocationId)).toEqual(["1:c1-1"]);
    expect(s.toolEvents()).toEqual(["started:1:c1-1", "completed:1:c1-1"]);
    const next = s.requests.filter(request => request.channel === "a")[1]!.messages.at(-1)!;
    expect(next).toMatchObject({ role: "tool", callId: "c1-1" });
    expect(JSON.parse((next as { content: string }).content)).toEqual({ ok: true, output: { temperature: 21 } });
    expect(s.session.status().channels.find(channel => channel.channelId === "a")!.activeTurn).toBeUndefined();
    expect(s.session.tools!.invocation("9:nope")).toBeUndefined();
    expect(s.session.tools!.invocation("not-an-id")).toBeUndefined();
  } finally { s.close(); }
});

test("invalid arguments, an unoffered tool and an unavailable tool are skipped with a reason and no callback; a built-in keeps its own path", async () => {
  const r = rig({ catalog: { catalog: [tool("lookup", "fixed"), tool("extra", "runtime")] } }); const s = r.open();
  try {
    s.send("a", 'call lookup {"q":1}'); await until(() => s.ended("a"), "invalid arguments");
    s.send("a", 'call lookup {"q":"ok","other":true}'); await until(() => s.ended("a", 2), "unknown field");
    s.send("a", 'call extra {"q":"x"}'); await until(() => s.ended("a", 3), "not enabled, so not offered");
    s.send("a", 'call echo {"anything":1}'); await until(() => s.ended("a", 4), "built-in");
    expect(s.calls).toEqual([]);
    const results = s.results();
    expect(results.slice(0, 3).map(result => [result.code, result.outcome])).toEqual([
      ["invalid_arguments", { status: "skipped", code: "invalid_arguments" }], ["invalid_arguments", { status: "skipped", code: "invalid_arguments" }],
      ["tool_unavailable", { status: "skipped", code: "tool_unavailable" }]]);
    expect(results[0]!.message).toContain("arguments.q must be string");
    expect(results[2]!.message).toContain("not offered");
    expect(s.session.tools!.invocations(1)).toMatchObject([{ state: "skipped", code: "invalid_arguments", effect: "none" }]);
    expect(s.toolEvents().filter(event => event.startsWith("skipped"))).toEqual(["skipped:1:c1-1", "skipped:2:c2-1", "skipped:3:c3-1"]);
    expect(s.toolEvents().filter(event => event.startsWith("started"))).toEqual(["started:4:c4-1"]);
    // The model is told the reason in the paired result of the same turn.
    expect(s.requests.filter(request => request.channel === "a")[1]!.messages.at(-1)).toMatchObject({ role: "tool", callId: "c1-1" });
  } finally { s.close(); }
});

test("a tool revoked after it was offered is skipped at dispatch: before approval, while approval is pending, and after an approval was given", async () => {
  // Before dispatch, no approval involved: the barrier holds the call at the boundary.
  const barrier = deferred(), entered = deferred();
  const r = rig({ beforeDispatch: async () => { entered.resolve(); await barrier.promise; } }); const s = r.open();
  try {
    s.send("a", 'call send {"q":"x"}'); await entered.promise;
    expect(s.session.tools!.invocation("1:c1-1")).toMatchObject({ state: "requested" });
    s.session.tools!.revoke("send"); barrier.resolve();
    await until(() => s.ended("a"), "skipped turn");
    expect(s.calls).toEqual([]);
    expect(s.results()[0]).toMatchObject({ code: "tool_unavailable", outcome: { status: "skipped", code: "tool_unavailable" } });
    expect(s.session.tools!.invocation("1:c1-1")).toMatchObject({ state: "skipped", effect: "none" });
    // The next inference no longer offers it.
    expect(s.requests.at(-1)!.tools).not.toContain("send");
  } finally { s.close(); }

  // While its approval is pending: the request is closed and can no longer authorize anything.
  const asking = rig({ policies: { open: { fallback: "ask", tools: {} } } }); const p = asking.open();
  try {
    p.send("a", 'call send {"q":"x"}'); await until(() => !!p.approval(), "approval request");
    const requestId = p.approval()!.requestId;
    expect(p.session.tools!.invocation("1:c1-1")).toMatchObject({ state: "waiting_for_approval" });
    expect(p.session.status().channels[0]!.activeTurn).toMatchObject({ phase: { kind: "approval", id: requestId } });
    p.session.tools!.revoke("send");
    await until(() => p.ended("a"), "skipped turn");
    expect(p.session.approvals.respond(requestId, "allow_once")).toBe(false);
    expect(p.calls).toEqual([]);
    expect(p.results()[0]).toMatchObject({ code: "tool_unavailable", outcome: { status: "skipped", code: "tool_unavailable" } });
    expect(p.events.filter(e => e.event.type === "tool_call" && e.event.status === "started")).toEqual([]);
  } finally { p.close(); }

  // After the approval was given but before dispatch: the grant is discarded.
  const hold = deferred(), reached = deferred();
  const granted = rig({ policies: { open: { fallback: "ask", tools: {} } }, beforeDispatch: async () => { reached.resolve(); await hold.promise; } }); const g = granted.open();
  try {
    g.send("a", 'call send {"q":"x"}'); await until(() => !!g.approval(), "approval request");
    expect(g.session.approvals.respond(g.approval()!.requestId, "allow_once")).toBe(true);
    await reached.promise;
    g.session.tools!.revoke("send"); hold.resolve();
    await until(() => g.ended("a"), "skipped turn");
    expect(g.calls).toEqual([]);
    expect(g.results()).toHaveLength(1);
    expect(g.results()[0]).toMatchObject({ code: "tool_unavailable", outcome: { status: "skipped" } });
  } finally { g.close(); }
});

test("deadlines: a tool's own overrides the session default, none means no deadline; a timeout commits one paired result and a late reply changes nothing", async () => {
  const r = rig({ catalog: { catalog: [tool("quick", "fixed", { deadlineMs: 30 }), tool("patient", "fixed", { deadlineMs: 400 }), tool("plain", "fixed")], defaultDeadlineMs: 60 } });
  const s = r.open();
  try {
    // The longer per-tool deadline outlasts both the short one and the session default.
    s.send("p", 'call patient {"q":"x"}'); await until(() => s.calls.length === 1, "patient");
    s.send("a", 'call quick {"q":"x"}'); await until(() => s.calls.length === 2, "quick");
    s.send("d", 'call plain {"q":"x"}'); await until(() => s.calls.length === 3, "plain");
    await until(() => s.ended("a") && s.ended("d"), "the two short deadlines");
    expect(s.ended("p")).toBe(false);
    const quick = s.calls.find(call => call.request.tool === "quick")!, plain = s.calls.find(call => call.request.tool === "plain")!, patient = s.calls.find(call => call.request.tool === "patient")!;
    expect(quick.signal.aborted).toBe(true); // the host was asked to stop
    expect(plain.signal.aborted).toBe(true);
    expect(patient.signal.aborted).toBe(false);
    const timedOut = s.results().filter(result => result.code === "tool_timeout");
    expect(timedOut).toHaveLength(2);
    expect(timedOut[0]).toMatchObject({ ok: false, effect: "unknown", outcome: { status: "interrupted", code: "tool_timeout" } });
    expect(s.session.tools!.invocation(quick.request.invocationId)).toMatchObject({ state: "interrupted", code: "tool_timeout", effect: "unknown" });
    expect(s.toolEvents()).toContain(`interrupted:${quick.request.invocationId}`);
    // The turn stayed live: its next inference received exactly that one paired result, and then it completed.
    const inferences = s.requests.filter(request => request.channel === "a");
    expect(inferences).toHaveLength(2);
    expect(inferences[1]!.messages.filter(message => message.role === "tool")).toHaveLength(1);
    expect(s.events.findLast(e => e.channel === "a" && e.event.type === "turn_ended")!.event).toMatchObject({ outcome: "completed" });
    // A late reply is ignored: no new result, no further inference.
    const before = { results: s.results().length, requests: s.requests.length };
    quick.answer.resolve({ output: "too late" });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect({ results: s.results().length, requests: s.requests.length }).toEqual(before);
    patient.answer.resolve({ output: "in time" });
    await until(() => s.ended("p"), "patient turn");
    expect(s.results().at(-1)).toMatchObject({ ok: true, output: "in time" });
  } finally { s.close(); }

  // No deadline at all: the call simply waits.
  const untimed = rig({ catalog: { catalog: [tool("slow", "fixed")] } }); const u = untimed.open();
  try {
    u.send("a", 'call slow {"q":"x"}'); await until(() => u.calls.length === 1, "slow");
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(u.ended("a")).toBe(false);
    expect(u.calls[0]!.signal.aborted).toBe(false);
    u.calls[0]!.answer.resolve({ output: 1 });
    await until(() => u.ended("a"), "slow turn");
  } finally { u.close(); }
});

test("an executor that rejects its wait when asked to stop still yields the paired timeout result", async () => {
  const r = rig({ catalog: { catalog: [tool("quick", "fixed", { deadlineMs: 30 })] } }); const s = r.open();
  try {
    s.executor.call = (_request, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    s.send("a", 'call quick {"q":"x"}'); await until(() => s.ended("a"), "turn");
    expect(s.results()).toMatchObject([{ code: "tool_timeout", outcome: { status: "interrupted", code: "tool_timeout" } }]);
    expect(s.events.findLast(e => e.event.type === "turn_ended")!.event).toMatchObject({ outcome: "completed" });
  } finally { s.close(); }
});

test("a typed handler error is a paired failure and the turn goes on; a lost connection leaves the call uncertain and it is never repeated", async () => {
  const r = rig(); const s = r.open();
  s.send("a", 'call lookup {"q":"x"}'); await until(() => s.calls.length === 1, "callback");
  s.calls[0]!.answer.reject(new CallbackFailure("quota_exceeded", "No quota left"));
  await until(() => s.ended("a"), "failed call");
  expect(s.results()[0]).toMatchObject({ ok: false, code: "quota_exceeded", message: "No quota left", outcome: { status: "failed", code: "quota_exceeded" } });
  expect(s.events.findLast(e => e.event.type === "turn_ended")!.event).toMatchObject({ outcome: "completed" });
  expect(s.toolEvents()).toEqual(["started:1:c1-1", "failed:1:c1-1"]);

  s.send("a", 'call lookup {"q":"y"}'); await until(() => s.calls.length === 2, "second callback");
  s.calls[1]!.answer.reject(new CallbackLost("connection closed"));
  await until(() => s.ended("a", 2), "lost callback");
  expect(s.events.findLast(e => e.event.type === "turn_ended")!.event).toMatchObject({ outcome: "failed", uncertainCalls: ["c2-1"] });
  expect(s.results()).toHaveLength(1);
  expect(s.session.tools!.invocation("2:c2-1")).toMatchObject({ state: "interrupted", effect: "unknown" });
  s.close();
  // Reopen: still uncertain, and nothing calls the handler again.
  const again = r.open();
  try {
    expect(again.session.tools!.invocation("2:c2-1")).toMatchObject({ state: "interrupted", effect: "unknown" });
    again.send("a", "hello"); await until(() => again.ended("a"), "fresh turn");
    expect(again.calls).toEqual([]);
  } finally { again.close(); }
});

test("recovery tells a call that never reached dispatch from one that did", async () => {
  const hold = deferred(), reached = deferred();
  let held = false;
  const r = rig({ beforeDispatch: async () => { if (held) return; held = true; reached.resolve(); await hold.promise; } }); const s = r.open();
  s.send("a", 'call lookup {"q":"x"}'); await reached.promise;
  // The process ends with the call requested and no dispatch evidence.
  s.storage.close();
  const second = r.open();
  expect(second.session.tools!.invocation("1:c1-1")).toMatchObject({ state: "skipped", code: "turn_ended", effect: "none" });
  expect(second.session.snapshot().turns[0]!.state).toMatchObject({ status: "interrupted", uncertainCallIds: [] });
  // Now one that was dispatched: evidence is committed, the callback is outstanding.
  second.send("a", 'call lookup {"q":"y"}'); await until(() => second.calls.length === 1, "callback");
  second.storage.close();
  const third = r.open();
  try {
    expect(third.session.tools!.invocation("2:c2-1")).toMatchObject({ state: "interrupted", effect: "unknown" });
    expect(third.session.snapshot().turns[1]!.state).toMatchObject({ status: "interrupted", uncertainCallIds: ["c2-1"] });
    expect(third.calls).toEqual([]);
  } finally { third.close(); hold.resolve(); }
});

test("suspension waits for an untimed call and says which; interrupting the turn resolves the wait without replaying the call", async () => {
  const r = rig(); const s = r.open();
  try {
    s.send("a", 'call lookup {"q":"x"}'); await until(() => s.calls.length === 1, "callback");
    let suspended = false;
    const suspending = s.session.suspend().then(result => { suspended = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(suspended).toBe(false);
    const status = s.session.status();
    expect(status.lifecycle).toBe("suspending");
    expect(status.channels[0]!.activeTurn).toMatchObject({ status: "running", phase: { kind: "tool", id: "1:c1-1" } });
    expect(s.session.tools!.invocation("1:c1-1")).toMatchObject({ state: "started", tool: "lookup" });
    expect(s.session.channels.interrupt("a", 1)).toMatchObject({ ok: true, value: { interrupted: true } });
    expect((await suspending).ok).toBe(true);
    expect(s.calls[0]!.signal.aborted).toBe(true);
    expect(s.session.tools!.invocation("1:c1-1")).toMatchObject({ state: "interrupted", effect: "unknown" });
    // A late answer starts nothing, and resuming does not run the call again.
    s.calls[0]!.answer.resolve({ output: "late" });
    expect(s.session.resume().ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(s.calls).toHaveLength(1);
    expect(s.results()).toEqual([]);
    expect(s.requests).toHaveLength(1);
  } finally { s.close(); }
});

test("a large result is stored by its producer; only the channel that produced it can read it, by ID, until it expires", async () => {
  const r = rig(); const s = r.open();
  try {
    const full = "0123456789".repeat(5000);
    s.send("a", 'call lookup {"q":"big"}'); await until(() => s.calls.length === 1, "callback");
    s.stored.set("res-1", full);
    s.calls[0]!.answer.resolve({ preview: full.slice(0, 40), reference: { resultId: "res-1", bytes: full.length, retention: "temporary", expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    await until(() => s.ended("a"), "large result turn");
    const stored = s.results()[0]!;
    expect(stored).toMatchObject({ ok: true, preview: full.slice(0, 40), result_id: "res-1", bytes: 50000, outcome: { status: "succeeded", reference: { resultId: "res-1", bytes: 50000, retention: "temporary" } } });
    expect(JSON.stringify(stored).length).toBeLessThan(1000); // the model saw a preview, not the bytes
    expect(s.session.tools!.invocation("1:c1-1")).toMatchObject({ state: "succeeded", reference: { resultId: "res-1" } });

    // The producing channel reads a bounded part through the scoped reader.
    s.send("a", 'call read_tool_result {"result_id":"res-1","offset":10,"length":20}'); await until(() => s.ended("a", 2), "read");
    expect(s.results().at(-1)).toMatchObject({ ok: true, text: full.slice(10, 30), total_bytes: 50000, eof: false, next_offset: 30 });
    expect(s.reads).toEqual([{ resultId: "res-1", invocationId: "1:c1-1", channel: "a", offset: 10, length: 20 }]);
    // Another channel that saw the ID in shared history cannot use it; a path is not an ID; an unknown ID finds nothing.
    s.send("b", 'call read_tool_result {"result_id":"res-1"}'); await until(() => s.ended("b"), "other channel");
    expect(s.results().at(-1)).toMatchObject({ ok: false, code: "result_forbidden", outcome: { status: "failed", code: "result_forbidden" } });
    s.send("a", 'call read_tool_result {"result_id":"/etc/passwd"}'); await until(() => s.ended("a", 3), "path");
    expect(s.results().at(-1)).toMatchObject({ ok: false, code: "result_not_found" });
    s.send("a", 'call read_tool_result {"result_id":"res-2"}'); await until(() => s.ended("a", 4), "unknown");
    expect(s.results().at(-1)).toMatchObject({ ok: false, code: "result_not_found" });
    expect(s.reads).toHaveLength(1); // none of the refused reads reached the host
    // The producer dropped it: the host says so and the original call keeps its outcome.
    s.stored.delete("res-1");
    s.send("a", 'call read_tool_result {"result_id":"res-1"}'); await until(() => s.ended("a", 5), "expired at the host");
    expect(s.results().at(-1)).toMatchObject({ ok: false, code: "result_expired" });
    expect(s.session.tools!.invocation("1:c1-1")).toMatchObject({ state: "succeeded" });
  } finally { s.close(); }

  // A reference past its declared lifetime is refused by the harness itself; inline bytes over the limit are a typed failure.
  const short = rig({ limits: { inlineBytes: 200 } }); const e = short.open();
  try {
    e.send("a", 'call lookup {"q":"x"}'); await until(() => e.calls.length === 1, "callback");
    e.stored.set("old", "bytes");
    e.calls[0]!.answer.resolve({ preview: "by", reference: { resultId: "old", bytes: 5, retention: "temporary", expiresAt: new Date(Date.now() - 1000).toISOString() } });
    await until(() => e.ended("a"), "turn");
    e.send("a", 'call read_tool_result {"result_id":"old"}'); await until(() => e.ended("a", 2), "expired");
    expect(e.results().at(-1)).toMatchObject({ ok: false, code: "result_expired" });
    expect(e.reads).toEqual([]);
    e.send("a", 'call lookup {"q":"y"}'); await until(() => e.calls.length === 2, "second callback");
    e.calls[1]!.answer.resolve({ output: "x".repeat(500) });
    await until(() => e.ended("a", 3), "oversized inline");
    expect(e.results().at(-1)).toMatchObject({ ok: false, code: "result_too_large", outcome: { status: "failed" } });
  } finally { e.close(); }
});

test("catalog registrations cannot shadow notify_channel", () => {
  expect(() => parseCatalog({ catalog: [tool("notify_channel", "fixed")] }, [])).toThrow(CatalogError);
});
