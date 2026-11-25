import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelAttemptEvent, ModelRequest } from "../src/contracts/model-execution.ts";
import { openAICompatibleAttempt } from "../src/capabilities/model/openrouter-stream.ts";
import { validateManagedConfig } from "../src/util/config.ts";
import { compatibleInferenceKey } from "../src/runtime/config/inference-key.ts";
import { createInProcessHarness } from "../src/testing.ts";
import { decodeSessionFile } from "../src/state/storage/session-file.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";

const credential = "private-test-credential";
const config = (baseUrl: string, apiKeyEnv?: string) => ({
  version: 1 as const, system: "fixture",
  model: { protocol: "openai-compatible" as const, providerId: "Opaque/ID", model: "Provider/Model", baseUrl,
    ...(apiKeyEnv ? { apiKeyEnv } : {}) },
  defaultPolicy: "allow", policies: { allow: { fallback: "allow" as const, tools: {} } },
});

test("configured URL normalizes an API prefix and rejects ambiguous HTTP", () => {
  for (const url of ["http://127.1/v1", "http://0x7f.0.0.1/v1", "http://127.000.0.1/v1", "http://localhost/v1",
    "http://[::ffff:127.0.0.1]/v1", "https://user@test/v1", "https://test/v1?", "https://test/v1#", "https:///test", "https://test\\path"]) {
    expect(() => validateManagedConfig(config(url))).toThrow("config.model.baseUrl");
  }
  expect(validateManagedConfig(config("http://[::1]:8080/v1")).model).toMatchObject({ baseUrl: "http://[::1]:8080/v1" });
  expect(validateManagedConfig(config("HTTPS://EXAMPLE.COM:443/Gateway/v1///")).model).toMatchObject({
    baseUrl: "https://example.com/Gateway/v1", providerId: "Opaque/ID", model: "Provider/Model",
  });
  const raw = config("https://example.com");
  expect(() => validateManagedConfig({ ...raw, model: { ...raw.model, headers: {} } })).toThrow("headers");
});

const sse = (...chunks: unknown[]) => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });
const textResponse = () => sse({ choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } });
async function readEvents(baseUrl: string, request: ModelRequest, key?: string, signal = new AbortController().signal) {
  const events: ModelAttemptEvent[] = [];
  for await (const event of openAICompatibleAttempt(baseUrl, "Provider/Model", key)(request, signal)) events.push(event);
  return events;
}

test("loopback provider sees the exact request and redirects never receive a second request", async () => {
  const requests: { path: string; headers: Headers; body: unknown }[] = [];
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { throw Error("Redirect target must not be contacted"); } });
  let status = 200, redirect = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    requests.push({ path: new URL(req.url).pathname, headers: req.headers, body: await req.json() });
    if (status === 307) return new Response(credential, { status, headers: { Location: redirect } });
    if (status !== 200) return new Response(credential, { status });
    return textResponse();
  } });
  try {
    const baseUrl = new URL("/Gateway/v1", server.url).href;
    const request: ModelRequest = { messages: [{ role: "user", content: "test" }],
      tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }], takenItemIds: ["private-id"] };
    expect(await readEvents(baseUrl, request)).toMatchObject([{ type: "accepted" }, { type: "text_delta", text: "hello" },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 1 } }, { type: "response", response: { stopReason: "complete" } }]);
    expect(requests[0]?.path).toBe("/Gateway/v1/chat/completions");
    expect(requests[0]?.body).toEqual({ model: "Provider/Model", stream: true, stream_options: { include_usage: true },
      messages: request.messages, tools: [{ type: "function", function: request.tools[0] }], tool_choice: "auto" });
    expect(requests[0]?.headers.has("authorization")).toBe(false);
    for (redirect of [new URL("/other", server.url).href, target.url.href]) {
      status = 307;
      const before = requests.length;
      expect(await readEvents(baseUrl, request, credential)).toEqual([{ type: "failure", kind: "provider", message: "redirect_refused" }]);
      expect(requests).toHaveLength(before + 1);
      expect(requests.at(-1)?.headers.get("authorization")).toBe(`Bearer ${credential}`);
      expect(requests.at(-1)?.headers.has("http-referer")).toBe(false);
    }
    for (status of [401, 503]) {
      const events = await readEvents(baseUrl, request, credential);
      expect(events).toEqual([{ type: "failure", kind: status === 401 ? "invalid_request" : "transient",
        message: `Chat Completions HTTP ${status}` }]);
    }
  } finally { server.stop(true); target.stop(true); }
});

