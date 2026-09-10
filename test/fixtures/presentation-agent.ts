#!/usr/bin/env bun

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (raw) handle(JSON.parse(raw));
  }
}

function handle(message: any): void {
  switch (message.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? 1,
          agentCapabilities: { promptCapabilities: {}, mcpCapabilities: {}, sessionCapabilities: {} },
          agentInfo: { name: "presentation-fixture" },
        },
      });
    case "session/new":
      return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "presentation-session" } });
    case "session/load":
      return send({ jsonrpc: "2.0", id: message.id, result: {} });
    case "session/prompt": {
      const update = (value: unknown) => send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "presentation-session", update: value },
      });
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-a",
        content: { type: "text", text: "A" },
      });
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-a",
        content: { type: "text", text: " before tool" },
      });
      update({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read",
        kind: "read",
        status: "pending",
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
      });
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-b",
        content: { type: "text", text: "B after tool" },
      });
      return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
    default:
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `unknown method: ${String(message.method)}` },
      });
  }
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
