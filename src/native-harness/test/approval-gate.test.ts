import { expect, test } from "bun:test";
import { createSession } from "../src/index.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import type { ManagedConfig, ToolDecision } from "../src/contracts/config-permissions.ts";
import type { ChannelEvent } from "../src/contracts/events.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean, label: string) { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error(`Timed out: ${label}`); }
function rig(rule: ToolDecision, options: { timeout?: number; beforeDispatch?: () => Promise<void>; toolWait?: Promise<void> } = {}) {
  const config: ManagedConfig = { version: 1, system: "test", model: { protocol: "scripted", script: "fixture" }, defaultPolicy: "main",
    policies: { main: { fallback: rule, tools: {} } } };
  const adapter = createMemoryStorageAdapter(), opened = adapter.open({ mode: "create", identity: { sessionId: "s", compatibilityKey: "k" }, config });
  if (!opened.ok) throw new Error(opened.error.message);
  const effects: string[] = [], events: ChannelEvent[] = [];
  const session = createSession({ systemPrompt: "test", storage: opened.value, config, approvalTimeoutMs: options.timeout, beforeToolDispatch: options.beforeDispatch,
    configureTurn(turn) { return { tools: [], model: async messages => turn.channelId === "bob" || messages.at(-1)?.role === "tool"
      ? { role: "assistant", content: "done", calls: [] }
      : { role: "assistant", content: null, calls: [{ id: `call-${turn.turnId}`, name: "work", arguments: '{"value":1}' }] },
      executeTool: async () => { effects.push("started"); if (options.toolWait) await options.toolWait; effects.push("finished"); return "effect"; } }; } });
  session.subscribe(event => events.push(event)); session.start();
  const send = (channel: string, id: string) => session.agent.send({ channelId: channel, participantId: "u", text: id, itemId: id });
  const approval = () => events.findLast(e => e.event.type === "approval_requested")?.event;
  const ended = (channel = "a") => events.some(e => e.channel === channel && e.event.type === "turn_ended");
  const tools = () => session.snapshot().timeline.filter(e => e.message.role === "tool").map(e => e.message.role === "tool" ? e.message.content : "");
  const close = () => { session.stop("done"); opened.value.close(); };
  return { session, events, effects, send, approval, ended, tools, close };
}
function id(event: ReturnType<ReturnType<typeof rig>["approval"]>) { if (!event || event.type !== "approval_requested") throw new Error("missing approval"); return event.requestId; }

test("allow dispatches once; policy denial and an unhandled ask produce paired results without started", async () => {
  for (const rule of ["allow", "deny", "ask"] as const) {
    const r = rig(rule); try {
      r.send("a", "one"); await until(() => r.ended(), "turn");
      expect(r.effects).toEqual(rule === "allow" ? ["started", "finished"] : []);
      expect(r.events.filter(e => e.event.type === "tool_call" && e.event.status === "started")).toHaveLength(rule === "allow" ? 1 : 0);
      expect(r.tools()).toHaveLength(1);
      if (rule !== "allow") expect(JSON.parse(r.tools()[0]!).code).toBe(rule === "deny" ? "policy_denied" : "approval_unhandled");
    } finally { r.close(); }
  }
});

test("one-time approval, deny, timeout and disconnect never authorize another call; another channel continues", async () => {
  for (const outcome of ["allow_once", "deny", "timeout", "disconnect"] as const) {
    const r = rig("ask", { timeout: 40 }); r.session.approvals.setConsumer(true);
    try {
      r.send("a", "one"); await until(() => !!r.approval(), "request"); const requestId = id(r.approval());
      r.send("bob", "bob"); await until(() => r.ended("bob"), "bob while approval waits");
      if (outcome === "disconnect") r.session.approvals.disconnect();
      else if (outcome !== "timeout") expect(r.session.approvals.respond(requestId, outcome)).toBe(true);
      await until(() => r.ended(), "approval outcome");
      expect(r.session.approvals.respond(requestId, "allow_once")).toBe(false);
      expect(r.effects).toEqual(outcome === "allow_once" ? ["started", "finished"] : []);
      expect(r.tools()).toHaveLength(1);
      if (outcome !== "allow_once") expect(JSON.parse(r.tools()[0]!).code).toBe({ deny: "approval_denied", timeout: "approval_timeout", disconnect: "approval_disconnected" }[outcome]);
    } finally { r.close(); }
  }
});

