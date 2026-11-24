import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpTool } from "../../../contracts/mcp.ts";
import { acceptsMcpSchema, matchesMcpArguments, mcpToolName } from "./schema.ts";
import { projectMcpResult } from "./result.ts";
import { McpStdioTransport, type McpStdioProcess } from "./stdio.ts";

const supported = new Set(["2025-03-26", "2025-06-18", "2025-11-25"]);
const encoder = new TextEncoder();

export async function connectMcpStdio(name: string, child: McpStdioProcess, deadlineMs = 1_800_000) {
  let transport: McpStdioTransport<JSONRPCMessage> | undefined;
  const startup = AbortSignal.timeout(10_000);
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { ErrorCode, McpError, JSONRPCMessageSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const liveTransport = new McpStdioTransport<JSONRPCMessage>(child, supported, value => JSONRPCMessageSchema.parse(value));
    transport = liveTransport;
    const client = new Client({ name: "native-harness", version: "1" }, { capabilities: {} });
    let ready = true;
    const shutdown = new AbortController();
    client.onclose = () => { ready = false; };
    await client.connect(transport, { signal: startup, timeout: 10_000 });
    if (!client.getServerCapabilities()?.tools) throw new Error("MCP tools unavailable");
    const bindings = new Map<string, McpTool>();
    const cursors = new Set<string>();
    let bytes = 0;
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page === 4) throw new Error("MCP catalog exceeds page limit");
      const list = await client.listTools(cursor === undefined ? undefined : { cursor }, { signal: startup, timeout: 10_000 });
      for (const remote of list.tools) {
        const key = mcpToolName(name, remote.name);
        const schema = remote.inputSchema;
        if (!key || bindings.has(key) || bindings.size === 32 || !acceptsMcpSchema(schema)) throw new Error("Invalid MCP tool catalog");
        const definition = { name: key, description: remote.description ?? "", parameters: schema };
        bytes += encoder.encode(JSON.stringify(definition)).length;
        if (bytes > 128 * 1024) throw new Error("MCP catalog exceeds byte limit");
        bindings.set(key, {
          definition,
          available: () => ready,
          accepts: args => encoder.encode(JSON.stringify(args)).length <= 16 * 1024 && matchesMcpArguments(schema, args),
          async call(args, signal) {
            const fail = (code: string) => ({ content: JSON.stringify({ ok: false, code }), code });
            if (!ready) return fail("tool_unavailable");
            if (signal.aborted) return fail("tool_interrupted");
            try {
              const result = await client.callTool({ name: remote.name, arguments: args }, undefined, {
                timeout: deadlineMs, signal: AbortSignal.any([signal, shutdown.signal]), resetTimeoutOnProgress: false, onprogress() {},
              });
              if (result.isError) return fail("mcp_tool_error");
              if (!Array.isArray(result.content)) return fail("mcp_protocol_error");
              return { content: projectMcpResult(result as Parameters<typeof projectMcpResult>[0]) };
            } catch (error) {
              if (signal.aborted) return fail("tool_interrupted");
              if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return fail("tool_timeout");
              return fail(ready && error instanceof McpError && error.code !== ErrorCode.ConnectionClosed
                ? "mcp_protocol_error" : "mcp_uncertain");
            }
          },
        });
      }
      cursor = list.nextCursor;
      if (cursor === undefined) break;
      if (cursors.has(cursor)) throw new Error("MCP catalog cursor repeated");
      cursors.add(cursor);
    }
    return { name, bindings, bytes, available: () => ready, async close() {
      shutdown.abort();
      await liveTransport.drain();
      await client.close();
    } };
  } catch {
    await (transport?.close() ?? child.close());
    throw new Error("MCP stdio initialization failed");
  }
}
