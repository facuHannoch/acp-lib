import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createScriptedModel, loadScriptedModel } from "../src/capabilities/model/scripted.ts";
import { echoDefinition, executeEcho } from "../src/capabilities/tools/echo.ts";
import { createSession } from "../src/index.ts";
import { ask } from "./helpers/session.ts";
import type { Message } from "../src/contracts/loop.ts";

test("file scenario executes echo through the real scheduler/loop and supplies its result to the next call", async () => {
  const scripted = await loadScriptedModel(new URL("./fixtures/echo-scenario.json", import.meta.url).pathname);
  const session = createSession({ systemPrompt: "Test system", configureTurn: () => ({ model: scripted.model, tools: [echoDefinition], executeTool: executeEcho }) });
  const store = session.store;
  session.start();
  expect(await ask(session, { channelId: "test", participantId: "tester", text: "Echo hello" })).toBe("The tool returned hello.");
  const requests = scripted.requests();
  expect(requests).toHaveLength(2);
  expect(requests[0]?.messages.at(-1)).toEqual({ role: "user", content: 'Participant: "tester"\n\nEcho hello' });
  expect(requests[1]?.messages.slice(-2)).toEqual([
    { role: "assistant", content: "I'll echo that.", calls: [{ id: "echo-1", name: "echo", arguments: '{"text":"hello"}' }] },
    { role: "tool", callId: "echo-1", content: '{"ok":true,"text":"hello"}' },
  ]);
  expect(requests[0]?.tools).toEqual([echoDefinition]);
  expect(store.snapshot().map(entry => entry.message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  expect(scripted.remaining()).toBe(0);
});

test("script, returned responses and captured requests do not alias caller data; instances have independent positions", async () => {
  const script = { version: 1, responses: [{ content: "original" }] };
  const first = createScriptedModel(script);
  const second = createScriptedModel(script);
  script.responses[0]!.content = "changed";
  const messages: Message[] = [{ role: "user", content: "prompt" }];
  const tools = [structuredClone(echoDefinition)];
  const answer = await first.model(messages, tools);
  answer.content = "changed answer";
  messages[0]!.content = "changed prompt";
  tools[0]!.name = "changed tool";
  const captured = first.requests();
  expect(captured[0]?.messages[0]?.content).toBe("prompt");
  expect(captured[0]?.tools[0]?.name).toBe("echo");
  captured[0]!.messages.length = 0;
  expect(first.requests()[0]?.messages).toHaveLength(1);
  expect((await second.model([], [])).content).toBe("original");
  // A reopened session skips the responses an earlier process already consumed.
  const continued = createScriptedModel({ version: 1, responses: [{ content: "first" }, { content: "second" }] }, 1);
  expect((await continued.model([], [])).content).toBe("second");
  expect(continued.remaining()).toBe(0);
  await expect(first.model([], [])).rejects.toMatchObject({ code: "script_exhausted" });
  expect(first.requests()).toHaveLength(2);
});

test("malformed scripts fail before execution with stable errors", () => {
  for (const script of [
    {}, { version: 2, responses: [] }, { version: 1, responses: [] },
    { version: 1, responses: [{ content: 42 }] },
    { version: 1, responses: [{ content: null, calls: null }] },
    { version: 1, responses: [{ content: "text", typo: true }] },
    { version: 1, responses: [{ content: null, calls: [{ id: "a", name: "echo", arguments: [] }] }] },
    { version: 1, responses: [{ content: null, calls: [
      { id: "a", name: "echo", arguments: {} }, { id: "a", name: "echo", arguments: {} },
    ] }] },
  ]) expect(() => createScriptedModel(script)).toThrow(expect.objectContaining({ code: "invalid_script" }));
});

test("missing files and invalid JSON have distinct error codes", async () => {
  const dir = await mkdtemp("/tmp/scripted-model-");
  try {
    await expect(loadScriptedModel(`${dir}/missing.json`)).rejects.toMatchObject({ code: "script_load_failed" });
    await Bun.write(`${dir}/invalid.json`, "{");
    await expect(loadScriptedModel(`${dir}/invalid.json`)).rejects.toMatchObject({ code: "invalid_script" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("echo preserves text and returns actionable failures to the loop", async () => {
  const text = "Hello\n\n你好 **literal**";
  expect(JSON.parse(await executeEcho({ id: "a", name: "echo", arguments: JSON.stringify({ text }) })))
    .toEqual({ ok: true, text });
  for (const [name, arguments_] of [["other", "{}"], ["echo", "{"], ["echo", '{"text":4}'], ["echo", '{"text":"hello","extra":true}']]) {
    const result = JSON.parse(await executeEcho({ id: "a", name: name!, arguments: arguments_! }));
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  }
});