test("suspension before granted dispatch records a cancellation and no started event", async () => {
  const entered = deferred(), release = deferred();
  const r = rig("ask", { beforeDispatch: () => { entered.resolve(); return release.promise; } }); r.session.approvals.setConsumer(true);
  try {
    r.send("a", "one"); await until(() => !!r.approval(), "request"); const requestId = id(r.approval());
    expect(r.session.approvals.respond(requestId, "allow_once")).toBe(true); await entered.promise;
    const suspended = r.session.channels.suspend("a");
    expect(r.session.approvals.respond(requestId, "allow_once")).toBe(false);
    expect(JSON.parse(r.tools()[0]!).code).toBe("approval_cancelled_by_suspension");
    release.resolve(); expect((await suspended).ok).toBe(true);
    expect(r.effects).toEqual([]); expect(r.events.filter(e => e.event.type === "tool_call" && e.event.status === "started")).toHaveLength(0);
    expect(r.session.snapshot().turns[0]!.state.status).toBe("suspended");
  } finally { release.resolve(); r.close(); }
});

test("suspension after dispatch waits for the running tool and records exactly one started event", async () => {
  const release = deferred(), r = rig("ask", { toolWait: release.promise }); r.session.approvals.setConsumer(true);
  try {
    r.send("a", "one"); await until(() => !!r.approval(), "request");
    expect(r.session.approvals.respond(id(r.approval()), "allow_once")).toBe(true);
    await until(() => r.effects.includes("started"), "tool dispatch");
    let done = false; const suspended = r.session.channels.suspend("a").then(value => { done = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(done).toBe(false);
    release.resolve(); expect((await suspended).ok).toBe(true);
    expect(r.effects).toEqual(["started", "finished"]);
    expect(r.events.filter(e => e.event.type === "tool_call" && e.event.status === "started")).toHaveLength(1);
    expect(r.session.snapshot().turns[0]!.state.status).toBe("suspended");
  } finally { release.resolve(); r.close(); }
});

test("interrupt after a grant but before dispatch records exactly one result before termination", async () => {
  const entered = deferred(), release = deferred();
  const r = rig("ask", { beforeDispatch: () => { entered.resolve(); return release.promise; } }); r.session.approvals.setConsumer(true);
  try {
    r.send("a", "one"); await until(() => !!r.approval(), "request"); const requestId = id(r.approval());
    expect(r.session.approvals.respond(requestId, "allow_once")).toBe(true); await entered.promise;
    expect(r.session.channels.interrupt("a", 1).ok).toBe(true);
    expect(r.tools()).toHaveLength(1); expect(r.session.snapshot().turns[0]!.state).toMatchObject({ status: "interrupted", uncertainCallIds: [] });
    release.resolve(); await new Promise(resolve => setTimeout(resolve, 15));
    expect(r.tools()).toHaveLength(1); expect(r.effects).toEqual([]);
    expect(r.events.filter(e => e.event.type === "tool_call" && e.event.status === "started")).toHaveLength(0);
  } finally { release.resolve(); r.close(); }
});

test("disconnect after a grant but before dispatch discards it and records one result", async () => {
  const entered = deferred(), release = deferred();
  const r = rig("ask", { beforeDispatch: () => { entered.resolve(); return release.promise; } }); r.session.approvals.setConsumer(true);
  try {
    r.send("a", "one"); await until(() => !!r.approval(), "request"); const requestId = id(r.approval());
    expect(r.session.approvals.respond(requestId, "allow_once")).toBe(true); await entered.promise;
    r.session.approvals.disconnect(); expect(r.tools()).toHaveLength(1);
    expect(JSON.parse(r.tools()[0]!).code).toBe("approval_disconnected");
    release.resolve(); await until(() => r.ended(), "closed turn");
    expect(r.tools()).toHaveLength(1); expect(r.effects).toEqual([]);
    expect(r.events.filter(e => e.event.type === "tool_call" && e.event.status === "started")).toHaveLength(0);
  } finally { release.resolve(); r.close(); }
});

test("suspending another channel does not cancel the waiting approval", async () => {
  const r = rig("ask"); r.session.approvals.setConsumer(true);
  try {
    r.send("a", "one"); r.send("bob", "bob");
    await until(() => !!r.approval() && r.ended("bob"), "both channels");
    expect((await r.session.channels.suspend("bob")).ok).toBe(true);
    expect(r.session.approvals.respond(id(r.approval()), "allow_once")).toBe(true);
    await until(() => r.ended(), "approved turn"); expect(r.effects).toEqual(["started", "finished"]);
  } finally { r.close(); }
});

test("a failed durable dispatch mark cannot invoke the executor or emit started", async () => {
  const { createApprovalService, dispatchWithPolicy } = await import("../src/governance/permissions/gate.ts");
  let invoked = false, started = false;
  const abort = new AbortController(), suspend = new AbortController();
  await expect(dispatchWithPolicy({ decide: () => "allow", channel: "a", turnId: 1, call: { id: "c", name: "t", arguments: "{}" },
    signal: abort.signal, suspension: suspend.signal, approvals: createApprovalService(() => {}), recordSkip: () => {},
    mark: () => { throw new Error("mark failed"); }, started: () => { started = true; }, execute: async () => { invoked = true; return "x"; } })).rejects.toThrow("mark failed");
  expect(invoked).toBe(false); expect(started).toBe(false);
});

test("a failed pre-dispatch barrier discards the grant before the turn fails", async () => {
  const r = rig("ask", { beforeDispatch: async () => { throw new Error("barrier failed"); } }); r.session.approvals.setConsumer(true);
  try {
    r.send("a", "one"); await until(() => !!r.approval(), "request"); const requestId = id(r.approval());
    expect(r.session.approvals.respond(requestId, "allow_once")).toBe(true);
    await until(() => r.ended(), "failed turn");
    expect(r.session.approvals.respond(requestId, "allow_once")).toBe(false);
    expect(() => r.session.approvals.disconnect()).not.toThrow();
    expect(r.effects).toEqual([]); expect(r.tools()).toEqual([]);
    expect(r.session.snapshot().turns[0]!.state).toMatchObject({ status: "failed", uncertainCallIds: [] });
  } finally { r.close(); }
});

test("a reentrant started listener cannot interrupt before the already-marked executor is invoked", async () => {
  const release = deferred(), r = rig("allow", { toolWait: release.promise });
  r.session.subscribe(event => { if (event.event.type === "tool_call" && event.event.status === "started") r.session.channels.interrupt("a", 1); });
  try {
    r.send("a", "one"); await until(() => r.ended(), "interruption");
    expect(r.effects).toEqual(["started"]);
    expect(r.session.snapshot().turns[0]!.state).toMatchObject({ status: "interrupted", uncertainCallIds: ["call-1"] });
    release.resolve(); await until(() => r.effects.includes("finished"), "late tool return");
    expect(r.tools()).toEqual([]);
  } finally { release.resolve(); r.close(); }
});

for (const action of ["interrupt", "stop", "session suspend"] as const) test(`${action} closes a waiting approval before the turn rests`, async () => {
  const r = rig("ask"); r.session.approvals.setConsumer(true);
  try {
    r.send("a", "one"); await until(() => !!r.approval(), "request"); const requestId = id(r.approval());
    if (action === "interrupt") expect(r.session.channels.interrupt("a", 1).ok).toBe(true);
    else if (action === "stop") r.session.stop("stop");
    else expect((await r.session.suspend()).ok).toBe(true);
    expect(r.session.approvals.respond(requestId, "allow_once")).toBe(false);
    expect(r.effects).toEqual([]); expect(r.tools()).toHaveLength(1);
    if (action === "session suspend") expect(JSON.parse(r.tools()[0]!).code).toBe("approval_cancelled_by_suspension");
    else {
      expect(JSON.parse(r.tools()[0]!).code).toBe(action === "stop" ? "approval_cancelled_by_stop" : "approval_cancelled_by_interrupt");
      expect(r.session.snapshot().turns[0]!.state).toMatchObject({ status: "interrupted", uncertainCallIds: [] });
    }
  } finally { r.close(); }
});

test("a taken restrictive input tightens later calls without changing a running tool", async () => {
  const config: ManagedConfig = { version: 1, system: "test", model: { protocol: "scripted", script: "fixture" }, defaultPolicy: "open",
    policies: { open: { fallback: "allow", tools: {} }, strict: { fallback: "deny", tools: { hold: "allow" } } } };
  const adapter = createMemoryStorageAdapter(), opened = adapter.open({ mode: "create", identity: { sessionId: "s", compatibilityKey: "k" }, config });
  if (!opened.ok) throw new Error(opened.error.message);
  const release = deferred(), effects: string[] = []; let step = 0;
  const session = createSession({ systemPrompt: "test", storage: opened.value, config, configureTurn() { return { tools: [],
    model: async () => ++step === 1 ? { role: "assistant", content: null, calls: [{ id: "hold", name: "hold", arguments: "{}" }] }
      : step === 2 ? { role: "assistant", content: null, calls: [{ id: "blocked", name: "work", arguments: "{}" }] }
      : { role: "assistant", content: "done", calls: [] },
    executeTool: async call => { effects.push(call.name); if (call.name === "hold") await release.promise; return "ok"; } }; } });
  try {
    session.start(); session.agent.send({ channelId: "a", participantId: "u", text: "first", itemId: "first" });
    await until(() => effects.includes("hold"), "first tool");
    session.agent.send({ channelId: "a", participantId: "u", text: "tighten", itemId: "later", policy: "strict" });
    expect(effects).toEqual(["hold"]); release.resolve();
    await until(() => session.snapshot().turns[0]?.state.status === "completed", "turn completion");
    expect(effects).toEqual(["hold"]);
    const result = session.snapshot().timeline.find(entry => entry.message.role === "tool" && entry.message.callId === "blocked")!.message;
    expect(result.role === "tool" && JSON.parse(result.content).code).toBe("policy_denied");
  } finally { release.resolve(); session.stop("done"); opened.value.close(); }
});

test("a notice inherits source restrictions and cannot grant its target a denied tool", async () => {
  const config: ManagedConfig = { version: 1, system: "test", model: { protocol: "scripted", script: "fixture" }, defaultPolicy: "open",
    policies: { open: { fallback: "allow", tools: {} }, strict: { fallback: "deny", tools: { notify: "allow" } } } };
  const opened = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "s", compatibilityKey: "k" }, config });
  if (!opened.ok) throw new Error(opened.error.message);
  const effects: string[] = [];
  const session = createSession({ systemPrompt: "test", storage: opened.value, config, configureTurn(turn, notify) { return { tools: [],
    model: async messages => messages.at(-1)?.role === "tool" ? { role: "assistant", content: "done", calls: [] }
      : { role: "assistant", content: null, calls: [{ id: `call-${turn.turnId}`, name: turn.channelId === "source" ? "notify" : "work", arguments: "{}" }] },
    executeTool: async call => { effects.push(call.name); if (call.name === "notify") notify({ channelId: "target", fromChannelId: "source", text: "inherited" }); return "ok"; } }; } });
  try {
    expect(session.channels.create({ channelId: "target", policy: "open" }).ok).toBe(true);
    session.start(); session.agent.send({ channelId: "source", participantId: "u", text: "hi", itemId: "m", policy: "strict" });
    await until(() => session.snapshot().turns.some(turn => turn.channelId === "target" && turn.state.status === "completed"), "target notice turn");
    expect(effects).toEqual(["notify"]);
    const notice = session.snapshot().items.find(item => item.kind === "channel_notice")!;
    expect(notice.policy).toMatchObject({ resolved: "open", inherited: ["strict"] });
    const targetResult = session.snapshot().timeline.find(entry => entry.channelId === "target" && entry.message.role === "tool")!.message;
    expect(targetResult.role === "tool" && JSON.parse(targetResult.content).code).toBe("policy_denied");
  } finally { session.stop("done"); opened.value.close(); }
});

