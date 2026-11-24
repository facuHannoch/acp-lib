import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessHarness } from "../src/testing.ts";
import { spawnHarness } from "./helpers/stdio.ts";
import { connectMcpHttps } from "../src/capabilities/tools/mcp/http.ts";

const toolName = "mcp__fixture__72656164";

async function httpsFixture(run: (fixture: {
  endpoint: string;
  ca: string;
  cert: string;
  seen: { method: string; id?: number; requestId?: number }[];
  expected: { header?: string; env?: string; redirect?: boolean; fail?: string };
}) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "mcp-https-"));
  const cert = join(home, "cert.pem"), key = join(home, "key.pem");
  const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { stdout: "ignore", stderr: "ignore" });
  expect(generated.exitCode).toBe(0);
  const ca = readFileSync(cert, "utf8");
  const controller = new AbortController();
  const seen: { method: string; id?: number; requestId?: number }[] = [];
  const expected: { header?: string; env?: string; redirect?: boolean; fail?: string } = {};
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: Bun.file(key), cert: Bun.file(cert) },
    async fetch(request) {
      const requestPath = new URL(request.url).pathname;
      if (requestPath !== "/mcp") { seen.push({ method: requestPath }); return new Response(null, { status: 410 }); }
      if (request.headers.get("authorization") !== (expected.header ?? null) || request.headers.get("x-fixture") !== (expected.env ?? null))
        return new Response(null, { status: 403 });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = await request.json() as { id?: number; method: string; params?: { requestId?: number; arguments?: { mode?: string }; _meta?: { progressToken?: number } } };
      seen.push({ method: message.method, id: message.id, requestId: message.params?.requestId });
      if (expected.fail === message.method) return new Response("remote fixture diagnostics", { status: 500 });
      if (expected.redirect) return new Response(null, { status: 307, headers: { location: "/must-not-follow" } });
      if (message.id === undefined) return new Response(null, { status: 202 });
      const respond = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result });
      if (message.method === "initialize") return respond({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
      if (message.method === "tools/list") return respond({ tools: [{ name: "read", inputSchema: { type: "object" } }] });
      if (message.params?.arguments?.mode === "oversized") return respond({ content: [{ type: "text", text: "z".repeat(256 * 1024) }] });
      if (message.params?.arguments?.mode === "disconnect") {
        return new Response(": connection finished before result\n\n", { headers: { "content-type": "text/event-stream" } });
      }
      if (message.params?.arguments?.mode === "pending" || message.params?.arguments?.mode === "approval") {
        const approved = message.params?.arguments?.mode === "approval";
        const token = message.params._meta?.progressToken;
        return new Response(new ReadableStream({
          start(stream) {
            const write = () => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
              jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1 },
            })}\n\n`));
            write();
            const timer = setInterval(() => {
              try { write(); } catch { clearInterval(timer); }
            }, 25);
            const final = approved ? setTimeout(() => {
              clearInterval(timer);
              try {
                stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
                  jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "approved" }] },
                })}\n\n`));
                stream.close();
              } catch { /* The client already stopped reading. */ }
            }, 230) : undefined;
            controller.signal.addEventListener("abort", () => { clearInterval(timer); clearTimeout(final); }, { once: true });
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      return respond({ content: [{ type: "text", text: `fixture ${expected.header ?? ""} ${expected.env ?? ""}` }],
        structuredContent: { nested: { runtime: expected.header, env: expected.env } } });
    },
  });
  try { await run({ endpoint: new URL("/mcp", server.url).href, ca, cert, seen, expected }); }
  finally { controller.abort(); await server.stop(true); rmSync(home, { recursive: true, force: true }); }
}

async function until(predicate: () => boolean) {
  const expires = performance.now() + 2500;
  while (!predicate()) {
    if (performance.now() >= expires) throw new Error("Timed out waiting for loopback fixture");
    await Bun.sleep(5);
  }
}

