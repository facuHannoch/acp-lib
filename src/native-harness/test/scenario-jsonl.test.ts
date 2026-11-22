import { expect, spyOn, test } from "bun:test";
import { createInProcessHarness, loadScenario, parseScenario } from "../src/testing.ts";
import { scenarioAttempt } from "../src/capabilities/model/scenario-attempt.ts";
import type { ModelAttemptEvent } from "../src/contracts/model-execution.ts";
import type { ChannelEvent } from "../src/contracts/events.ts";

const header = '{"type":"scenario","version":1,"name":"scenario"}';
const bytes = (text: string) => new TextEncoder().encode(text);
const parse = (...records: string[]) => parseScenario(bytes([header, ...records].join("\r\n") + "\r\n"), "sample.jsonl");
const model = (value: object) => JSON.stringify({ type: "model", ...value });
const send = '{"type":"send","atMs":0,"channelId":"a","participantId":"p","inputId":"i","text":"go"}';

test("scenario validation identifies bad lines, including invalid UTF-8", () => {
  for (const record of ["", "{", '{"type":"other"}', model({ content: null, chunks: [{ afterMs: 0, text: "" }] }),
    model({ content: "a", chunks: [{ afterMs: 0, text: "b" }] }), model({ wait: "cancel", content: "" }),
    model({ content: "x", usage: { outputTokens: -1 } }), model({ content: "x", delayMs: 0.5 }),
    '{"type":"model","content":"x","extra":true}',
    '{"type":"model","content":"x","calls":[{"name":"echo","id":"x","arguments":{"key":1,"key":2}}]}',
  ]) expect(() => parse(model({ content: "valid" }), record, model({ content: "tail" }))).toThrow("sample.jsonl:3:");
  expect(() => parse(model({ content: "x" }), send, send)).toThrow("sample.jsonl:4: Duplicate input ID");
  expect(() => parseScenario(bytes(header.replace('"version":1', '"version":2')), "v.jsonl")).toThrow("v.jsonl:1:");
  expect(() => parseScenario(bytes("\uFEFF" + header), "bom.jsonl")).toThrow("bom.jsonl:1:");
  expect(() => parseScenario(Buffer.concat([bytes(header + "\n"), Buffer.from([255])]), "utf8.jsonl")).toThrow("utf8.jsonl:2:");
  expect(() => parse(send)).toThrow("sample.jsonl:2: Expected at least one model record");
});

test("model digest ignores scheduling and framing but includes explicit usage and model ordering", () => {
  const first = parse(model({ content: "a" }), send);
  const edited = parseScenario(bytes(header.replace("scenario\"}", "edited\"}") + '\n' + model({ delayMs: 0, content: "a", calls: [], chunks: [] })));
  expect(edited.modelDigest).toBe(first.modelDigest);
  expect(edited.fileDigest).not.toBe(first.fileDigest);
  expect(parse(model({ content: "a", usage: { outputTokens: 0 } })).modelDigest).not.toBe(first.modelDigest);
  expect(parse(model({ content: "a" }), model({ content: "b" })).modelDigest).not.toBe(parse(model({ content: "b" }), model({ content: "a" })).modelDigest);
});

test("validated playback emits usage, timed chunks and tools, and a wait aborts without a terminal", async () => {
  const scenario = parse(model({ content: "fallback" }), model({ channelId: "a", content: "ab", chunks: [{ afterMs: 1, text: "a" }, { afterMs: 0, text: "b" }],
    usage: { outputTokens: 2 }, calls: [{ id: "a", name: "echo", arguments: {} }] }), model({ channelId: "a", wait: "cancel" }));
  const request = { messages: [], tools: [] };
  const collect = async (channel: string, step: number, signal = new AbortController().signal) => {
    const events: ModelAttemptEvent[] = [];
    for await (const event of scenarioAttempt(scenario, channel, step)(request, signal)) events.push(event);
    return events;
  };
  expect((await collect("a", 0)).map(event => event.type)).toEqual(["accepted", "usage", "text_delta", "text_delta", "response"]);
  expect((await collect("a", 0)).at(-1)).toMatchObject({ response: { stopReason: "tool_calls" } });
  expect((await collect("b", 0)).at(-1)).toMatchObject({ response: { content: "fallback" } });
  expect(await collect("b", 1)).toEqual([{ type: "failure", kind: "provider", message: "script_exhausted" }]);
  const abort = new AbortController();
  const iterator = scenarioAttempt(scenario, "a", 1)(request, abort.signal)[Symbol.asyncIterator]();
  expect(await iterator.next()).toMatchObject({ value: { type: "accepted" }, done: false });
  const pending = iterator.next(); abort.abort();
  expect((await pending).done).toBe(true);
});