test("later approval-gated calls in a suspending iteration are paired without new requests", async () => {
  const config: ManagedConfig = { version: 1, system: "test", model: { protocol: "scripted", script: "fixture" }, defaultPolicy: "ask",
    policies: { ask: { fallback: "ask", tools: {} } } };
  const opened = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "s", compatibilityKey: "k" }, config });
  if (!opened.ok) throw new Error(opened.error.message);
  const events: ChannelEvent[] = [], effects: string[] = [];
  const session = createSession({ systemPrompt: "test", storage: opened.value, config, configureTurn() { return { tools: [],
    model: async () => ({ role: "assistant", content: null, calls: [{ id: "one", name: "work", arguments: "{}" }, { id: "two", name: "work", arguments: "{}" }] }),
    executeTool: async call => { effects.push(call.id); return "ok"; } }; } });
  session.subscribe(event => events.push(event)); session.approvals.setConsumer(true);
  try {
    session.start(); session.agent.send({ channelId: "a", participantId: "u", text: "hi" });
    await until(() => events.some(e => e.event.type === "approval_requested"), "first request");
    expect((await session.channels.suspend("a")).ok).toBe(true);
    expect(events.filter(e => e.event.type === "approval_requested")).toHaveLength(1);
    const results = session.snapshot().timeline.filter(e => e.message.role === "tool").map(e => e.message.role === "tool" ? JSON.parse(e.message.content).code : "");
    expect(results).toEqual(["approval_cancelled_by_suspension", "approval_cancelled_by_suspension"]); expect(effects).toEqual([]);
  } finally { session.stop("done"); opened.value.close(); }
});

for (const scope of ["channel", "session"] as const) test(`reentrant stop while ${scope} suspension closes an approval settles the suspension`, async () => {
  const r = rig("ask"); r.session.approvals.setConsumer(true);
  try {
    r.send("a", "one"); await until(() => !!r.approval(), "request");
    const unsubscribe = r.session.store.subscribe(() => r.session.stop("reentrant stop"));
    const result = scope === "channel" ? await r.session.channels.suspend("a") : await r.session.suspend();
    unsubscribe(); expect(result).toMatchObject({ ok: false, error: { code: "stopped" } });
    expect(r.effects).toEqual([]); expect(r.tools()).toHaveLength(1);
    expect(r.session.snapshot().turns[0]!.state).toMatchObject({ status: "interrupted", uncertainCallIds: [] });
  } finally { r.close(); }
});