test("HTTPS uses trusted TLS, an exact endpoint, original-ID cancellation and a hard deadline", async () => {
  await httpsFixture(async ({ endpoint, ca, seen, expected }) => {
    await expect(connectMcpHttps("fixture", endpoint, {}, 180)).rejects.toThrow();
    expect(seen).toHaveLength(0);
    const connection = await connectMcpHttps("fixture", endpoint, {}, 180, [], ca);
    const tool = connection.bindings.get(toolName)!;
    try {
      const control = new AbortController();
      const pending = tool.call({ mode: "approval" }, control.signal);
      await until(() => seen.some(call => call.method === "tools/call"));
      const first = seen.find(call => call.method === "tools/call")?.id;
      control.abort();
      expect((await pending).code).toBe("tool_interrupted");
      await until(() => seen.some(call => call.method === "notifications/cancelled" && call.requestId === first));
      expect((await tool.call({ mode: "pending" }, new AbortController().signal)).code).toBe("tool_timeout");
      await until(() => seen.filter(call => call.method === "notifications/cancelled").length === 2);
      expect((await tool.call({}, new AbortController().signal)).content).toContain("fixture");
      expect((await tool.call({ mode: "oversized" }, new AbortController().signal)).code).toBeDefined();
    } finally { await connection.close(); }
    const approval = await connectMcpHttps("fixture", endpoint, {}, 300, [], ca);
    try {
      const result = await approval.bindings.get(toolName)!.call({ mode: "approval" }, new AbortController().signal);
      expect(result.content).toContain("approved");
    } finally { await approval.close(); }
    const lost = await connectMcpHttps("fixture", endpoint, {}, 2000, [], ca);
    try {
      const result = await lost.bindings.get(toolName)!.call({ mode: "disconnect" }, new AbortController().signal);
      expect(result.code).toBe("mcp_uncertain");
      expect(lost.available()).toBe(false);
    } finally { await lost.close(); }
    expected.redirect = true;
    await expect(connectMcpHttps("fixture", endpoint, {}, 180, [], ca)).rejects.toThrow();
    expect(seen.some(call => call.method === "/must-not-follow")).toBe(false);
  });
});

