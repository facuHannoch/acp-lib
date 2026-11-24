#!/usr/bin/env bun
// A fake ACP agent that drives a tool call the way real agents do: announce it empty,
// run the command through the CLIENT's terminal, then fill the call in with
// tool_call_update. Exercises the terminal/* methods AND the update passthrough.

// Not exported — importing this file would start its stdin loop. The thinking test
// hardcodes the same chunks; keep them in step.
const THOUGHT_CHUNKS = ["let ", "me ", "check ", "that"];

let nextId = 1000;
const pending = new Map<number, (result: unknown) => void>();

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
  // A response to one of OUR requests (terminal/*).
  if (message.method === undefined && message.id != null) {
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message.error ? { __error: message.error } : message.result);
    }
    return;
  }

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
          agentInfo: { name: "fake-terminal-agent" },
        },
      });
      return;

    case "session/new":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: "sess-1", configOptions: [] },
      });
      return;

    case "session/prompt":
      await runTurn(message);
      return;

    default:
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `unknown method: ${message.method}` },
      });
  }
}

async function runTurn(message: any): Promise<void> {
  const sessionId = message.params?.sessionId ?? "sess-1";
  const update = (u: unknown) =>
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

  if (JSON.stringify(message.params?.prompt ?? "").includes("classify activity")) {
    update({
      sessionUpdate: "plan",
      entries: [{ content: "Run the requested tool", priority: "high", status: "in_progress" }],
    });
  }

  // 0. Thought chunks, but only when the prompt asks — the other tests pin an exact line
  //    sequence and thinking would add to it. Real agents stream a block a few words at a
  //    time (live Kimi: 8 notifications for one block), which is the shape the fold has to
  //    survive: many chunks in, one settled record out.
  if (JSON.stringify(message.params?.prompt ?? "").includes("think")) {
    for (const text of THOUGHT_CHUNKS) {
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
    }
  }

  // 1. The call is announced with nothing useful in it — this alone is what the old
  //    mapping forwarded, hence a tool block that renders as `{}`.
  update({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "Terminal",
    kind: "execute",
    status: "pending",
    rawInput: {},
  });

  // 2. Run the command through the client's terminal.
  const inspectEnv = JSON.stringify(message.params?.prompt).includes("inspect-terminal-environment");
  const created: any = await request("terminal/create", {
    sessionId,
    ...(inspectEnv ? { command: "/usr/bin/env", args: ["--"], env: [{ name: "AGENT_EXTRA", value: "untrusted" }], terminalEnv: { AGENT_OVERRIDE: "untrusted" } }
      : { command: "printf", args: ["hello from terminal"] }),
  });
  const terminalId = created?.terminalId;
  if (!terminalId) {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "NO_TERMINAL" } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }

  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "in_progress",
    rawInput: { command: "printf 'hello from terminal'" },
    content: [{ type: "terminal", terminalId }],
  });

  await request("terminal/wait_for_exit", { sessionId, terminalId });
  const out: any = await request("terminal/output", { sessionId, terminalId });

  // 3. Fill the call in. Note: no `title` — it must stay whatever it already was.
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: out?.output ?? "" } }],
    locations: [{ path: "/tmp/example.txt", line: 3 }],
  });
  await request("terminal/release", { sessionId, terminalId });

  // 4. An update kind the library does not model — must still reach the caller.
  update({ sessionUpdate: "some_future_update", payload: { hello: "world" } });
  update({
    sessionUpdate: "usage_update",
    used: 120,
    size: 200000,
    cost: { amount: 0.0125, currency: "USD" },
  });

  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: inspectEnv ? out?.output ?? "" : "done" } });
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });

}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
