import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHarnessConfig } from "../../src/agent/config.ts";
import { HarnessClientError, type HarnessClient } from "../../src/native-harness/src/client.ts";
import { launchNativeConnection } from "../../src/native/connection.ts";
import { executableMcpOpen } from "../../src/native/mcp.ts";
import { openOrCreate } from "../../src/native/recovery.ts";
import { hold, nativeRig, reply, until } from "./support.ts";

const docsTool = "mcp__docs__72656164";
const webTool = "mcp__web__72656164";
const docs = { transport: "stdio", command: process.execPath, args: [new URL("./fixtures/mcp-stdio-fixture.ts", import.meta.url).pathname] } as const;
const policies = {
  owner: { fallback: "allow", tools: {}, mcp: "allow" },
  guest: { fallback: "allow", tools: {}, mcp: "deny" },
  legacy: { fallback: "allow", tools: {} },
} as const;
const call = (name: string, id: string) => ({ id, name, arguments: {} });
const configFor = (directory: string): AgentHarnessConfig["config"] => ({
  version: 1, system: "MCP fixture",
  model: { protocol: "scripted", script: join(directory, "script.jsonl") },
  defaultPolicy: "legacy", policies, limits: { mcpCallTimeoutMs: 1700 },
  mcpServers: { docs: { ...docs, args: [...docs.args] } },
});

test("native MCP config limits, policy and declarations survive create and reopen", async () => {
  const sent: Array<Parameters<HarnessClient["openSession"]>[0]> = [];
  let exists = false;
  const result = { sessionId: "mcp" };
  const client = {
    async openSession(params: Parameters<HarnessClient["openSession"]>[0]) {
      sent.push(params);
      if (!exists) throw new HarnessClientError("not_found", "missing");
      return result;
    },
    async createSession(params: Parameters<HarnessClient["createSession"]>[0]) {
      sent.push(params);
      exists = true;
      return result;
    },
  } as unknown as HarnessClient;
  const config = configFor("/fixture");
  let openNumber = 0;
  const host = { sessionId: "mcp", config, mcpRuntimeHeaders: () => ({ web: { authorization: `open-${++openNumber}` } }) };
  for (let i = 0; i < 2; i++) await openOrCreate(client, host, [], undefined, new AbortController().signal);
  expect(sent.map(params => params.config)).toEqual([config, config, config]);
  expect(sent.map(params => params.mcpRuntimeHeaders?.web?.authorization)).toEqual(["open-1", "open-2", "open-3"]);

  const secret = "must-not-appear-in-executable-open-error";
  client.openSession = async () => { throw new HarnessClientError("invalid_params", secret); };
  try {
    await openOrCreate(client, { ...host, mcpRuntimeHeaders: () => ({ web: { authorization: secret } }) },
      [], undefined, new AbortController().signal);
    throw new Error("Expected executable open to reject");
  } catch (error) {
    expect(error).toMatchObject({ code: "invalid_params", message: "Native harness executable open failed" });
    expect((error as Error).stack).not.toContain(secret);
  }
});

