import { expect, test } from "bun:test";
import { debugToolHandlers } from "../src/capabilities/tools/debug/index.ts";
import { openDevelopment } from "../src/interfaces/cli/development.ts";
import { ask } from "./helpers/session.ts";

const call = (name: string, raw: string) => ({ id: "debug", name, arguments: raw });

test("debug echo preserves text and debug wait validates and aborts", async () => {
  const echo = debugToolHandlers.get("test_echo")!;
  const wait = debugToolHandlers.get("test_wait")!;
  expect(await echo(call("test_echo", JSON.stringify({ text: "é\n" })))).toBe(JSON.stringify({ ok: true, text: "é\n" }));
  expect(await echo(call("test_echo", JSON.stringify({ text: "é".repeat(513) })))).toMatchObject({ outcome: { code: "invalid_arguments" } });
  expect(await wait(call("test_wait", '{"durationMs":30001}'))).toMatchObject({ outcome: { code: "invalid_arguments" } });
  const controller = new AbortController();
  const pending = wait(call("test_wait", '{"durationMs":30000}'), controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("opted-in development records a typed test failure and continues the turn", async () => {
  const seen: string[] = [];
  const development = await openDevelopment({
    systemPrompt: "Debug test", provider: { apiKey: "unused", model: "offline/test" }, debugTools: true,
    providerFactory: () => async (messages, tools) => {
      seen.push(...tools.map(tool => tool.name));
      if (!messages.some(message => message.role === "tool"))
        return { role: "assistant", calls: [call("test_fail", "{}")], content: null };
      return { role: "assistant", calls: [], content: "Saw the intentional failure." };
    },
  });
  try {
    development.session.start();
    expect(await ask(development.session, { channelId: "debug", participantId: "alice", text: "Try test_fail" }))
      .toBe("Saw the intentional failure.");
    expect(seen).toContain("test_echo");
    expect(seen).toContain("test_wait");
    const tool = development.session.snapshot().timeline.find(row => row.message.role === "tool");
    expect(tool?.message).toMatchObject({ role: "tool", outcome: { status: "failed", code: "debug_failure" } });
  } finally { development.close(); }
});

test("a debug wait leaves another channel free and can be interrupted", async () => {
  const development = await openDevelopment({
    systemPrompt: "Debug test", provider: { apiKey: "unused", model: "offline/test" }, debugTools: true,
    providerFactory: () => async messages => {
      if (messages.at(-1)?.content?.endsWith("hold"))
        return { role: "assistant", calls: [call("test_wait", '{"durationMs":30000}')], content: null };
      return { role: "assistant", calls: [], content: "Second channel completed." };
    },
  });
  try {
    development.session.start();
    const started = new Promise<number>(resolve => {
      const unsubscribe = development.session.subscribe(({ event }) => {
        if (event.type !== "tool_call" || event.name !== "test_wait" || event.status !== "started") return;
        unsubscribe();
        resolve(Number(event.turnId));
      });
    });
    const waiting = ask(development.session, { channelId: "slow", participantId: "alice", text: "hold" }).catch(error => String(error));
    const turnId = await started;
    expect(await ask(development.session, { channelId: "fast", participantId: "bob", text: "Continue" }))
      .toBe("Second channel completed.");
    expect(development.session.channels.interrupt("slow", turnId)).toMatchObject({ ok: true, value: { interrupted: true } });
    expect(await waiting).toContain("interrupted");
  } finally { development.close(); }
});
