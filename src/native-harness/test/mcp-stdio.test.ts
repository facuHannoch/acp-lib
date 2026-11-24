import { expect, test } from "bun:test";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { McpStdioTransport } from "../src/capabilities/tools/mcp/stdio.ts";
import { spawnMcpStdio } from "../src/runtime/execution/mcp-stdio.ts";
import { acceptsMcpSchema, matchesMcpArguments, mcpToolName } from "../src/capabilities/tools/mcp/schema.ts";

test("runner-owned MCP streams keep stderr separate and reap on close", async () => {
  const process = spawnMcpStdio({
    command: Bun.argv[0]!,
    args: ["-e", 'for await (const line of console) { console.error("fixture diagnostic"); console.log(line); }'],
    env: {},
  });
  const transport = new McpStdioTransport<{ id: number }>(process);
  const events = new EventEmitter();
  transport.onmessage = message => events.emit("message", message);
  try {
    await transport.start();
    const response = once(events, "message", { signal: AbortSignal.timeout(2000) });
    await transport.send({ id: 7 });
    expect(await response).toEqual([{ id: 7 }]);
  } finally {
    await transport.close();
  }
  await expect(transport.send({ id: 8 })).rejects.toThrow("closed");
});

test("MCP stdio rejects oversized partial frames before parsing", async () => {
  let cleanups = 0;
  const events = new EventEmitter();
  const transport = new McpStdioTransport({
    stdout: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); } }),
    async write() {},
    async close() { cleanups++; },
  });
  transport.onclose = () => events.emit("closed");
  const closed = once(events, "closed");
  await transport.start();
  await closed;
  expect(cleanups).toBe(1);
});

test("MCP schema rejects unsupported keywords and validates registered arguments", () => {
  const schema = { type: "object", properties: { mode: { type: "string", enum: ["one"] } }, required: ["mode"], additionalProperties: false };
  expect(acceptsMcpSchema({ ...schema, anyOf: [] })).toBe(false);
  expect(acceptsMcpSchema(schema)).toBe(true);
  if (!acceptsMcpSchema(schema)) throw new Error("Invalid fixture");
  expect(matchesMcpArguments(schema, { mode: "one" })).toBe(true);
  expect(matchesMcpArguments(schema, { mode: "two" })).toBe(false);
  expect(matchesMcpArguments(schema, { mode: "one", extra: 1 })).toBe(false);
  expect(mcpToolName("issues", "é")).toBe("mcp__issues__c3a9");
});

test("MCP projection keeps valid bounded JSON and omits unsupported payloads", async () => {
  const { projectMcpResult } = await import("../src/capabilities/tools/mcp/result.ts");
  const value = projectMcpResult({
    content: [{ type: "text", text: "😀".repeat(2048) }, { type: "image", text: "fixture secret" }],
    structuredContent: { payload: "x".repeat(4000) },
  });
  expect(Buffer.byteLength(value)).toBeLessThanOrEqual(2048);
  expect(value).not.toContain("fixture secret");
  expect(JSON.parse(value)).toMatchObject({ omittedContentBlocks: 1, truncated: true, structuredContent: null });
  expect(JSON.parse(value).text).toMatch(/^(?:😀)+$/u);
});

test("portable MCP configuration keeps declarations and policy denies mixed work", async () => {
  const { validateManagedConfig } = await import("../src/util/config.ts");
  const { policyFingerprint, toolDecision } = await import("../src/governance/policy/resolve.ts");
  const input = {
    version: 1, system: "", model: { protocol: "scripted", script: "fixture" }, defaultPolicy: "guest",
    policies: { owner: { fallback: "deny", tools: {}, mcp: "allow" }, guest: { fallback: "allow", tools: {} } },
    mcpServers: { docs: { transport: "http", endpoint: "https://example.com/mcp", headers: { Authorization: { runtime: true } } } },
  };
  const config = validateManagedConfig(input);
  expect(validateManagedConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
  expect(config.mcpServers?.docs).toMatchObject({ headers: { authorization: { runtime: true } } });
  expect(toolDecision(config, ["owner"], "mcp__docs__78")).toBe("allow");
  expect(toolDecision(config, ["owner", "guest"], "mcp__docs__78")).toBe("deny");
  expect(toolDecision(config, ["guest"], "mcp__docs__78")).toBe("deny");
  expect(policyFingerprint(config, ["guest"])).toBe('[["guest","allow",[]]]');
  expect(() => validateManagedConfig({ ...input, mcpRuntimeHeaders: { docs: { authorization: "secret" } } })).toThrow();
  expect(() => validateManagedConfig({ ...input, mcpServers: { docs: { ...input.mcpServers.docs,
    headers: { Authorization: { runtime: true, literal: "secret" } },
  } } })).toThrow();
});

test("MCP redaction refuses schema changes and ambiguous secret-bearing object keys", async () => {
  const { mcpSecrets } = await import("../src/capabilities/tools/mcp/secrets.ts");
  const credential = crypto.randomUUID();
  const redactor = mcpSecrets([credential]);
  expect(redactor.text(`prefix ${credential} suffix`)).toBe("prefix [redacted] suffix");
  expect(() => redactor.tree({ nested: [{ [credential]: true }] })).toThrow();
  expect(() => redactor.tree({ type: "string", enum: [credential] }, true)).toThrow();
});