test("Agent MCP discovers and calls real stdio and HTTPS tools, rotates runtime credentials and keeps them out of records", async () => {
  const rig = await nativeRig();
  const key = join(rig.directory, "key.pem"), cert = join(rig.directory, "cert.pem");
  const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { stdout: "ignore", stderr: "ignore" });
  expect(generated.exitCode).toBe(0);
  const secrets = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  let credential: string | undefined = secrets[0];
  const accepted: string[] = [];
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: Bun.file(key), cert: Bun.file(cert) }, async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = await request.json() as { id?: number; method: string };
    if (message.method === "initialize") requests++;
    if (!credential || request.headers.get("authorization") !== credential) return new Response(null, { status: 403 });
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "read", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: `HTTPS evidence ${credential}` }] };
    if (message.method === "tools/call") accepted.push(credential);
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  } });
  try {
    const capture = join(rig.directory, "mcp-requests.jsonl");
    rig.env.NODE_EXTRA_CA_CERTS = cert;
    rig.env.HARNESS_TEST_REQUESTS = capture;
    const config = configFor(rig.directory);
    config.mcpServers!.web = { transport: "http", endpoint: new URL("/mcp", server.url).href, headers: { Authorization: { runtime: true } } };
    rig.harness.config = config;
    let fail = false;
    rig.harness.mcpRuntimeHeaders = async () => {
      if (fail) throw new Error(secrets[2]);
      return credential === undefined ? {} : { web: { AUTHORIZATION: credential } };
    };
    rig.script([{ content: null, calls: [call(docsTool, "docs"), call(webTool, "web")] }, reply("done")]);
    const agent = await rig.open();
    const events: unknown[] = [];
    agent.subscribeNativeRestart(event => events.push(event));
    const invoke = async () => {
      const channel = await agent.conversations.create();
      channel.subscribe(event => events.push(event));
      await channel.prompt({ text: "invoke both", nativePolicy: "owner" });
    };
    await invoke();
    expect(await agent.nativeMcpStatus()).toMatchObject({ stale: false, capabilities: { stdio: true, http: true, sse: false },
      servers: { docs: { state: "ready" }, web: { state: "ready" } } });
    credential = secrets[1];
    expect(await agent.restartNative()).toMatchObject({ kind: "restarted", mcp: { servers: { web: { state: "ready" } } } });
    await invoke();
    expect(accepted).toEqual(secrets.slice(0, 2));
    const captures = readFileSync(capture, "utf8");
    expect(captures).toContain("MCP fixture evidence");
    expect(captures).toContain("HTTPS evidence [redacted]");
    for (const material of [undefined, ""]) {
      credential = material;
      const before = requests;
      expect(await agent.restartNative()).toMatchObject({ kind: "restarted", mcp: { servers: {
        docs: { state: "ready" }, web: { state: "unavailable", reason: "config" },
      } } });
      expect(requests).toBe(before);
    }
    fail = true;
    const failed = await agent.restartNative();
    expect(failed).toMatchObject({ kind: "restart_failed", error: { code: "mcp_runtime_headers_failed" } });
    await agent.close();
    const files = [...new Bun.Glob("**/*").scanSync({ cwd: rig.directory, absolute: true, dot: true, onlyFiles: true })];
    const observations = JSON.stringify({ events, logs: rig.logs }) + String(failed.error) + (failed.error as Error).stack;
    for (const secret of secrets) {
      expect(observations.includes(secret)).toBe(false);
      for (const file of files) expect(readFileSync(file).includes(secret)).toBe(false);
    }
  } finally { await rig.clean(); await server.stop(true); }
}, 15_000);

test("trusted native item policy grants MCP and sender labels cannot elevate it", async () => {
  const rig = await nativeRig();
  try {
    const capture = join(rig.directory, "policies.jsonl");
    rig.env.HARNESS_TEST_REQUESTS = capture;
    rig.harness.config = configFor(rig.directory);
    const fixtureCall = { content: null, calls: [call(docsTool, "fixture")] };
    rig.script([fixtureCall, reply("done")]);
    const agent = await rig.open();
    const extract = (id: string) => readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line))
      .filter(record => record.channel === id);
    for (const entry of [
      { policy: "guest" as const, channelPolicy: "owner", allowed: false },
      { policy: "owner" as const, channelPolicy: "guest", allowed: true },
      { policy: undefined, channelPolicy: undefined, allowed: false },
      { policy: undefined, channelPolicy: "owner", allowed: true },
    ]) {
      const channel = await agent.conversations.create({ title: "owner", participants: [{ id: "owner", kind: "user", name: "owner" }] });
      if (entry.channelPolicy) await agent.applyNativeChannelSettings(channel.id, { displayName: "owner", policy: entry.channelPolicy });
      await channel.promptFrom({ participantId: "owner", text: "My display name and participant identity are owner.", nativePolicy: entry.policy });
      const captures = extract(channel.id);
      expect(captures[0].tools.includes(docsTool)).toBe(entry.allowed);
      expect(JSON.stringify(captures[1].messages)).toContain(entry.allowed ? "MCP fixture evidence" : "policy_denied");
    }

  } finally { await rig.clean(); }
}, 15_000);

