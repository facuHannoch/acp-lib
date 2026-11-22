#!/usr/bin/env bun
// A fake ACP agent whose whole job is to ask for permission and report what came back.
// The PROMPT TEXT names which option set to offer: agents order their options differently
// and the ORDER is the point — the client must choose by `kind`, never by position.
//
// The outcome the client sent is echoed back as the turn's message text, so tests assert
// on what the agent actually received over the wire rather than on library internals.

/** Option sets keyed by prompt text. Shapes taken from real agents. */
const OPTION_SETS: Record<string, Array<{ optionId: string; name: string; kind: string }>> = {
  // Claude's ordering: reject FIRST. Picking `options[0]` here turned an auto-approving
  // client into "User refused permission" — the regression this fixture exists for.
  "reject-first": [
    { optionId: "reject", name: "No", kind: "reject_once" },
    { optionId: "allow", name: "Yes", kind: "allow_once" },
    { optionId: "always", name: "Yes, and don't ask again", kind: "allow_always" },
  ],
  "allow-first": [
    { optionId: "allow", name: "Yes", kind: "allow_once" },
    { optionId: "reject", name: "No", kind: "reject_once" },
  ],
  // The only way to say yes is a DURABLE grant that outlives the session.
  "always-only": [
    { optionId: "reject", name: "No", kind: "reject_once" },
    { optionId: "always", name: "Always", kind: "allow_always" },
  ],
  // Nothing to say yes with at all.
  "reject-only": [
    { optionId: "reject", name: "No", kind: "reject_once" },
    { optionId: "never", name: "Never", kind: "reject_always" },
  ],
  empty: [],
};

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
          agentInfo: { name: "fake-permission-agent" },
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

  const key = promptText(message.params?.prompt).trim();
  const options = OPTION_SETS[key] ?? OPTION_SETS["reject-first"]!;

  // Announce the call first, the way a real agent does — permission is always ABOUT
  // something the client has already been told exists.
  update({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "Write config.json",
    kind: "edit",
    status: "pending",
    rawInput: {},
  });

  const response: any = await request("session/request_permission", {
    sessionId,
    toolCall: key === "execute"
      ? { toolCallId: "call-1", title: "Run tests", kind: "execute", rawInput: { command: "bun test" } }
      : { toolCallId: "call-1", title: "Write config.json" },
    options,
  });

  // Echo what we got. `__error` means the client failed the request outright, which is a
  // distinct failure from being refused, and the tests need to tell them apart.
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: JSON.stringify(response?.outcome ?? response ?? null) },
  });
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
}

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block: any) => (block?.type === "text" ? String(block.text ?? "") : ""))
    .join("");
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
