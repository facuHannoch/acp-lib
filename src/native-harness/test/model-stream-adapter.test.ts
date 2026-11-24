import { expect, test } from "bun:test";
import { openRouterAttempt } from "../src/capabilities/model/openrouter-stream.ts";
import { scriptedAttempt } from "../src/capabilities/model/scripted.ts";
import { createHash } from "node:crypto";

test("provider fragments assemble one tool call and usage before terminal", async () => {
  const chunks = [
    { id: "req", choices: [{ delta: { content: "hello", tool_calls: [{ index: 0, id: "call", function: { name: "echo", arguments: "{\"x\":" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
  ];
  let wire: string | undefined;
  const fetcher = (async (_url, init) => {
    wire = String(init?.body);
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
  }) as typeof fetch;
  const events = []; for await (const event of openRouterAttempt("secret", "model", fetcher)({ messages: [], tools: [], takenItemIds: ["local-item"] }, new AbortController().signal)) events.push(event);
  expect(JSON.parse(wire!)).toEqual({ model: "model", stream: true, stream_options: { include_usage: true }, messages: [] });
  expect(events.map(e => e.type)).toEqual(["accepted", "text_delta", "seen", "seen", "usage", "response"]);
  expect(events.at(-1)).toMatchObject({ type: "response", providerRequestId: "req", response: { stopReason: "tool_calls", calls: [{ id: "call", name: "echo", arguments: '{"x":1}' }] } });
});

test("vision provider request preserves order without storing image bytes in the request capture", async () => {
  const bytes = Buffer.from("fixture bytes"), encoded = bytes.toString("base64");
  const metadata = { id: "image", channel: "a", filename: "a.png", mediaType: "image/png", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  let wire = "", captured = "";
  const fetcher = (async (_url, init) => { wire = String(init?.body); return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`); }) as typeof fetch;
  const attempt = openRouterAttempt("secret", "model", fetcher, body => { captured = body; }, { supported: true, metadata: () => metadata, read: () => bytes });
  const events = [];
  for await (const event of attempt({ messages: [{ role: "user", content: "before\nafter", parts: [{ type: "text", text: "before" }, { type: "attachment", id: "image" }, { type: "text", text: "after" }] }], tools: [] }, new AbortController().signal)) events.push(event);
  const content = JSON.parse(wire).messages[0].content;
  expect(content.map((part: { type: string }) => part.type)).toEqual(["text", "image_url", "text"]);
  expect(content[1].image_url.url).toContain(encoded);
  expect(captured).not.toContain(encoded);
  expect(events.at(-1)).toMatchObject({ type: "response" });
});

test("vision provider reports all unavailable images without making a partial request", async () => {
  let fetched = false;
  const fetcher = (async () => { fetched = true; return new Response(); }) as typeof fetch;
  const metadata = (id: string) => ({ id, channel: "a", filename: "a.png", mediaType: "image/png", bytes: 1, sha256: "0".repeat(64) });
  const attempt = openRouterAttempt("secret", "model", fetcher, undefined, { supported: true, metadata, read: () => { throw Error("missing"); } });
  const events = [];
  for await (const event of attempt({ messages: [{ role: "user", content: "", parts: [{ type: "attachment", id: "one" }] },
    { role: "user", content: "", parts: [{ type: "attachment", id: "two" }] }], tools: [] }, new AbortController().signal)) events.push(event);
  expect(events).toMatchObject([{ type: "failure", code: "attachment_unavailable", attachmentIds: ["one", "two"] }]);
  expect(fetched).toBe(false);
});

test("script adapter reads its explicitly reserved step", async () => {
  const events = []; const script = { version: 1, responses: [{ content: "first" }, { content: "second" }] };
  for await (const event of scriptedAttempt(script, 1)({ messages: [], tools: [] }, new AbortController().signal)) events.push(event);
  expect(events).toMatchObject([{ type: "response", response: { content: "second", stopReason: "complete" } }]);
});
