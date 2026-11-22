import { expect, test } from "bun:test";
import { openRouterAttempt } from "../src/capabilities/model/openrouter-stream.ts";
import { scriptedAttempt } from "../src/capabilities/model/scripted.ts";

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

test("script adapter reads its explicitly reserved step", async () => {
  const events = []; const script = { version: 1, responses: [{ content: "first" }, { content: "second" }] };
  for await (const event of scriptedAttempt(script, 1)({ messages: [], tools: [] }, new AbortController().signal)) events.push(event);
  expect(events).toMatchObject([{ type: "response", response: { content: "second", stopReason: "complete" } }]);
});
