import { expect, test } from "bun:test";
import type { Message, Model } from "../src/contracts/loop.ts";
import { runTurn } from "../src/kernel/loop.ts";
import { openRouter } from "../src/capabilities/model/openrouter.ts";

test("continues through multiple tools and retains history for the next turn", async () => {
  const messages: Message[] = [{ role: "system", content: "Test" }];
  let calls = 0;
  const model: Model = async (history) => {
    calls++;
    if (calls === 1) return {
      role: "assistant", content: null,
      calls: [{ id: "a", name: "clock", arguments: "{}" }, { id: "b", name: "unknown", arguments: "{}" }],
    };
    if (calls === 2) {
      expect(history.slice(-2)).toEqual([
        { role: "tool", callId: "a", content: "time" },
        { role: "tool", callId: "b", content: "not allowed" },
      ]);
    } else {
      expect(history.some((m) => m.content === "Done")).toBe(true);
    }
    return { role: "assistant", content: "Done", calls: [] };
  };
  const execute = async (call: { name: string }) => call.name === "clock" ? "time" : "not allowed";
  const context = { build: () => structuredClone(messages), append: (message: Message) => { messages.push(message); } };
  messages.push({ role: "user", content: "First" });
  expect(await runTurn(context, model, [], execute)).toBe("Done");
  messages.push({ role: "user", content: "Second" });
  expect(await runTurn(context, model, [], execute)).toBe("Done");
  expect(calls).toBe(3);
});

test("OpenRouter maps neutral messages and preserves opaque assistant state", async () => {
  const original = globalThis.fetch;
  const raw = {
    role: "assistant", content: null, reasoning_details: [{ opaque: "preserve" }],
    tool_calls: [{ id: "a", type: "function", function: { name: "clock", arguments: "{}" } }],
  };
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return Response.json({ choices: [{ finish_reason: "tool_calls", message: raw }] });
  }) as typeof fetch;
  try {
    const observed: unknown[] = [];
    const model = openRouter("fake-key", "test-model", (body) => observed.push(JSON.parse(body)));
    const tools = [{ name: "clock", description: "Time", parameters: { type: "object" } }];
    const first = await model([{ role: "user", content: "Time?" }], tools);
    expect(first.calls).toEqual([{ id: "a", name: "clock", arguments: "{}" }]);
    await model([first, { role: "tool", callId: "a", content: "now" }], tools);
    expect(bodies[1]).toEqual({
      model: "test-model",
      messages: [raw, { role: "tool", tool_call_id: "a", content: "now" }],
      tools: [{ type: "function", function: tools[0] }],
    });
    expect(observed).toEqual(bodies);
    expect(JSON.stringify(observed)).not.toContain("fake-key");
  } finally { globalThis.fetch = original; }
});
