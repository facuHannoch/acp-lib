import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHarness } from "./helpers/stdio.ts";

test("lost paid dispatch retains original attribution after restart with direct backend", async () => {
  const home = mkdtempSync(join(tmpdir(), "web-crash-")), script = join(home, "scenario.jsonl");
  writeFileSync(script, [{ type: "scenario", version: 1, name: "web-crash" }, { type: "model", content: null, calls: [{ id: "fetch", name: "web_fetch", arguments: { url: "https://example.com/" } }] }, { type: "model", content: "done" }].map(x => JSON.stringify(x)).join("\n") + "\n");
  const base = { version: 1 as const, system: "test", model: { protocol: "scripted" as const, script }, defaultPolicy: "allow", policies: { allow: { fallback: "allow" as const, tools: {} } } };
  try {
    const first = spawnHarness({ home, fault: "markToolDispatched:1", exaKey: "synthetic-key" });
    try {
      await first.client.initialize();
      await first.client.createSession({ sessionId: "s", config: { ...base, webFetch: { backend: "exa" } }, participants: [], channels: {} });
      await first.client.push({ channel: "a", item: { id: "m", kind: "user_message", sender: "p", content: [{ type: "text", text: "go" }] } });
      expect(await first.child.exited).not.toBe(0);
    } finally { first.client.close(); first.child.kill(); }
    const second = spawnHarness({ home });
    try {
      await second.client.initialize(); await second.client.openSession({ sessionId: "s", config: { ...base, webFetch: { backend: "http" } } });
      const result = await second.client.toolInvocations("1");
      expect(result.invocations).toMatchObject([{ invocationId: "1:fetch", state: "interrupted", effect: "unknown", webUsage: { backend: "exa", operation: "web_fetch", cost: { kind: "unknown" } } }]);
      await second.client.suspend(); const bytes = await second.client.exportArchive();
      expect(Buffer.from(bytes).includes("synthetic-key")).toBe(false);
    } finally { await second.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 15000);

test("stdio refuses disabled and malformed web tools before approval", async () => {
  const home = mkdtempSync(join(tmpdir(), "web-refuse-stdio-")), script = join(home, "scenario.jsonl");
  writeFileSync(script, [{ type: "scenario", version: 1, name: "web-refuse" }, { type: "model", content: null, calls: [
    { id: "bad", name: "web_search", arguments: { query: " " } }, { id: "disabled", name: "web_fetch", arguments: { url: "https://example.com/" } },
  ] }, { type: "model", content: "done" }].map(x => JSON.stringify(x)).join("\n") + "\n");
  const server = spawnHarness({ home, exaKey: "key" }); let approvals = 0;
  try {
    server.client.onChannelEvent(({ event }) => { if (event.type === "approval_requested") approvals++; });
    await server.client.initialize({ protocolVersion: 1, host: { name: "test", version: "0" }, callbacks: [], approval: true, subscription: { text: "final", tools: "full" } });
    await server.client.createSession({ sessionId: "s", participants: [], channels: {}, config: { version: 1, system: "test", model: { protocol: "scripted", script }, defaultPolicy: "ask", policies: { ask: { fallback: "ask", tools: {} } }, webSearch: { backend: "exa" } } });
    await server.client.push({ channel: "a", item: { id: "m", kind: "user_message", sender: "p", content: [{ type: "text", text: "go" }] } });
    const deadline = Date.now() + 5000; while (!(await server.client.idle()).idle && Date.now() < deadline) await Bun.sleep(10);
    expect(approvals).toBe(0);
    expect((await server.client.toolInvocations("1")).invocations).toMatchObject([{ state: "skipped", code: "invalid_arguments", webUsage: { cost: { kind: "none" } } }, { state: "skipped", code: "tool_unavailable", webUsage: { cost: { kind: "none" } } }]);
  } finally { await server.close(); rmSync(home, { recursive: true, force: true }); }
}, 15000);
