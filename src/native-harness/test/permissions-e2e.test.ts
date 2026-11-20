import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInProcessHarness } from "../src/testing.ts";
import { spawnHarness } from "./helpers/stdio.ts";
import type { ChannelEvent, ManagedConfig } from "../src/client.ts";

const script = new URL("./fixtures/approval-e2e.json", import.meta.url).pathname;
const config: ManagedConfig = { version: 1, system: "Test approvals", model: { protocol: "scripted", script }, defaultPolicy: "ask",
  policies: { ask: { fallback: "ask", tools: {} }, deny: { fallback: "deny", tools: {} } } };
const init = { protocolVersion: 1, host: { name: "test", version: "0" }, callbacks: [], approval: true,
  subscription: { text: "final" as const, tools: "full" as const } };
const push = (channel: string, id: string, policy?: string) => ({ channel, item: { id, kind: "user_message" as const, sender: channel,
  content: [{ type: "text" as const, text: id }], ...(policy ? { policy } : {}) } });
const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
async function until(check: () => boolean, what: string) { for (let i = 0; i < 600; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error(`Timed out: ${what}`); }

for (const transport of ["in-process", "stdio"] as const) test(`${transport}: suspension cancels approval, resumes with its result, then approves a fresh call`, async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-permissions-e2e-")), effects = join(home, "effects.log"), requests = join(home, "requests.jsonl");
  const destination = mkdtempSync(join(tmpdir(), "harness-permissions-destination-"));
  const open = (location: string) => transport === "stdio" ? spawnHarness({ home: location, effects, requests }) : createInProcessHarness({ home: location, effects, requests });
  const harness = open(home);
  let sourceClosed = false, restored: ReturnType<typeof open> | undefined;
  const events: ChannelEvent[] = []; harness.client.onChannelEvent(event => events.push(event));
  try {
    await harness.client.initialize(init);
    await harness.client.createSession({ sessionId: "s", config, participants: [], channels: {} });
    await harness.client.push(push("alice", "a1"));
    await until(() => events.some(e => e.channel === "alice" && e.event.type === "approval_requested"), "first approval");
    const first = events.find(e => e.channel === "alice" && e.event.type === "approval_requested")!.event;
    if (first.type !== "approval_requested") throw new Error("missing approval");
    expect(first).toMatchObject({ turnId: "1", toolCallId: "first", tool: "record" });
    await harness.client.push(push("bob", "b1", "deny"));
    await until(() => events.some(e => e.channel === "bob" && e.event.type === "turn_ended" && e.event.outcome === "completed"), "Bob completes");
    expect(lines(effects)).toEqual([]);
    expect(await harness.client.suspendChannel({ channel: "alice" })).toMatchObject({ channel: { lifecycle: "suspended", activeTurn: { turnId: "1", state: "suspended" } } });
    expect(lines(effects)).toEqual([]);
    await expect(harness.client.respondApproval(first.requestId, "allow_once")).rejects.toMatchObject({ code: "not_found" });
    expect(events.filter(e => e.channel === "alice" && e.event.type === "tool_call" && e.event.status === "started")).toEqual([]);

    // Export needs a clean session suspension when an individual checkpoint
    // remains; import into a fresh home and reopen from its saved config.
    await harness.client.suspend(); const archive = await harness.client.exportArchive();
    await harness.close(); sourceClosed = true;
    restored = open(destination); restored.client.onChannelEvent(event => events.push(event));
    await restored.client.initialize(init); await restored.client.importArchive(archive);
    const loaded = await restored.client.loadSession({ sessionId: "s" });
    await expect(restored.client.respondApproval(first.requestId, "allow_once")).rejects.toMatchObject({ code: "not_found" });
    expect(loaded.status.channels.find(channel => channel.channel === "alice")).toMatchObject({ lifecycle: "suspended", activeTurn: { turnId: "1", state: "suspended" } });
    await restored.client.resume();
    expect((await restored.client.status()).channels.find(channel => channel.channel === "alice")).toMatchObject({ lifecycle: "suspended" });
    await restored.client.resumeChannel({ channel: "alice" });
    await until(() => events.filter(e => e.channel === "alice" && e.event.type === "approval_requested").length === 2, "second approval");
    const approvals = events.filter(e => e.channel === "alice" && e.event.type === "approval_requested").map(e => e.event);
    const second = approvals[1]!; if (second.type !== "approval_requested") throw new Error("missing second approval");
    expect(second).toMatchObject({ turnId: "1", toolCallId: "second", tool: "record" }); expect(second.requestId).not.toBe(first.requestId);
    const aliceRequests = lines(requests).map(line => JSON.parse(line)).filter(request => request.channel === "alice");
    expect(aliceRequests).toHaveLength(2);
    const result = aliceRequests[1].messages.findLast((message: { role: string }) => message.role === "tool");
    expect(result.callId).toBe("first"); expect(JSON.parse(result.content)).toMatchObject({ code: "approval_cancelled_by_suspension", ok: false });
    expect(await restored.client.respondApproval(second.requestId, "allow_once")).toEqual({ accepted: true });
    await until(() => events.some(e => e.channel === "alice" && e.event.type === "turn_ended" && e.event.outcome === "completed"), "Alice completes");
    expect(lines(effects)).toEqual(["approved"]);
    expect(events.filter(e => e.channel === "alice" && e.event.type === "tool_call" && e.event.status === "started")).toHaveLength(1);
  } finally { if (!sourceClosed) await harness.close(); if (restored) await restored.close(); rmSync(home, { recursive: true, force: true }); rmSync(destination, { recursive: true, force: true }); }
}, 20000);