test("one scenario is loaded across channel positions and capture off does not clone a diagnostic request", async () => {
  let loaded = 0, requestCopies = 0;
  const clone = globalThis.structuredClone;
  const observe = spyOn(globalThis, "structuredClone").mockImplementation(value => {
    if (value && typeof value === "object" && "messages" in value && "takenItemIds" in value) requestCopies++;
    return clone(value);
  });
  const scenario = parse(model({ content: "default" }), model({ channelId: "a", content: "specific" }));
  const harness = createInProcessHarness({ scenarioLoader: async () => { loaded++; return scenario; } });
  const events: ChannelEvent[] = [];
  harness.client.onChannelEvent(event => events.push(event));
  try {
    await harness.client.initialize();
    await harness.client.createSession({ sessionId: "scenario", participants: [], channels: {}, config: {
      version: 1, system: "test", model: { protocol: "scripted", script: "seam.jsonl" },
      defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } },
    } });
    for (const [index, channel] of ["a", "b", "c", "b"].entries()) {
      await harness.client.push({ channel, item: { id: String(index), kind: "user_message", sender: "p", content: [{ type: "text", text: "go" }] } });
      for (let wait = 0; wait < 100 && events.filter(({ event }) => event.type === "turn_ended").length <= index; wait++) await Bun.sleep(5);
    }
    expect(loaded).toBe(1);
    expect(harness.models.size).toBe(0);
    expect(requestCopies).toBe(8); // one frozen request plus one adapter copy per call
    expect(events.flatMap(({ event }) => event.type === "message_completed" ? event.parts?.map(part => part.text) ?? [] : []))
      .toEqual(["specific", "default", "default"]);
    expect(events.at(-1)?.event).toMatchObject({ type: "turn_ended", outcome: "failed", error: "script_exhausted" });
    expect((await harness.client.modelCalls()).calls.at(-1)?.attempts[0]?.outcome).toBe("provider_failure");
  } finally { harness.close(); observe.mockRestore(); }
});

test("the checked-in echo fixture is JSONL", async () => {
  const scenario = await loadScenario(new URL("./fixtures/echo-scenario.jsonl", import.meta.url).pathname);
  expect(scenario.defaultModels[0]?.calls?.[0]?.name).toBe("echo");
});

test("a transient retry reserves the next record and keeps the boundary inputs", async () => {
  const scenario = parse(model({ failure: { kind: "transient", message: "retry me" } }), model({ content: "after retry" }));
  const harness = createInProcessHarness({ scenarioLoader: async () => scenario, captureRequests: true });
  try {
    await harness.client.initialize();
    await harness.client.createSession({ sessionId: "retry", participants: [], channels: {}, config: {
      version: 1, system: "test", model: { protocol: "scripted", script: "retry.jsonl" },
      defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } },
    } });
    const completed: string[] = [];
    harness.client.onChannelEvent(({ event }) => { if (event.type === "message_completed") completed.push(event.parts![0]!.text); });
    await harness.client.push({ channel: "a", item: { id: "input", kind: "user_message", sender: "p", content: [{ type: "text", text: "go" }] } });
    for (let wait = 0; wait < 500 && !completed.length; wait++) await Bun.sleep(5);
    expect(completed).toEqual(["after retry"]);
    expect(harness.models.get("a")?.map(request => request.takenItemIds)).toEqual([["input"], ["input"]]);
    expect((await harness.client.modelCalls()).calls[0]?.attempts).toMatchObject([
      { ordinal: 0, scriptStep: 0, outcome: "transient_failure" }, { ordinal: 1, scriptStep: 1, outcome: "succeeded" },
    ]);
  } finally { harness.close(); }
});
