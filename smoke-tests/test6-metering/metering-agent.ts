#!/usr/bin/env bun
// A fake ACP agent for the metering persistence contract.
//
// Reports cumulative `PromptResponse.usage` per the ACP field docs, and — critically for
// this test — keeps counting across session/load. That is what makes the restore case
// meaningful: without the restored baseline, the first post-reopen operation would
// attribute the entire cumulative total instead of its own delta.
//
// Cumulative counters: each turn adds 100 total (60 input, 40 output, 10 cached read).

const SESSION_ID = "metering-sess-1";

// A real harness resuming a thread continues its cumulative counters; a fresh subprocess
// would restart them, which the library correctly reads as a counter reset. `--resume=N`
// models the persistence a resumed provider thread actually has.
const resumeArg = process.argv.find((arg) => arg.startsWith("--resume="));
let turn = resumeArg ? Number(resumeArg.slice("--resume=".length)) : 0;

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function update(u: unknown): void {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION_ID, update: u } });
}

function handle(message: any): void {
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {},
            mcpCapabilities: {},
            sessionCapabilities: {},
          },
          agentInfo: { name: "fake-metering-agent" },
        },
      });
      return;

    case "session/load":
      // Resume the same thread; counters keep going, they do not restart.
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;

    case "session/new":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessionId: SESSION_ID,
          configOptions: [
            { id: "model", name: "Model", type: "select", currentValue: "claude-sonnet-4-5" },
          ],
        },
      });
      // Outside any turn: only a session-scoped subscription can observe this.
      update({
        sessionUpdate: "usage_update",
        used: 8,
        size: 200000,
        cost: { amount: 0.001, currency: "USD" },
      });
      return;

    case "session/prompt": {
      turn += 1;
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
      update({ sessionUpdate: "usage_update", used: 100 * turn, size: 200000 });
      const noUsage = JSON.stringify(message.params?.prompt ?? "").includes("no-usage");
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          stopReason: "end_turn",
          // Cumulative across the session, per the ACP field docs.
          ...(noUsage
            ? {}
            : {
                usage: {
                  totalTokens: 100 * turn,
                  inputTokens: 60 * turn,
                  outputTokens: 40 * turn,
                  cachedReadTokens: 10 * turn,
                },
              }),
        },
      });
      return;
    }

    default:
      send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf("\n");
  }
});
