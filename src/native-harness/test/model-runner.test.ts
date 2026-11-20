import { expect, test } from "bun:test";
import { runModelCall } from "../src/capabilities/model/runner.ts";
import type { ModelAttempt, ModelAttemptEvent, ModelCallStore } from "../src/contracts/model-execution.ts";

const success = { role: "assistant" as const, content: "done", calls: [], stopReason: "complete" as const };
const ok = <T>(value: T) => ({ ok: true as const, value, revision: 1 });
function harness(scripts: ModelAttemptEvent[][]) {
  const records: string[] = [], requests: unknown[] = [];
  let index = 0;
  const store = {
    startCall: () => ok({ callId: "c", messageId: "m" }),
    startAttempt: () => { const id = String(index++); records.push(`start:${id}`); return ok({ attemptId: id, scriptStep: Number(id) }); },
    recordProviderRequestId: () => ok(undefined), confirm: () => ok([]), recordUsage: () => ok(undefined),
    finishAttempt: (_c: string, id: string, outcome: string) => { records.push(`${id}:${outcome}`); return ok(undefined); },
    finishCall: (_c: string, outcome: string) => { records.push(`call:${outcome}`); return ok(undefined); },
    commitResponse: () => { records.push("commit"); return ok({}); },
  } as unknown as ModelCallStore;
  const attempt = (step?: number): ModelAttempt => async function* (request) { requests.push(structuredClone(request)); for (const e of scripts[step!] ?? []) yield e; };
  const run = (delta?: (event: { messageId: string; text: string }) => void) => runModelCall({ turnId: "1", itemIds: [], request: { messages: [], tools: [] }, scripted: true, store, attempt, delta, settings: { retryDelayMs: 1, timeoutMs: 1000 } });
  return { records, requests, run, store };
}
test("transient pre-output failure retries one identical frozen request", async () => {
  const h = harness([[{ type: "seen" }, { type: "failure", kind: "transient", message: "try" }], [{ type: "response", response: success }]]);
  expect(await h.run()).toMatchObject({ messageId: "m", response: success });
  expect(h.requests).toHaveLength(2); expect(h.requests[0]).toEqual(h.requests[1]);
  expect(h.records).toEqual(["start:0", "0:transient_failure", "start:1", "commit"]);
});
for (const deliver of [false, true]) test(`partial text closes retry with ${deliver ? "stream" : "final"} delivery`, async () => {
  const h = harness([[{ type: "text_delta", text: "partial" }, { type: "failure", kind: "transient", message: "try" }], [{ type: "response", response: success }]]);
  const events: string[] = []; await expect(h.run(deliver ? e => events.push(e.text) : undefined)).rejects.toMatchObject({ outcome: "failed" });
  expect(h.requests).toHaveLength(1); expect(h.records).not.toContain("commit"); expect(events).toEqual(deliver ? ["partial"] : []);
});
test("a malformed tool request is never committed", async () => {
  const h = harness([[{ type: "response", response: { role: "assistant", content: null, stopReason: "tool_calls", calls: [{ id: "x", name: "a", arguments: "{" }] } }]]);
  await expect(h.run()).rejects.toMatchObject({ outcome: "failed" }); expect(h.records).not.toContain("commit");
});
test("interrupt fences a stalled adapter and its late terminal", async () => {
  const h = harness([]), stop = new AbortController(); let release!: (value: IteratorResult<ModelAttemptEvent>) => void;
  const iterator = { next: () => new Promise<IteratorResult<ModelAttemptEvent>>(resolve => { release = resolve; }) };
  const promise = runModelCall({ turnId: "1", itemIds: [], request: { messages: [], tools: [] }, scripted: true, store: h.store,
    attempt: () => () => ({ [Symbol.asyncIterator]: () => iterator }), signal: stop.signal, settings: { timeoutMs: 1000 } });
  await Promise.resolve(); stop.abort(); await expect(promise).rejects.toMatchObject({ outcome: "interrupted" });
  release({ done: false, value: { type: "response", response: success } }); await Promise.resolve(); expect(h.records).not.toContain("commit");
});

test("retry does not begin when the remaining deadline is shorter than its delay", async () => {
  const h = harness([[{ type: "failure", kind: "transient", message: "try" }]]);
  await expect(runModelCall({ turnId: "1", itemIds: [], request: { messages: [], tools: [] }, scripted: true, store: h.store,
    attempt: () => async function* () { yield { type: "failure", kind: "transient", message: "try" }; }, settings: { timeoutMs: 10 } })).rejects.toMatchObject({ outcome: "timeout" });
  expect(h.records).toEqual(["start:0", "0:transient_failure", "call:timeout"]);
});

test("provider output limit ends without committing or dispatchable tool requests", async () => {
  const h = harness([[{ type: "text_delta", text: "partial" }, { type: "response", response: { role: "assistant", content: "partial", calls: [], stopReason: "output_limit" } }]]);
  await expect(h.run()).rejects.toMatchObject({ outcome: "output_limit" });
  expect(h.records).toEqual(["start:0", "0:output_limit", "call:output_limit"]);
});

