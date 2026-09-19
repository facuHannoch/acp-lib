#!/usr/bin/env bun

const sessionId = `identity-fixture-${crypto.randomUUID()}`;
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (raw) handle(JSON.parse(raw));
  }
});
process.stdin.resume();

function handle(message: any): void {
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0", id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? 1,
          agentCapabilities: { loadSession: true, promptCapabilities: {}, mcpCapabilities: {}, sessionCapabilities: {} },
          agentInfo: { name: "identity-fixture" },
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
      if (text.includes("FAIL_IDENTITY_TURN")) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "intentional identity fixture failure" } });
        return;
      }
      const observation = JSON.stringify({
        sawFirst: text.includes("SOURCE_FIRST_FACT"),
        sawNew: text.includes("SOURCE_NEW_FACT"),
        sawRetry: text.includes("SOURCE_RETRY_FACT"),
        hasSourceContext: text.includes("Source conversation agc-"),
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params?.sessionId ?? sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: observation } },
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