test("checkpoint binds source identity and portable import retains only the credential reference", async () => {
  const home = mkdtempSync(join(tmpdir(), "compat-source-")), dest = mkdtempSync(join(tmpdir(), "compat-dest-"));
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return textResponse(); } });
  const original = config(new URL("/v1", server.url).href, "ORIGINAL");
  const adapter = createSqliteStorageAdapter(join(home, "s", "session.sqlite"));
  const tools = ["echo", "record", "hold", "notify_channel"];
  const identity = { sessionId: "s", compatibilityKey: compatibleInferenceKey(original.model, original.system, tools) };
  const must = <T>(value: { ok: true; value: T } | { ok: false; error: { message: string } }) => {
    if (!value.ok) throw Error(value.error.message);
    return value.value;
  };
  try {
    const first = createInProcessHarness({ home, environment: { ORIGINAL: credential } });
    try {
      await first.client.initialize();
      await first.client.createSession({ sessionId: "s", config: original, participants: [], channels: {} });
    } finally { first.close(); }
    const store = must(adapter.open({ mode: "open", identity, config: original }));
    try {
      must(store.acceptItem({ kind: "participant_message", channelId: "a", senderId: "user", text: "resume", itemId: "m" }));
      const turn = must(store.beginTurn("a"))!.turn;
      must(store.beginChannelSuspend("a"));
      must(store.checkpointTurn(turn.turnId));
    } finally { store.close(); }
    const renamed = { ...original, model: { ...original.model, apiKeyEnv: "REPLACEMENT" } };
    for (const model of [{ ...renamed.model, model: "other" }, { ...renamed.model, baseUrl: original.model.baseUrl + "/other" }]) {
      const harness = createInProcessHarness({ home, environment: { REPLACEMENT: credential } });
      try {
        await harness.client.initialize();
        await harness.client.openSession({ sessionId: "s", config: { ...original, model } });
        await expect(harness.client.resumeChannel({ channel: "a" })).rejects.toMatchObject({ code: "incompatible" });
      } finally { harness.close(); }
    }
    expect(requests).toBe(0);
    const harness = createInProcessHarness({ home, environment: { REPLACEMENT: credential } });
    let bytes: Uint8Array;
    try {
      await harness.client.initialize();
      await harness.client.openSession({ sessionId: "s", config: renamed });
      await harness.client.suspend();
      bytes = await harness.client.exportArchive();
    } finally { harness.close(); }
    expect((decodeSessionFile(bytes!, 268435456) as { config: unknown }).config).toEqual(renamed);
    expect(Buffer.from(bytes!).includes(credential)).toBe(false);
    const missing = createInProcessHarness({ home: dest, environment: {} });
    try {
      await missing.client.initialize();
      await missing.client.validateConfig(renamed);
      await missing.client.importArchive(bytes!);
      await expect(missing.client.openSession({ sessionId: "s" })).rejects.toMatchObject({ code: "invalid_config" });
    } finally { missing.close(); }
    const restored = createInProcessHarness({ home: dest, environment: { REPLACEMENT: credential } });
    try {
      await restored.client.initialize();
      await restored.client.openSession({ sessionId: "s" });
      await restored.client.resumeChannel({ channel: "a" });
      await restored.client.resume();
      const limit = performance.now() + 2000;
      while (!(await restored.client.idle()).idle && performance.now() < limit) await Bun.sleep(5);
      expect(requests).toBe(1);
    } finally { restored.close(); }
    expect(readFileSync(join(dest, "s", "session.sqlite")).includes(credential)).toBe(false);
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }); }
}, 15000);

