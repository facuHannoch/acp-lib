import { expect, test } from "bun:test";
import type { Message, Model } from "../src/contracts/loop.ts";
import { runTurn } from "../src/kernel/loop.ts";
import { openRouter } from "../src/capabilities/model/openrouter.ts";
import type { ExecuteTurnTool, ToolCall } from "../src/contracts/loop.ts";

const dispatchTool = async (call: ToolCall, execute: ExecuteTurnTool) => {
  const result = await execute(call);
  return { ...(typeof result === "string" ? { content: result } : result), dispatched: true };
};

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
  const context = { append: (message: Message) => { messages.push(message); }, dispatchTool };
  messages.push({ role: "user", content: "First" });
  const infer = async (signal?: AbortSignal) => { const answer = await model(structuredClone(messages), [], signal); context.append(answer); return answer; };
  expect(await runTurn(context, infer, execute)).toBe("completed");
  messages.push({ role: "user", content: "Second" });
  expect(await runTurn(context, infer, execute)).toBe("completed");
  expect(messages.at(-1)).toEqual({ role: "assistant", content: "Done", calls: [] });
  expect(calls).toBe(3);
});

test("the loop checkpoints at a boundary instead of inferring, and an aborted turn records nothing more", async () => {
  const recorded: Message[] = [];
  let boundaries = 0, inferences = 0;
  const outcome = await runTurn({
    append: message => { recorded.push(message); }, dispatchTool,
    // Suspension is requested while the first iteration's tool is running.
    checkpoint: () => ++boundaries === 2,
  }, async () => { inferences++; const answer: Message & { role: "assistant" } = { role: "assistant", content: null, calls: [{ id: "a", name: "clock", arguments: "{}" }] }; recorded.push(answer); return answer; }, async () => "time");
  expect(outcome).toBe("suspended");
  expect(inferences).toBe(1);
  expect(recorded.map(message => message.role)).toEqual(["assistant", "tool"]);

  const abort = new AbortController(), late: Message[] = [];
  const stopped = runTurn({ append: message => { late.push(message); }, signal: abort.signal, dispatchTool },
    async signal => { expect(signal).toBe(abort.signal); abort.abort(new Error("stopped")); return { role: "assistant", content: "late", calls: [] }; },
    async () => "unused");
  await expect(stopped).rejects.toThrow("stopped");
  expect(late).toEqual([]);
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
