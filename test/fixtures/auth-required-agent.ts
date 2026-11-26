#!/usr/bin/env bun
// An ACP agent that answers the handshake but refuses `session/new` until `authenticate` succeeds,
// like a harness whose user has not logged in. After `authenticate` it creates sessions normally and
// echoes prompts. Used to pin that a start whose session creation fails resolves without a context
// and leaves the connection usable.

let authenticated = false;
let counter = 0;
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
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? 1,
          agentCapabilities: { loadSession: false, promptCapabilities: {}, mcpCapabilities: {} },
          authMethods: [{ id: "fixture-login", name: "Fixture login", description: "Always succeeds" }],
          agentInfo: { name: "auth-required-fixture" },
        },
      });
      return;
    case "authenticate":
      authenticated = message.params?.methodId === "fixture-login";
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    case "session/new":
      if (!authenticated) {
        const detail = process.argv.includes("--startup-error-canary")
          ? { message: "Authentication required: startup-error-canary", data: { detail: "startup-error-canary" } }
          : { message: "Authentication required" };
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, ...detail } });
        return;
      }
      counter += 1;
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: `auth-fixture-session-${counter}` } });
      return;
    case "session/prompt": {
      const text = Array.isArray(message.params?.prompt)
        ? message.params.prompt.map((block: any) => block?.text ?? "").join("")
        : "";
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params?.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `authenticated reply to: ${text}` } },
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