test("compatible tool fragments, length finish, abort and runner timeout", async () => {
  let mode: "tool" | "length" | "stall" = "tool";
  let started!: () => void;
  let reached = new Promise<void>(resolve => { started = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    if (mode === "stall") {
      started();
      return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    }
    if (mode === "length") return sse({ choices: [{ delta: { content: "truncated" }, finish_reason: "length" }] });
    return sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "echo", arguments: '{"x":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] });
  } });
  const base = server.url.origin;
  const request = { messages: [], tools: [] };
  try {
    expect((await readEvents(base, request)).at(-1)).toMatchObject({ type: "response",
      response: { stopReason: "tool_calls", calls: [{ id: "call", name: "echo", arguments: '{"x":1}' }] } });
    mode = "length";
    expect((await readEvents(base, request)).at(-1)).toMatchObject({ type: "response", response: { stopReason: "output_limit" } });
    mode = "stall";
    const abort = new AbortController();
    const ongoing = readEvents(base, request, undefined, abort.signal);
    await reached;
    abort.abort();
    expect(await ongoing).toEqual([]);
    reached = new Promise<void>(resolve => { started = resolve; });
    const harness = createInProcessHarness({ modelTimeoutMs: 200 });
    const ended: unknown[] = [];
    harness.client.onChannelEvent(({ event }) => { if (event.type === "turn_ended") ended.push(event); });
    try {
      await harness.client.initialize();
      await harness.client.createSession({ sessionId: "timeout", config: config(base), participants: [], channels: {} });
      await harness.client.push({ channel: "a", item: { kind: "user_message", id: "timeout", sender: "user", content: [{ type: "text", text: "go" }] } });
      await reached;
      const deadline = performance.now() + 2000;
      while (!(await harness.client.idle()).idle && performance.now() < deadline) await Bun.sleep(5);
      expect((await harness.client.modelCalls()).calls).toMatchObject([{ outcome: "timeout", attempts: [{ outcome: "timeout" }] }]);
      expect(ended).toMatchObject([{ outcome: "failed", error: "timeout: Model request deadline exceeded" }]);
    } finally { harness.close(); }
  } finally { server.stop(true); }
});


test("compatible inference never accepts image opt-in or forwards attachment parts", async () => {
  const raw = config("https://example.com/v1");
  expect(() => validateManagedConfig({ ...raw, model: { ...raw.model, imageInput: true } })).toThrow("imageInput");
  let sent = false;
  const fetcher = (async () => { sent = true; throw new Error("must not send"); }) as unknown as typeof fetch;
  const request: ModelRequest = { messages: [{ role: "user", content: "look", parts: [{ type: "text", text: "look" }, { type: "attachment", id: "image" }] }], tools: [], takenItemIds: [] };
  const events: ModelAttemptEvent[] = [];
  for await (const event of openAICompatibleAttempt("https://example.com/v1", "model", credential, fetcher, undefined, () => ({ id: "image", channel: "a", filename: "photo.png", mediaType: "image/png", bytes: 8, sha256: "0".repeat(64) }))(request, new AbortController().signal)) events.push(event);
  expect(sent).toBe(false);
  expect(events).toMatchObject([{ type: "failure", kind: "invalid_request", code: "unsupported_image", attachmentIds: ["image"] }]);
});

 test("compatible text inference sends general-file references without bytes", async () => {
  let body: any;
  const fetcher = (async (_url: unknown, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return textResponse(); }) as unknown as typeof fetch;
  const request: ModelRequest = { messages: [{ role: "user", content: 'Shared history: {"type":"attachment","id":"old-image","mediaType":"image/png"}' }, { role: "user", content: "Participant: \"user\"\n\nbefore\nafter", parts: [{ type: "text", text: "before" }, { type: "attachment", id: "doc" }, { type: "text", text: "after" }] }], tools: [], takenItemIds: [] };
  const metadata = { id: "doc", channel: "a", filename: "notes.txt", mediaType: "text/plain", bytes: 23, sha256: "0".repeat(64) };
  const events: ModelAttemptEvent[] = [];
  for await (const event of openAICompatibleAttempt("https://example.com/v1", "model", credential, fetcher, undefined, () => metadata)(request, new AbortController().signal)) events.push(event);
  expect(body.messages[0].content).toContain('"id":"old-image"');
  expect(body.messages[1].content).toBe('Participant: "user"\n\nbefore[Attachment doc: notes.txt, text/plain, 23 bytes]after');
  expect(JSON.stringify(body)).not.toContain("data:");
  expect(events.some(event => event.type === "response")).toBe(true);
});
