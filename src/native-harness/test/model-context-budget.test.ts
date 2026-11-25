import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CONTEXT_LIMITS, createSessionContext } from "../src/capabilities/context/session.ts";
import { chatRequestSizer } from "../src/capabilities/model/chat-request.ts";
import { openRouterAttempt } from "../src/capabilities/model/openrouter-stream.ts";
import type { ContextCapture } from "../src/contracts/context.ts";
import type { ModelRequest } from "../src/contracts/model-execution.ts";
import type { TimelineEntry } from "../src/contracts/storage.ts";
import { validateManagedConfig } from "../src/util/config.ts";

test("explicit model sizing config validates reserves, byte ceilings and the supported model arms", () => {
  const base = { version: 1, system: "", model: { protocol: "openrouter", model: "fixture" },
    defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } } };
  const profile = { contextWindowTokens: 32_000, outputReserveTokens: 128, maxOutputTokens: 1024, estimationMarginTokens: 0 };
  expect(validateManagedConfig({ ...base, model: { ...base.model, contextBudget: profile } }).model).toMatchObject({ contextBudget: profile });
  for (const contextBudget of [
    { contextWindowTokens: 3072 }, { contextWindowTokens: 8192, maxOutputTokens: 8192 },
    { ...profile, maxRequestBytes: 64 * 1024 * 1024 + 1 }, { ...profile, contextWindowTokens: 10.1 },
    { ...profile, estimationMarginTokens: -1 }, { ...profile, extra: true }, null,
  ]) expect(() => validateManagedConfig({ ...base, model: { ...base.model, contextBudget } })).toThrow("config.model.contextBudget");
  expect(() => validateManagedConfig({ ...base, model: { protocol: "scripted", script: "x", contextBudget: profile } })).toThrow("config.model.contextBudget");
});

test("OpenRouter accounts for image tokens separately and bounds encoded bytes before reading image data", async () => {
  const image = new Uint8Array(5000).fill(17);
  const metadata = { id: "image", channel: "test", filename: "test.png", mediaType: "image/png",
    bytes: image.length, sha256: createHash("sha256").update(image).digest("hex") };
  const request: ModelRequest = { tools: [{ name: "tool", description: "café 🌱", parameters: {} }],
    messages: [{ role: "user", content: "こんにちは", parts: [{ type: "text", text: "こんにちは" }, { type: "attachment", id: "image" }] }] };
  const profile = { contextWindowTokens: 8192, outputReserveTokens: 128, maxOutputTokens: 256, estimationMarginTokens: 0 };
  const measurement = chatRequestSizer("fixture", false, profile, () => metadata)(request.tools)(request.messages);
  expect(measurement.requestBytes).toBeGreaterThan(measurement.estimatedInputTokens);
  expect(measurement.outputReserveTokens).toBe(256);
  let reads = 0;
  const wire: string[] = [];
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    wire.push(String(init.body));
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
  }) as typeof fetch;
  const attempt = openRouterAttempt("fixture", "fixture", fetcher, undefined, {
    supported: true, metadata: () => metadata, read: () => { reads += 1; return image; },
  });
  const run = (maxRequestBytes: number) => Array.fromAsync(attempt({ ...request,
    contextBudget: { ...profile, maxRequestBytes } }, new AbortController().signal));
  expect(await run(measurement.requestBytes - 1)).toMatchObject([{ contextFailure: { limit: "request_bytes" } }]);
  expect(reads).toBe(0); expect(wire).toHaveLength(0);
  expect((await run(measurement.requestBytes)).at(-1)?.type).toBe("response");
  expect(reads).toBe(1); expect(Buffer.byteLength(wire[0]!)).toBe(measurement.requestBytes);
  expect(JSON.parse(wire[0]!)).toMatchObject({ max_tokens: 256 });
});

test("configured builder distinguishes required storage overflow and preserves a complete mixed exchange", () => {
  const turn = { channelId: "a", turnId: 1 };
  const row = (seq: number, message: TimelineEntry["message"], turnId = 1): TimelineEntry =>
    ({ channelId: "a", turnId, seq, from: "fixture", at: "2026-01-01T00:00:00.000Z", message });
  const sibling = "s".repeat(2500);
  const required = [
    row(1, { role: "user", content: "task" }),
    row(2, { role: "assistant", content: null, calls: [{ id: "m", name: "mcp__fixture__746f6f6c", arguments: "{}" },
      { id: "s", name: "other", arguments: "{}" }] }),
    row(3, { role: "tool", callId: "m", content: '{"text":"complete"}' }),
    row(4, { role: "tool", callId: "s", content: sibling }),
  ];
  let storageOverflow = true;
  let captured: ContextCapture | undefined;
  const context = createSessionContext({
    readInferencePolicies: () => ({ ok: true, revision: 4, value: [] }),
    readInferenceContext: () => ({ ok: true, revision: 4, value: storageOverflow ? { code: "context_limit" } : {
      required, optionalTurn: [], localHistory: [row(0, { role: "user", content: "optional".repeat(1000) }, 0)],
      sharedHistory: [], unfinished: [], policyNames: [], takenItemIds: [],
    } }),
  }, "session", "system", CONTEXT_LIMITS, value => { captured = value; },
  chatRequestSizer("fixture", true, { contextWindowTokens: 10_000, maxRequestBytes: 6000 }));
  expect(context.build(turn, () => ({ tools: [] }))).toMatchObject({ ok: false, detail: { limit: "required_storage" } });
  storageOverflow = false;
  const built = context.build(turn, () => ({ tools: [] }));
  expect(built).toMatchObject({ ok: true });
  expect(captured?.context.messages).toContainEqual({ role: "tool", callId: "s", content: sibling });
  expect(captured?.omitted.local).toBe(1);
  expect(captured?.budget).toMatchObject({ estimator: "chat-completions-utf8-v1", toolDefinitionBytes: 0, maxRequestBytes: 6000 });
});
