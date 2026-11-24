for await (const line of console) {
  const request = JSON.parse(line);
  let result: unknown;
  if (request.method === "initialize") result = {
    protocolVersion: "2025-11-25", capabilities: { tools: {} },
    serverInfo: { name: "fixture", version: "1" },
  };
  if (request.method === "tools/list") result = { tools: [{ name: "read", inputSchema: { type: "object" } }] };
  if (request.method === "tools/call") result = { content: [{ type: "text", text: "MCP fixture evidence" }] };
  if (result) console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