test("runtime headers are owner-open material, missing is entry-local, and echoes never persist", async () => {
  await httpsFixture(async ({ endpoint, ca, seen, expected }) => {
    const home = mkdtempSync(join(tmpdir(), "mcp-header-")), script = join(home, "fixture.jsonl");
    const runtime = crypto.randomUUID(), env = crypto.randomUUID();
    writeFileSync(script, [
      { type: "scenario", version: 1, name: "https-fixture" },
      { type: "model", content: null, calls: [{ id: "call", name: toolName, arguments: {} }] },
      { type: "model", content: "done" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const config = {
      version: 1 as const, system: "", model: { protocol: "scripted" as const, script },
      defaultPolicy: "owner", policies: { owner: { mcp: "allow" as const, fallback: "allow" as const, tools: {} } },
      mcpServers: { fixture: { transport: "http" as const, endpoint,
        headers: { Authorization: { runtime: true as const }, "X-Fixture": { env: "FIXTURE_SECRET" } } } },
    };
    const open = () => createInProcessHarness({ home, mcpFixtureCa: ca, captureRequests: true, environment: { FIXTURE_SECRET: env } });
    const absent = open();
    try {
      await absent.client.initialize();
      const created = await absent.client.createSession({ sessionId: "mcp", config, participants: [], channels: {} });
      expect(created.mcpServers?.fixture).toMatchObject({ state: "unavailable", reason: "config" });
      expect(seen).toHaveLength(0);
    } finally { await absent.close(); }
    let savedArchive: Uint8Array | undefined;
    const ready = open();
    try {
      expected.header = runtime;
      expected.env = env;
      await ready.client.initialize();
      const opened = await ready.client.openSession({ sessionId: "mcp", mcpRuntimeHeaders: { fixture: { AUTHORIZATION: runtime } } });
      expect(opened.mcpServers?.fixture?.state).toBe("ready");
      await ready.client.push({ channel: "room", item: { id: "item", kind: "user_message", sender: "owner", content: [{ type: "text", text: "invoke" }] } });
      await until(() => ready.models.get("room")?.length === 2);
      const captured = JSON.stringify(ready.models.get("room"));
      expect(captured.includes(runtime) || captured.includes(env)).toBe(false);
      expect(captured.includes("[redacted]")).toBe(true);
      await ready.client.suspend();
      const archive = Buffer.from(await ready.client.exportArchive());
      savedArchive = archive;
      expect(archive.includes(runtime) || archive.includes(env)).toBe(false);
      const { decodeSessionFile } = await import("../src/state/storage/session-file.ts");
      const { validateSessionPayload } = await import("../src/state/storage/archive.ts");
      expect(validateSessionPayload(decodeSessionFile(archive, 268435456)).config).toMatchObject({ mcpServers: { fixture: {
        headers: { authorization: { runtime: true }, "x-fixture": { env: "FIXTURE_SECRET" } },
      } } });
    } finally { await ready.close(); }
    const replacement = open();
    try {
      await replacement.client.initialize();
      const before = seen.length;
      const opened = await replacement.client.openSession({ sessionId: "mcp", mcpRuntimeHeaders: { fixture: { Authorization: "" } } });
      expect(opened.mcpServers?.fixture).toMatchObject({ state: "unavailable", reason: "config" });
      expect(seen).toHaveLength(before);
    } finally { await replacement.close(); }
    const imported = open();
    try {
      await imported.client.initialize();
      const before = seen.length;
      await imported.client.importArchive(savedArchive!, "imported");
      expect(seen).toHaveLength(before);
      const opened = await imported.client.openSession({ sessionId: "imported" });
      expect(opened.mcpServers?.fixture).toMatchObject({ state: "unavailable", reason: "config" });
      expect(seen).toHaveLength(before);
    } finally { await imported.close(); rmSync(home, { recursive: true, force: true }); }
  });
});

for (const failure of ["tools/list", "tools/call"]) {
  test(`HTTP 500 during ${failure} stays local under real native stdio`, async () => {
    await httpsFixture(async ({ endpoint, cert, seen, expected }) => {
      expected.fail = failure;
      const home = mkdtempSync(join(tmpdir(), "mcp-https-500-"));
      const script = join(home, "fixture.jsonl"), requests = join(home, "requests.jsonl");
      writeFileSync(script, [
        { type: "scenario", version: 1, name: "http-errors" },
        { type: "model", channelId: "affected", content: null, calls: [{ id: "failed-call", name: toolName, arguments: {} }] },
        { type: "model", channelId: "affected", content: "handled" },
        { type: "model", channelId: "independent", content: "still usable" },
      ].map(row => JSON.stringify(row)).join("\n") + "\n");
      const harness = spawnHarness({ home, requests, extraCaCerts: cert });
      try {
        await harness.client.initialize();
        const opened = await harness.client.createSession({ sessionId: "fixture", participants: [], channels: {}, config: {
          version: 1, system: "", model: { protocol: "scripted", script }, defaultPolicy: "owner",
          policies: { owner: { mcp: "allow", fallback: "allow", tools: {} } },
          mcpServers: { fixture: { transport: "http", endpoint } },
        } });
        expect(opened.mcpServers?.fixture?.state).toBe(failure === "tools/list" ? "unavailable" : "ready");
        const push = (channel: string) => harness.client.push({ channel, item: {
          id: channel, sender: "owner", kind: "user_message", content: [{ type: "text", text: "go" }],
        } });
        const read = () => {
          try { return readFileSync(requests, "utf8").trim().split("\n").map(line => JSON.parse(line)); }
          catch { return []; }
        };
        await push("affected");
        await until(() => read().filter(row => row.channel === "affected").length === 2);
        const results = read().filter(row => row.channel === "affected")[1].messages
          .filter((message: { role: string }) => message.role === "tool");
        expect(results).toHaveLength(1);
        expect(JSON.parse(results[0].content).code).toBe(failure === "tools/list" ? "tool_unavailable" : "mcp_uncertain");
        expect(JSON.stringify(results).includes("remote fixture diagnostics")).toBe(false);
        expect(seen.filter(call => call.method === failure)).toHaveLength(1);
        await push("independent");
        await until(() => read().some(row => row.channel === "independent"));
        const expires = performance.now() + 2500;
        while (!(await harness.client.idle()).idle) {
          if (performance.now() >= expires) throw new Error("Independent channel did not settle");
          await Bun.sleep(5);
        }
        expect((await harness.client.status()).channels.some(channel => channel.channel === "independent")).toBe(true);
      } finally { try { await harness.close(); } finally { rmSync(home, { recursive: true, force: true }); } }
    });
  }, 10000);
}
