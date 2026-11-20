import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnHarness } from "./helpers/stdio.ts";
import type { ChannelEvent } from "../src/contracts/events.ts";
const script = new URL("./fixtures/model-e2e.json", import.meta.url).pathname;
const until = async (fn: () => boolean, what: string) => { for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error(`Timed out: ${what}`); };
const push = (channel: string, id: string) => ({ channel, item: { id, kind: "user_message" as const, sender: channel, content: [{ type: "text" as const, text: id }] } });

test("scripted stdio: partial reply times out without retry while another channel completes, then reopen retains evidence", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-model-e2e-")), effects = join(home, "effects.log");
  const first = spawnHarness({ home, effects, stallChannel: "alice", modelTimeoutMs: 1500 }); const events: ChannelEvent[] = [];
  let closed = false;
  try {
    first.client.onChannelEvent(event => events.push(event));
    await first.client.initialize({ protocolVersion: 1, host: { name: "test", version: "0" }, callbacks: [], subscription: { text: "stream", tools: "full" } });
    await first.client.createSession({ sessionId: "s", participants: [], channels: {}, config: { version: 1, system: "test", model: { protocol: "scripted", script }, defaultPolicy: "allow", policies: { allow: { fallback: "allow", tools: {} } } } });
    await first.client.push(push("alice", "a1"));
    await until(() => events.some(event => event.channel === "alice" && event.event.type === "text_delta"), "Alice partial");
    const delta = events.find(event => event.channel === "alice" && event.event.type === "text_delta")!.event;
    if (delta.type !== "text_delta") throw new Error("missing delta"); expect(delta.text).toBe("Partial reply");
    await first.client.push(push("bob", "b1"));
    await until(() => events.some(event => event.channel === "bob" && event.event.type === "turn_ended" && event.event.outcome === "completed"), "Bob completes");
    await until(() => events.some(event => event.channel === "alice" && event.event.type === "turn_ended" && event.event.outcome === "failed"), "Alice times out");
    expect(events.find(event => event.channel === "alice" && event.event.type === "text_incomplete")?.event).toMatchObject({ messageId: delta.messageId, reason: "timeout" });
    expect(events.find(event => event.channel === "alice" && event.event.type === "turn_ended")?.event).toMatchObject({ outcome: "failed", error: "timeout" });
    expect(events.findIndex(event => event.channel === "bob" && event.event.type === "turn_ended")).toBeLessThan(events.findIndex(event => event.channel === "alice" && event.event.type === "turn_ended"));
    expect(events.some(event => event.channel === "alice" && event.event.type === "message_completed")).toBe(false);
    expect(existsSync(effects) ? readFileSync(effects, "utf8") : "").toBe("");
    expect(events.some(event => event.channel === "alice" && event.event.type === "tool_call")).toBe(false);
    const summaries = (await first.client.modelCalls()).calls, alice = summaries.find(call => call.channel === "alice")!;
    expect(alice).toMatchObject({ messageId: delta.messageId, outcome: "timeout", attempts: [{ outcome: "timeout", usage: { inputTokens: 7 }, scriptStep: 0 }] });
    expect(alice.attempts).toHaveLength(1);
    expect(summaries.find(call => call.channel === "bob")?.outcome).toBe("succeeded");
    await first.client.push(push("alice", "a2"));
    await until(() => events.some(event => event.channel === "alice" && event.event.type === "message_completed"), "fresh work");
    await until(() => events.filter(event => event.channel === "alice" && event.event.type === "turn_ended").length === 2, "fresh turn ends");
    expect(events.find(event => event.channel === "alice" && event.event.type === "message_completed")?.event).toMatchObject({ parts: [{ text: "Fresh work completed" }] });
    await first.close(); closed = true;
    const second = spawnHarness({ home });
    try {
      await second.client.initialize(); const loaded = await second.client.loadSession({ sessionId: "s" });
      expect(loaded.items.find(item => item.id === "a1")?.milestone).toBe("seen");
      expect(loaded.messages.some(message => message.messageId === delta.messageId)).toBe(false);
      const restored = (await second.client.modelCalls()).calls.find(call => call.callId === alice.callId);
      expect(restored).toMatchObject({ outcome: "timeout", attempts: [{ usage: { inputTokens: 7 }, outcome: "timeout" }] });
    } finally { await second.close(); }
  } finally { if (!closed) await first.close(); rmSync(home, { recursive: true, force: true }); }
}, 15000);

for (const mode of ["in-process", "stdio"] as const) for (const text of ["final", "stream"] as const)
  test(`${mode} ${text}: text-and-tool response and later reply retain message boundaries`, async () => {
    const { createInProcessHarness } = await import("../src/testing.ts");
    const home = mkdtempSync(join(tmpdir(), "model-modes-")), options = { home, streamResponses: true };
    const harness = mode === "stdio" ? spawnHarness(options) : createInProcessHarness(options), events: ChannelEvent[] = [];
    const echoScript = new URL("./fixtures/echo-scenario.json", import.meta.url).pathname;
    try {
      harness.client.onChannelEvent(event => events.push(event));
      await harness.client.initialize({ protocolVersion: 1, host: { name: "test", version: "0" }, callbacks: [], subscription: { text, tools: "full" } });
      await harness.client.createSession({ sessionId: "s", participants: [], channels: {}, config: { version: 1, system: "test", model: { protocol: "scripted", script: echoScript }, defaultPolicy: "allow", policies: { allow: { fallback: "allow", tools: {} } } } });
      await harness.client.push(push("alice", "m")); await until(() => events.some(event => event.event.type === "turn_ended"), "turn completion");
      const ordered = events.map(event => event.event), completed = ordered.filter(event => event.type === "message_completed"), deltas = ordered.filter(event => event.type === "text_delta");
      expect(completed).toHaveLength(2); expect(completed.map(event => event.parts?.[0]?.text)).toEqual(["I'll echo that.", "The tool returned hello."]);
      expect(ordered.findIndex(event => event.type === "message_completed")).toBeLessThan(ordered.findIndex(event => event.type === "tool_call" && event.status === "started"));
      if (text === "stream") { expect(deltas.map(event => event.messageId)).toEqual(completed.map(event => event.messageId!)); }
      else expect(deltas).toEqual([]);
      const loaded = await harness.client.loadSession({ sessionId: "s" }); expect(loaded.messages.map(message => message.messageId)).toEqual(completed.map(event => event.messageId!));
    } finally { await harness.close(); rmSync(home, { recursive: true, force: true }); }
  }, 15000);
