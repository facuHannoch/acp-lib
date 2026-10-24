#!/usr/bin/env bun
// Replies with the exact provider text it received, so tests can assert prompt composition.
// `FAIL_TURN` fails the prompt; `SLOW_TURN` waits before replying.

const sessionId = `echo-fixture-${crypto.randomUUID()}`;
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (raw) void handle(JSON.parse(raw));
  }
});
process.stdin.resume();

async function handle(message: any): Promise<void> {
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0", id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true }, mcpCapabilities: {}, sessionCapabilities: {} },
          agentInfo: { name: "echo-prompt-fixture" },
        },
      });
      return;
    case "session/new":
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId, configOptions: [] } });
      return;
    case "session/load":
      send({ jsonrpc: "2.0", id: message.id, result: { configOptions: [] } });
      return;
    case "session/prompt": {
      const text = Array.isArray(message.params?.prompt)
        ? message.params.prompt.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("")
        : "";
      if (text.includes("FAIL_TURN")) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "intentional echo fixture failure" } });
        return;
      }
      if (text.includes("SLOW_TURN")) await new Promise((resolve) => setTimeout(resolve, 400));
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params?.sessionId ?? sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ prompt: text, blocks: message.params.prompt }) } },
        },
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method: ${message.method}` } });
      }
  }
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
