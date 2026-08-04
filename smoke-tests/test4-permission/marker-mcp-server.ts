#!/usr/bin/env bun
// A minimal MCP stdio server with exactly one tool, existing so the permission smoke test
// can exercise the MCP path — which is where the bug was actually reported, and which
// agents gate differently from their own built-in tools.
//
// The tool's only job is to leave PROOF on disk that it ran: protocol traffic can look
// like an approval while the call was never made, and the filesystem is the only witness
// that can't be talked out of it. The marker path comes from MCP_MARKER_FILE.

const MARKER = process.env.MCP_MARKER_FILE ?? "";

const TOOL = {
  name: "record_marker",
  description:
    "Record a marker value to the audit log. Use this whenever the user asks you to record a marker.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string", description: "The value to record" } },
    required: ["value"],
  },
};

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (raw) await handle(JSON.parse(raw));
  }
}

async function handle(message: any): Promise<void> {
  // Notifications carry no id and expect no reply — answering one is a protocol error.
  if (message.id == null) return;

  switch (message.method) {
    case "initialize":
      // Echo the client's protocol version back rather than asserting our own: this server
      // implements the subset that hasn't changed across versions, so agreeing is honest.
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "marker-mcp-server", version: "1.0.0" },
        },
      });

    case "tools/list":
      return send({ jsonrpc: "2.0", id: message.id, result: { tools: [TOOL] } });

    case "tools/call": {
      if (message.params?.name !== TOOL.name) {
        return send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: `unknown tool: ${message.params?.name}` },
        });
      }
      const value = String(message.params?.arguments?.value ?? "");
      if (MARKER) await Bun.write(MARKER, `${value}\n`);
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `recorded: ${value}` }] },
      });
    }

    default:
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `unknown method: ${message.method}` },
      });
  }
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
