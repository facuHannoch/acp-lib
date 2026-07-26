#!/usr/bin/env bun
// Writes a tool_call, a session/request_permission and a tool_call_update as ONE chunk,
// so the client sees all three lines in a single read. Probes how notifications (which
// the transport intercepts) interleave with requests (which go through the SDK).

// Declared before the read loop: the loop never returns, so anything declared after it
// would still be in its temporal dead zone when a message arrives.
let resolvePermission: (() => void) | undefined;
let promptId: unknown;

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (raw) void handle(JSON.parse(raw));
  }
}

async function handle(message: any): Promise<void> {
  if (message.method === undefined && message.id != null) {
    resolvePermission?.(); // the client answered session/request_permission
    return;
  }

  switch (message.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? 1,
          agentCapabilities: { promptCapabilities: {}, mcpCapabilities: {}, sessionCapabilities: {} },
          agentInfo: { name: "fake-permission-agent" },
        },
      });

    case "session/new":
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: "sess-1", configOptions: [] },
      });

    case "session/prompt": {
      promptId = message.id;
      const update = (u: unknown) => line({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "sess-1", update: u },
      });

      const answered = new Promise<void>((r) => (resolvePermission = r));

      // One write: update, request, update — in that wire order.
      process.stdout.write(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "Bash",
          kind: "execute",
          status: "pending",
        }) +
          line({
            jsonrpc: "2.0",
            id: 900,
            method: "session/request_permission",
            params: {
              sessionId: "sess-1",
              toolCall: { toolCallId: "call-1", title: "Bash" },
              options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
            },
          }) +
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            status: "in_progress",
          }),
      );

      await answered;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" },
        },
      });
      return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    }

    default:
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `unknown method: ${message.method}` },
      });
  }
}

function line(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function send(message: unknown): void {
  process.stdout.write(line(message));
}
