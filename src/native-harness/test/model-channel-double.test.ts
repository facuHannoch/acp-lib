import { expect, test } from "bun:test";
import { createSession } from "../src/index.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import type { SessionStorage } from "../src/contracts/storage.ts";
import type { ChannelEvent } from "../src/contracts/events.ts";

const until = async (fn: () => boolean) => { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("timed out"); };

/** Stage 2 stand-in: real scheduler and existing memory lifecycle, with only the
 * new model-call transactions doubled. Stage 3 tests the real adapters. */
function callStoreDouble(base: SessionStorage): SessionStorage {
  let next = 0;
  const calls = new Map<string, { turn: number; message: string }>();
  return Object.assign(base, {
    startCall(turn: string) { const id = String(++next), call = { turn: Number(turn), message: `m${id}` }; calls.set(id, call);
      return { ok: true, revision: 0, value: { callId: id, messageId: call.message } }; },
    startAttempt(id: string) { return { ok: true, revision: 0, value: { attemptId: `a${id}` } }; },
    recordProviderRequestId() { return { ok: true, revision: 0, value: undefined }; },
    confirm(id: string, _attempt: string, milestone: "delivered" | "seen") {
      const result = base.confirmReceipts(calls.get(id)!.turn, milestone);
      return result.ok ? { ...result, value: result.value.map(item => item.itemId) } : result;
    },
    recordUsage() { return { ok: true, revision: 0, value: undefined }; },
    finishAttempt() { return { ok: true, revision: 0, value: undefined }; },
    finishCall() { return { ok: true, revision: 0, value: undefined }; },
    commitResponse(id: string, _attempt: string, response: { role: "assistant"; content: string | null; calls: [] }) {
      return base.appendMessage(calls.get(id)!.turn, { role: "assistant", content: response.content, calls: response.calls });
    },
  }) as SessionStorage;
}

test("interrupt ends one turn and the same channel takes and completes later work", async () => {
  const opened = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "stage2-double", compatibilityKey: "key" } });
  if (!opened.ok) throw new Error(opened.error.message);
  const storage = callStoreDouble(opened.value), events: ChannelEvent[] = [];
  let runs = 0, release!: () => void;
  const session = createSession({ systemPrompt: "test", storage, configureTurn() {
    return { tools: [], executeTool: async () => "unused", model: async () => {
      if (++runs === 1) { await new Promise<void>(resolve => { release = resolve; }); return { role: "assistant", content: "late", calls: [] }; }
      return { role: "assistant", content: "fresh", calls: [] };
    } };
  } });
  session.subscribe(e => events.push(e)); session.start();
  expect(session.agent.send({ channelId: "alice", participantId: "a", itemId: "first", text: "one" }).accepted).toBe(true);
  await until(() => runs === 1);
  const turn = events.find(e => e.event.type === "turn_started")!.event;
  if (turn.type !== "turn_started") throw new Error("missing turn");
  expect(session.channels.interrupt("alice", Number(turn.turnId)).ok).toBe(true);
  await until(() => events.some(e => e.event.type === "turn_ended" && e.event.turnId === turn.turnId && e.event.outcome === "interrupted"));
  expect(session.agent.send({ channelId: "alice", participantId: "a", itemId: "second", text: "two" }).accepted).toBe(true);
  await until(() => events.some(e => e.event.type === "turn_ended" && e.event.turnId !== turn.turnId && e.event.outcome === "completed"));
  release(); await new Promise(resolve => setTimeout(resolve, 5));
  const replies = session.snapshot().timeline.filter(entry => entry.message.role === "assistant").map(entry => entry.message.content);
  expect(replies).toEqual(["fresh"]); session.stop("test complete"); storage.close();
});

test("session stop cancels an active attempt and fences its late response", async () => {
  const opened = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "stop-double", compatibilityKey: "key" } });
  if (!opened.ok) throw new Error(opened.error.message);
  const storage = callStoreDouble(opened.value); let release!: () => void, entered = false;
  const session = createSession({ systemPrompt: "test", storage, configureTurn: () => ({ tools: [], executeTool: async () => "unused", model: async () => {
    entered = true; await new Promise<void>(resolve => { release = resolve; }); return { role: "assistant", content: "late", calls: [] };
  } }) });
  session.start(); session.agent.send({ channelId: "a", participantId: "a", text: "one" }); await until(() => entered);
  session.stop("stop test"); release(); await new Promise(resolve => setTimeout(resolve, 5));
  expect(session.snapshot().timeline.some(entry => entry.message.role === "assistant")).toBe(false); storage.close();
});

test("the real permission gate denies a committed tool request without dispatch", async () => {
  const config = { version: 1 as const, system: "test", model: { protocol: "scripted" as const, script: "fake" }, defaultPolicy: "deny",
    policies: { deny: { fallback: "deny" as const, tools: {} } } };
  const opened = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "policy-double", compatibilityKey: "key" }, config });
  if (!opened.ok) throw new Error(opened.error.message);
  const storage = callStoreDouble(opened.value), events: ChannelEvent[] = []; let invocation = 0, effects = 0;
  const session = createSession({ systemPrompt: "test", config, storage, configureTurn: () => ({ tools: [], executeTool: async () => { effects++; return "effect"; }, model: async () => ++invocation === 1
    ? { role: "assistant", content: "request", calls: [{ id: "tool", name: "danger", arguments: "{}" }] }
    : { role: "assistant", content: "done", calls: [] } }) });
  session.subscribe(e => events.push(e)); session.start(); session.agent.send({ channelId: "a", participantId: "a", text: "one" });
  await until(() => events.some(e => e.event.type === "turn_ended" && e.event.outcome === "completed"));
  const timeline = session.snapshot().timeline;
  expect(timeline.find(entry => entry.message.role === "assistant" && entry.message.calls.length)).toBeDefined();
  const result = timeline.find(entry => entry.message.role === "tool");
  expect(result?.message).toMatchObject({ role: "tool", callId: "tool" });
  expect(result && result.message.role === "tool" ? JSON.parse(result.message.content).code : "missing").toBe("policy_denied");
  expect(effects).toBe(0); expect(events.some(e => e.event.type === "tool_call" && e.event.status === "started")).toBe(false);
  session.stop("test complete"); storage.close();
});