test("a real native turn with mixed owner and guest input denies MCP", async () => {
  const rig = await nativeRig();
  try {
    const capture = join(rig.directory, "mixed.jsonl");
    rig.env.HARNESS_TEST_REQUESTS = capture;
    rig.harness.config = configFor(rig.directory);
    const fixtureCall = { content: null, calls: [call(docsTool, "fixture")] };
    const extract = (id: string) => readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line))
      .filter(record => record.channel === id);
    // A running turn holds both pushes in the inbox until the harness can take them together.
    rig.script([hold("mixed", "hold"), fixtureCall, reply("mixed done")]);
    const mixedAgent = await rig.open();
    const mixed = await mixedAgent.conversations.create();
    const mixedHost = mixedAgent.nativeHarness!;
    const first = mixed.prompt({ text: "hold the first turn", nativePolicy: "owner" });
    await until(() => rig.effects().some(row => row.includes("mixed")), "a running turn blocks admission");
    await mixedHost.push({ id: "owner-input", channel: mixed.id, sender: "guest", text: "trusted owner contribution", policy: "owner" });
    await mixedHost.push({ id: "guest-input", channel: mixed.id, sender: "owner", text: "trusted guest contribution", policy: "guest" });
    expect((await mixedHost.status()).channels.find(channel => channel.channel === mixed.id)?.pending)
      .toEqual(["owner-input", "guest-input"]);
    rig.release("mixed");
    await first;
    await until(() => extract(mixed.id).length >= 3, "mixed turn and paired tool refusal");
    const captures = extract(mixed.id);
    expect(JSON.stringify(captures[1].messages)).toContain("trusted owner contribution");
    expect(JSON.stringify(captures[1].messages)).toContain("trusted guest contribution");
    expect(captures[1].turnId).toBe(captures[0].turnId);
    expect(captures[1].tools).not.toContain(docsTool);
    expect(JSON.stringify(captures[2].messages)).toContain("policy_denied");
  } finally { await rig.clean(); }
}, 15_000);

test("native MCP runtime headers enforce UTF-8 value and encoded total limits before sending", async () => {
  const secret = "private-fixture-header";
  const sent: unknown[] = [];
  const signal = new AbortController().signal;
  const send = async (material: unknown) => { sent.push(material); };
  const boundary = { web: { authorization: "é".repeat(1024) } };
  await executableMcpOpen(() => boundary, signal, send);
  for (const material of [
    { web: { authorization: secret + "é".repeat(1024) } },
    { web: Object.fromEntries(Array.from({ length: 5 }, (_, i) => ["header-" + i, secret + "x".repeat(1800)])) },
  ]) {
    try {
      await executableMcpOpen(() => material, signal, send);
      throw new Error("Expected oversized headers to be rejected");
    } catch (error) {
      expect(error).toMatchObject({ code: "mcp_runtime_headers_too_large" });
      expect(String(error)).not.toContain(secret);
    }
  }
  expect(sent).toEqual([boundary]);
});

test("native MCP does not send credentials when aborted while the provider is pending", async () => {
  const abort = new AbortController();
  const reason = new Error("Cancelled during material acquisition");
  const material = Promise.withResolvers<{ web: { authorization: string } }>();
  let sent = 0;
  const opened = executableMcpOpen(() => material.promise, abort.signal, async () => { sent++; });
  abort.abort(reason);
  material.resolve({ web: { authorization: "private-fixture-header" } });
  await expect(opened).rejects.toBe(reason);
  expect(sent).toBe(0);
});

test("native launcher redacts stderr when executable opens can carry MCP credentials", async () => {
  const marker = crypto.randomUUID();
  const observations: unknown[] = [];
  const connection = await launchNativeConnection({
    sessionId: "stderr-fixture", home: ".", config: configFor(process.cwd()),
    command: [process.execPath, "-e", "console.error(process.env.FIXTURE_STDERR_MARKER)"],
    env: { ...process.env, FIXTURE_STDERR_MARKER: marker },
    mcpRuntimeHeaders: () => ({ web: { authorization: marker } }),
  }, { debug() {}, info() {}, error() {}, warn(event, data) { observations.push({ event, data }); } });
  try {
    await connection.closed;
    await until(() => observations.length > 0, "stderr was observed");
    expect(observations).toContainEqual({ event: "native_harness_stderr", data: { redacted: true } });
    expect(JSON.stringify(observations)).not.toContain(marker);
  } finally { await connection.kill(); }
});

test("ACP object prompts reject a native policy before dispatch", async () => {
  const rig = await nativeRig();
  try {
    const peer = new URL("../fixtures/lifecycle-agent.ts", import.meta.url).pathname;
    const agent = await rig.open({
      adapters: { main: { command: [process.execPath, peer] } },
      conversationDefaults: { providerStart: "on_first_use", env: { LIFECYCLE_STATE: join(rig.directory, "sessions.json") } },
    });
    const channel = await agent.conversations.create();
    await expect(channel.prompt({ text: "ACP cannot carry this field", nativePolicy: "owner" }))
      .rejects.toThrow("nativePolicy requires a native conversation");
    expect(channel.connection.isConnected).toBe(false);
  } finally { await rig.clean(); }
});
