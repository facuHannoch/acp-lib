#!/usr/bin/env bun

let model = "alpha";
let loaded = false;
let rejectedLoadedBeta = false;

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function configOptions() {
  return [{
    id: "model",
    name: "Model",
    type: "select",
    currentValue: model,
    options: [
      { value: "alpha", name: "Alpha" },
      { value: "beta", name: "Beta" },
    ],
  }];
}

function handle(message: any): void {
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? 1,
          agentCapabilities: { loadSession: true, promptCapabilities: {}, mcpCapabilities: {}, sessionCapabilities: {} },
          agentInfo: { name: "config-agent" },
        },
      });
      return;
    case "session/new":
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "config-session", configOptions: configOptions() } });
      return;
    case "session/load":
      if (process.env.FAIL_LOAD === "1" || message.params?.sessionId === "missing-session") {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32011, message: "session not found" } });
        return;
      }
      loaded = true;
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { configOptions: process.env.OMIT_CONFIG === "1" ? [] : configOptions() },
      });
      return;
    case "session/set_config_option":
      if (
        loaded && process.env.REJECT_FIRST_LOADED_BETA === "1" &&
        message.params?.value === "beta" && !rejectedLoadedBeta
      ) {
        rejectedLoadedBeta = true;
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32012, message: "first restored beta rejected" } });
        return;
      }
      if (message.params?.value === "reject") {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32010, message: "selection rejected" } });
        return;
      }
      model = String(message.params?.value ?? "");
      send({ jsonrpc: "2.0", id: message.id, result: { configOptions: configOptions() } });
      return;
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
