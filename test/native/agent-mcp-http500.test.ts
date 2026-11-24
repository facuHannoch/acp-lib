import { expect, test } from "bun:test";
import { join } from "node:path";
import { nativeRig, reply } from "./support.ts";

// The first M3 harness terminated on these HTTP errors. With the fix (a2d5500) a failing MCP server must leave the harness running.
const regression = test;

for (const failure of ["tools/list", "tools/call"] as const) {
  regression(`native MCP survives HTTP 500 on ${failure}`, async () => {
    const rig = await nativeRig();
    const cert = join(rig.directory, "cert.pem"), key = join(rig.directory, "key.pem");
    expect(Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
      "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"],
    { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    const seen: string[] = [];
    const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: Bun.file(key), cert: Bun.file(cert) },
      async fetch(request) {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const input = await request.json() as { id?: number; method: string };
        seen.push(input.method);
        if (input.method === failure) return new Response("fixture error", { status: 500 });
        if (input.id === undefined) return new Response(null, { status: 202 });
        const result = input.method === "initialize"
          ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
          : { tools: [{ name: "read", inputSchema: { type: "object" } }] };
        return Response.json({ jsonrpc: "2.0", id: input.id, result });
      },
    });
    try {
      rig.env.NODE_EXTRA_CA_CERTS = cert;
      rig.harness.config = {
        version: 1, system: "Failure isolation fixture",
        model: { protocol: "scripted", script: join(rig.directory, "script.jsonl") },
        defaultPolicy: "owner", policies: { owner: { fallback: "allow", tools: {}, mcp: "allow" } },
        mcpServers: { web: { transport: "http", endpoint: new URL("/mcp", endpoint.url).href } },
      };
      rig.script([
        ...(failure === "tools/call" ? [{ content: null, calls: [{ id: "failing", name: "mcp__web__72656164", arguments: {} }] }] : []),
        reply("native survived"), reply("still running"),
      ]);
      const agent = await rig.open();
      const channel = await agent.conversations.create();
      const host = agent.nativeHarness!;
      await host.start();
      if (failure === "tools/list") expect((await agent.nativeMcpStatus()).servers?.web?.state).toBe("unavailable");
      expect((await channel.prompt("first")).text).toBe("native survived");
      expect(seen).toContain(failure);
      expect((await channel.prompt("second")).text).toBe("still running");
      expect(host.state).toBe("running");
      expect(host.launches).toBe(1);
    } finally { await rig.clean(); await endpoint.stop(true); }
  }, 15_000);
}
