import { inspectOperatorView } from "./helpers/operator-view.ts";
import { expect, spyOn, test } from "bun:test";
import { createInProcessHarness } from "../src/testing.ts";
import { spawnHarness } from "./helpers/stdio.ts";
import { createApprovalService } from "../src/governance/permissions/gate.ts";
import type { ChannelEvent } from "../src/contracts/events.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("./fixtures/echo-scenario.jsonl", import.meta.url).pathname;
const config = { version: 1 as const, system: "test", model: { protocol: "scripted" as const, script }, defaultPolicy: "ask",
  policies: { ask: { fallback: "ask" as const, tools: {} } } };
const init = { protocolVersion: 1, host: { name: "test", version: "0" }, callbacks: [], subscription: { text: "final" as const, tools: "none" as const } };
const push = { channel: "a", item: { id: "m", kind: "user_message" as const, sender: "u", content: [{ type: "text" as const, text: "hello" }] } };
const until = async (check: () => boolean) => { for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error("timed out"); };
for (const transport of ["in-process", "stdio"] as const) test(`${transport}: approval event is always sent and answer is one-time`, async () => {
  const harness = transport === "stdio" ? spawnHarness() : createInProcessHarness();
  try {
    await harness.client.initialize({ ...init, approval: true });
    await harness.client.createSession({ sessionId: "s", config, participants: [], channels: {} });
    const events: ChannelEvent[] = []; harness.client.onChannelEvent(event => events.push(event));
    await harness.client.push(push); await until(() => events.some(event => event.event.type === "approval_requested"));
    const request = events.find(event => event.event.type === "approval_requested")!.event;
    if (request.type !== "approval_requested") throw new Error("missing request");
    expect(request).toMatchObject({ channel: "a", turnId: "1", toolCallId: "echo-1", tool: "echo" });
    expect(await harness.client.respondApproval(request.requestId, "allow_once")).toEqual({ accepted: true });
    await expect(harness.client.respondApproval(request.requestId, "allow_once")).rejects.toMatchObject({ code: "not_found" });
    await until(() => events.some(event => event.event.type === "turn_ended"));
    expect(events.some(event => event.event.type === "tool_call")).toBe(false); // subscription hides tools, not approvals
  } finally { await harness.close(); }
}, 10000);

for (const approval of [undefined, false, "true"] as const) test(`only boolean true declares approval handling (${String(approval)})`, async () => {
  const harness = createInProcessHarness();
  try {
    await harness.client.initialize({ ...init, ...(approval === undefined ? {} : { approval }) } as any);
    await harness.client.createSession({ sessionId: "s", config, participants: [], channels: {} });
    const events: ChannelEvent[] = []; harness.client.onChannelEvent(event => events.push(event));
    await harness.client.push(push); await until(() => events.some(event => event.event.type === "turn_ended"));
    expect(events.some(event => event.event.type === "approval_requested")).toBe(false);
  } finally { harness.close(); }
});

test("default approval timer is ten minutes and disconnect records once", async () => {
  const delays: number[] = [], original = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    delays.push(delay ?? 0); return original(callback, delay, ...args);
  }) as typeof setTimeout);
  try {
    const recorded: string[] = [], service = createApprovalService(() => {}); service.setConsumer(true);
    const signal = new AbortController(), suspension = new AbortController();
    const request = service.request({ requestId: "r", channel: "a", turnId: "1", toolCallId: "c", tool: "work", arguments: "{}" }, signal.signal, suspension.signal, content => recorded.push(content));
    expect(delays).toContain(600_000); service.disconnect();
    expect((await request.answer).allowed).toBe(false); expect(recorded).toHaveLength(1);
    expect(JSON.parse(recorded[0]!).code).toBe("approval_disconnected");
  } finally { timer.mockRestore(); }
});

test("closing the in-process approval consumer records disconnect and lets the turn continue", async () => {
  const harness = createInProcessHarness({ captureRequests: true }), events: ChannelEvent[] = [];
  harness.server.subscribe(notification => events.push(notification.params));
  try {
    await harness.client.initialize({ ...init, approval: true });
    await harness.client.createSession({ sessionId: "s", config, participants: [], channels: {} });
    await harness.client.push(push); await until(() => events.some(event => event.event.type === "approval_requested"));
    harness.client.close();
    await until(() => events.some(event => event.event.type === "turn_ended"));
    const request = harness.models.get("a")![1]!;
    const result = request.messages.findLast(message => message.role === "tool");
    expect(result?.role === "tool" && JSON.parse(result.content).code).toBe("approval_disconnected");
    expect(events.some(event => event.event.type === "tool_call" && event.event.status === "started")).toBe(false);
  } finally { harness.close(); }
});

test("an approval pending at a real process crash cannot authorize work after restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "approval-crash-")), first = spawnHarness({ home });
  try {
    await first.client.initialize({ ...init, approval: true });
    await first.client.createSession({ sessionId: "s", config, participants: [], channels: {} });
    const events: ChannelEvent[] = []; first.client.onChannelEvent(event => events.push(event));
    await first.client.push(push); await until(() => events.some(event => event.event.type === "approval_requested"));
    const request = events.find(event => event.event.type === "approval_requested")!.event;
    if (request.type !== "approval_requested") throw new Error("missing request");
    first.child.kill("SIGKILL"); await first.child.exited; first.client.close();
    const second = spawnHarness({ home });
    try {
      await second.client.initialize({ ...init, approval: true });
      const loaded = await inspectOperatorView(second.client, { sessionId: "s" });
      expect(loaded.turns).toMatchObject([{ turnId: "1", state: "interrupted", uncertainCalls: [] }]);
      await expect(second.client.respondApproval(request.requestId, "allow_once")).rejects.toMatchObject({ code: "not_found" });
    } finally { await second.close(); }
  } finally { first.client.close(); first.child.kill(); rmSync(home, { recursive: true, force: true }); }
}, 10000);