test("timeout aborts a stalled attempt and ignores its late response", async () => {
  const h = harness([]); let release!: (value: IteratorResult<ModelAttemptEvent>) => void; let signal!: AbortSignal;
  const iterator = { next: () => new Promise<IteratorResult<ModelAttemptEvent>>(resolve => { release = resolve; }) };
  const promise = runModelCall({ turnId: "1", itemIds: [], request: { messages: [], tools: [] }, scripted: true, store: h.store,
    attempt: () => (_request, attemptSignal) => { signal = attemptSignal; return { [Symbol.asyncIterator]: () => iterator }; }, settings: { timeoutMs: 5 } });
  await expect(promise).rejects.toMatchObject({ outcome: "timeout" }); expect(signal.aborted).toBe(true);
  release({ done: false, value: { type: "response", response: success } }); await Promise.resolve(); expect(h.records).not.toContain("commit");
});

test("atomic model commit precedes tool dispatch in the turn loop", async () => {
  const { runTurn } = await import("../src/kernel/loop.ts");
  const h = harness([[{ type: "response", response: { role: "assistant", content: "working", stopReason: "tool_calls", calls: [{ id: "x", name: "echo", arguments: "{}" }] } }], [{ type: "response", response: success }]]);
  const context = { build: () => [], append: () => { h.records.push("append-tool-result"); },
    dispatchTool: async () => { h.records.push("dispatch"); return { content: "ok", dispatched: true }; },
    finish: () => true };
  const infer = async () => (await h.run()).response;
  // Each logical call reserves its own attempt sequence in storage. Here use
  // independent harnesses so the example can stop after the tool iteration.
  let count = 0;
  await runTurn({ ...context, checkpoint: () => count++ > 0 }, infer, [], async () => "ok");
  expect(h.records).toEqual(["start:0", "commit", "dispatch", "append-tool-result"]);
});

test("interrupt during retry delay prevents the next attempt", async () => {
  const h = harness([]), controller = new AbortController();
  const promise = runModelCall({ turnId: "1", itemIds: [], request: { messages: [], tools: [] }, scripted: true, store: h.store, signal: controller.signal,
    attempt: () => async function* () { yield { type: "failure", kind: "transient", message: "try" }; }, settings: { timeoutMs: 2000, retryDelayMs: 1000 } });
  await new Promise(resolve => setTimeout(resolve, 2)); controller.abort();
  await expect(promise).rejects.toMatchObject({ outcome: "interrupted" }); expect(h.records).toEqual(["start:0", "0:transient_failure", "call:interrupted"]);
});

test("a failed atomic response commit cannot produce a dispatchable response", async () => {
  const h = harness([[{ type: "response", response: success }]]);
  h.store.commitResponse = () => ({ ok: false, error: { code: "invalid_state", message: "turn fenced" } });
  await expect(h.run()).rejects.toThrow("turn fenced"); expect(h.records).not.toContain("commit");
});

test("a stalled channel does not prevent an independent channel from completing", async () => {
  const alice = harness([]), bob = harness([[{ type: "response", response: success }]]), stop = new AbortController();
  const pending = runModelCall({ turnId: "alice", itemIds: [], request: { messages: [], tools: [] }, scripted: true, store: alice.store,
    signal: stop.signal, attempt: () => () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) });
  expect((await bob.run()).response.content).toBe("done"); expect(bob.records).toContain("commit");
  stop.abort(); await expect(pending).rejects.toMatchObject({ outcome: "interrupted" });
  const fresh = harness([[{ type: "response", response: success }]]); expect((await fresh.run()).response.content).toBe("done");
});

test("scripted and OpenRouter attempt adapters run through the commit boundary", async () => {
  const { scriptedAttempt } = await import("../src/capabilities/model/scripted.ts");
  const { openRouterAttempt } = await import("../src/capabilities/model/openrouter-stream.ts");
  const script = { version: 1, responses: [{ content: "scripted" }] }, first = harness([]);
  const scripted = await runModelCall({ turnId: "1", itemIds: [], request: { messages: [], tools: [] }, scripted: true, store: first.store,
    attempt: step => scriptedAttempt(script, step!) });
  expect(scripted.response.content).toBe("scripted"); expect(first.records).toContain("commit");
  const data = `data: ${JSON.stringify({ id: "r", choices: [{ delta: { content: "provider" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
  const fetcher = (async () => new Response(data)) as unknown as typeof fetch, second = harness([]), deltas: string[] = [];
  const provider = await runModelCall({ turnId: "2", itemIds: [], request: { messages: [], tools: [] }, scripted: false, store: second.store,
    attempt: () => openRouterAttempt("fake", "model", fetcher), delta: event => deltas.push(event.text) });
  expect(provider.response.content).toBe("provider"); expect(deltas).toEqual(["provider"]); expect(second.records).toContain("commit");
});
