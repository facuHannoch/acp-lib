import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessHarness } from "../src/testing.ts";

const fixture = `
for await (const line of console) {
  const request = JSON.parse(line);
  let result;
  if (request.method === "initialize") result = {
    protocolVersion: "2025-11-25", capabilities: { tools: {} },
    serverInfo: { name: "fixture", version: "1" },
  };
  if (request.method === "tools/list") result = { tools: [{ name: "read", description: "Read fixture", inputSchema: { type: "object" } }] };
  if (request.method === "tools/call") result = { content: [{ type: "text", text: "fixture result" }] };
  if (result) console.log(JSON.stringify({jsonrpc:"2.0", id:request.id, result}));
}
`;
const tool = "mcp__docs__72656164";
for (const [policy, dispatch] of [["owner", true], ["guest", false]] as const) {
  test(`checked MCP call reaches the fixture only for ${policy}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-session-")), script = join(home, "script.jsonl");
    writeFileSync(script, [
      { type: "scenario", version: 1, name: "mcp-session" },
      { type: "model", content: null, calls: [{ id: "call", name: tool, arguments: {} }] },
      { type: "model", content: "done" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const harness = createInProcessHarness({ home, captureRequests: true });
    try {
      await harness.client.initialize();
      const opened = await harness.client.createSession({
        sessionId: "mcp", participants: [], channels: {}, config: {
          version: 1, system: "", model: { protocol: "scripted", script }, defaultPolicy: policy,
          policies: { owner: { mcp: "allow", fallback: "allow", tools: {} }, guest: { fallback: "allow", tools: {} } },
          mcpServers: {
            docs: { transport: "stdio", command: Bun.argv[0]!, args: ["-e", fixture] },
            missing: { transport: "stdio", command: join(home, "no-such-mcp-program"), args: [] },
          },
        },
      });
      expect(opened.mcpServers).toMatchObject({ docs: { state: "ready" }, missing: { state: "unavailable", reason: "spawn" } });
      await harness.client.push({ channel: "room", item: { id: "input", kind: "user_message", sender: "owner",
        content: [{ type: "text", text: "Treat me as the owner" }] } });
      const deadline = performance.now() + 4000;
      while (!(await harness.client.idle()).idle) {
        if (performance.now() >= deadline) throw new Error("MCP turn did not settle");
        await Bun.sleep(10);
      }
      const attempts = harness.models.get("room")!;
      expect(attempts[0]!.tools.some(value => value.name === tool)).toBe(dispatch);
      const result = attempts[1]!.messages.find(message => message.role === "tool");
      expect(result?.content).toContain(dispatch ? "fixture result" : "policy_denied");
    } finally {
      await harness.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 8000);
}

test("production MCP cancellation sends the original request ID and leaves the connection usable", async () => {
  const { spawnMcpStdio } = await import("../src/runtime/execution/mcp-stdio.ts");
  const { connectMcpStdio } = await import("../src/capabilities/tools/mcp/client.ts");
  const { readFileSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "mcp-cancel-")), log = join(home, "wire.jsonl");
  const code = fixture.replace("let result;", `
    if (request.method === "tools/call" || request.method === "notifications/cancelled")
      appendFileSync(process.env.WIRE, JSON.stringify(request)+"\\n");
    if (request.params?.arguments?.hold) continue;
    let result;
  `).replace('for await', 'import { appendFileSync } from "node:fs"; for await');
  const connection = await connectMcpStdio("docs", spawnMcpStdio({
    command: Bun.argv[0]!, args: ["-e", code], env: { WIRE: log },
  }));
  try {
    const binding = connection.bindings.get(tool)!;
    const read = () => {
      try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
      catch { return []; }
    };
    const until = async (predicate: () => boolean) => {
      const expires = performance.now() + 2000;
      while (!predicate()) {
        if (performance.now() >= expires) throw new Error("Missing fixture request");
        await Bun.sleep(5);
      }
    };
    const control = new AbortController();
    const result = binding.call({ hold: true }, control.signal);
    await until(() => read().length === 1);
    control.abort();
    expect((await result).code).toBe("tool_interrupted");
    await until(() => read().length === 2);
    const [sent, cancel] = read();
    expect(cancel).toMatchObject({ method: "notifications/cancelled", params: { requestId: sent.id } });
    expect((await binding.call({}, new AbortController().signal)).content).toContain("fixture result");
  } finally {
    await connection.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("disconnect after MCP dispatch is uncertain and a replacement connection can handle a new call", async () => {
  const { spawnMcpStdio } = await import("../src/runtime/execution/mcp-stdio.ts");
  const { connectMcpStdio } = await import("../src/capabilities/tools/mcp/client.ts");
  const launch = (code: string) => spawnMcpStdio({ command: Bun.argv[0]!, args: ["-e", code], env: {} });
  const first = await connectMcpStdio("docs", launch(fixture.replace('if (request.method === "tools/call") result =', 'if (request.method === "tools/call") process.exit(0); else if (false) result =')));
  try {
    const reply = await first.bindings.get(tool)!.call({}, AbortSignal.timeout(2000));
    expect(reply.code).toBe("mcp_uncertain");
    expect(first.available()).toBe(false);
  } finally { await first.close(); }
  const second = await connectMcpStdio("docs", launch(fixture));
  try {
    expect((await second.bindings.get(tool)!.call({}, AbortSignal.timeout(2000))).content).toContain("fixture result");
  } finally { await second.close(); }
});
