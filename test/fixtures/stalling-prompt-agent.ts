#!/usr/bin/env bun

// Emits one assistant chunk, then deliberately never finishes the prompt. The
// transport closing the process is the only way the pending prompt can settle.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!raw) continue;
    const message = JSON.parse(raw) as { id?: number; method?: string; params?: { sessionId?: string } };
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: {}, mcpCapabilities: {}, sessionCapabilities: {} },
        agentInfo: { name: "stalling-prompt-fixture" },
      } });
    } else if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stalling-session" } });
    } else if (message.method === "session/prompt") {
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: message.params?.sessionId ?? "stalling-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial reply" } },
      } });
      // Intentionally omit the prompt response.
    }
  }
});
process.stdin.resume();

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
