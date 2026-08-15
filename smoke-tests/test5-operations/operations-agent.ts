#!/usr/bin/env bun
// Deterministic ACP harness for operations-smoke.ts. Kept in a separate process entry
// so the consumer and its harness have one job each, matching the unit-test fixtures.

const label = process.argv[2] ?? "fake";
let buffer = "";
let nextThread = 1;
let currentSessionId: string | null = null;
const sessions = new Map<string, { seeded: boolean }>();
let advertisedUsage = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!raw) continue;
    handleMessage(JSON.parse(raw));
  }
});
process.stdin.resume();

function handleMessage(message: any): void {
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
              sessionCapabilities: { list: {}, resume: {}, fork: {} },
            },
            agentInfo: { name: "operations-fake", title: "Operations Fake ACP" },
          },
        });
        break;

      case "session/new": {
        currentSessionId = `${label}-thread-${nextThread++}`;
        sessions.set(currentSessionId, { seeded: false });
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: currentSessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [
                {
                  name: "status",
                  description: "Return deterministic fake status.",
                  input: null,
                },
              ],
            },
          },
        });
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { sessionId: currentSessionId, configOptions: [] },
        });
        break;
      }

      case "session/load": {
        const requested = String(message.params?.sessionId ?? "");
        currentSessionId = requested;
        if (!sessions.has(requested)) sessions.set(requested, { seeded: true });
        send({ jsonrpc: "2.0", id: message.id, result: { configOptions: [] } });
        break;
      }

      case "session/list":
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            sessions: [...sessions.keys()].map((sessionId) => ({
              sessionId,
              cwd: process.cwd(),
              title: `Fake ${sessionId}`,
            })),
          },
        });
        break;

      case "session/prompt": {
        const sessionId = String(message.params?.sessionId ?? currentSessionId ?? "unknown");
        const text = promptText(message.params?.prompt);
        if (label === "fail-seed" && text.startsWith("Continue this conversation")) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "deterministic continuation seed failure" },
          });
          break;
        }
        if (!advertisedUsage) {
          advertisedUsage = true;
          // A late notification for another session must never replace the active
          // command palette.
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "stale-session",
              update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [{ name: "stale", description: "Must be ignored." }],
              },
            },
          });
          const commandUpdate = {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "status", description: "Return deterministic fake status.", input: null },
              {
                name: "usage",
                description: "Return deterministic fake usage.",
                input: { hint: "optional scope" },
              },
            ],
          };
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: commandUpdate,
            },
          });
          // Identical semantic updates are legal and should not create duplicate
          // AgentSession notifications.
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId, update: commandUpdate },
          });
        }

        let reply: string;
        if (text === "/status") reply = `FAKE_STATUS ${sessionId}`;
        else if (text.startsWith("/usage")) reply = `FAKE_USAGE ${sessionId}`;
        else if (text.includes("portable continuation context")) {
          sessions.get(sessionId)!.seeded = true;
          reply = `CONTEXT_ACCEPTED ${sessionId}`;
        } else {
          reply = `FAKE_REPLY ${sessionId}: ${text}`;
        }

        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: reply },
            },
          },
        });
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            stopReason: "end_turn",
            usage: { inputTokens: 3, outputTokens: 5 },
          },
        });
        break;
      }

      case "session/cancel":
        break;

      default:
        if (message.id !== undefined) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `unknown method: ${message.method}` },
          });
        }
  }
}

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter((block): block is { type: "text"; text: string } =>
      block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
