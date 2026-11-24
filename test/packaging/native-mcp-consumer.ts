import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentHarnessConfig } from "@qlairoslabs/acp-client";

const optional = process.argv[2] === "with";
const cwd = process.cwd();
assert(import.meta.resolve("@qlairoslabs/acp-client").startsWith(new URL("./node_modules/", import.meta.url).href));
for (const name of ["@modelcontextprotocol/sdk/client/index.js", "undici/package.json"]) {
  let resolved = false;
  try { resolved = import.meta.resolve(name).startsWith(new URL("./node_modules/", import.meta.url).href); } catch {}
  assert.equal(resolved, optional, name);
}
const secret = crypto.randomUUID();
const key = join(cwd, "key.pem"), cert = join(cwd, "cert.pem");
assert.equal(Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
  "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"],
{ stdout: "ignore", stderr: "ignore" }).exitCode, 0);
let httpsCalls = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: Bun.file(key), cert: Bun.file(cert) },
  async fetch(request) {
    if (request.method !== "POST" || request.headers.get("authorization") !== secret) return new Response(null, { status: 403 });
    const message = await request.json() as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "read", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: `packed HTTPS evidence ${secret}` }] };
    if (message.method === "tools/call") httpsCalls++;
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  },
});
try {
  const run = async (name: string, mcp: boolean) => {
    const script = join(cwd, `${name}.jsonl`), requests = join(cwd, `${name}-requests.jsonl`);
    const scenario = [{ type: "scenario", version: 1, name },
      ...(mcp && optional ? [{ type: "model", content: null, calls: ["docs", "web"].map(id => ({
        id, name: `mcp__${id}__72656164`, arguments: {},
      })) }] : []),
      { type: "model", content: "packed native reply" }];
    writeFileSync(script, scenario.map(row => JSON.stringify(row)).join("\n") + "\n");
    const config: AgentHarnessConfig["config"] = {
      version: 1, system: "Tarball smoke test", model: { protocol: "scripted", script },
      defaultPolicy: "owner", policies: { owner: { fallback: "allow", tools: {}, mcp: "allow" } },
      ...(mcp ? { mcpServers: {
        docs: { transport: "stdio", command: process.execPath, args: [join(cwd, "mcp-stdio-fixture.ts")] },
        web: { transport: "http", endpoint: new URL("/mcp", server.url).href, headers: { Authorization: { runtime: true } } },
      } } : {}),
    };
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(cwd, `${name}.sqlite`) },
      adapters: { main: { kind: "native" } }, defaultAdapterId: "main",
      harness: { home: join(cwd, `${name}-home`), config,
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert, HARNESS_TEST_REQUESTS: requests },
        ...(mcp ? { mcpRuntimeHeaders: () => ({ web: { Authorization: secret } }) } : {}),
      },
    });
    try {
      const channel = await agent.conversations.create();
      const reply = await channel.prompt("Use the packaged native harness.");
      assert.equal(reply.text, "packed native reply");
      const status = await agent.nativeMcpStatus();
      const captured = readFileSync(requests, "utf8");
      if (mcp && optional) {
        assert.equal(status.servers?.docs?.state, "ready");
        assert.equal(status.servers?.web?.state, "ready");
        assert(captured.includes("MCP fixture evidence"));
        assert(captured.includes("packed HTTPS evidence [redacted]"));
      } else if (mcp) {
        assert.deepEqual(status.servers?.docs, { transport: "stdio", state: "unavailable", reason: "discovery" });
        assert.deepEqual(status.servers?.web, { transport: "http", state: "unavailable", reason: "connect" });
        assert(!captured.includes("mcp__"));
      }
      assert(!captured.includes(secret));
      assert(!JSON.stringify(status).includes(secret));
      console.log(name, status.servers ?? {});
    } finally { await agent.close(); }
  };
  await run("mcp", true);
  if (!optional) await run("plain", false);
  assert.equal(httpsCalls, optional ? 1 : 0);
} finally { await server.stop(true); }
