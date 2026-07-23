#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession, readTranscript } from "../../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));

if (process.argv.includes("--fake-agent")) {
  await runFakeAgent();
} else {
  await runSmokeTest();
}

async function runSmokeTest(): Promise<void> {
  const chatsDir = join(here, "chats");
  await mkdir(chatsDir, { recursive: true });

  const session = await AgentSession.create({
    adapter: {
      command: ["bun", fileURLToPath(import.meta.url), "--fake-agent"],
      displayName: "Fake ACP",
    },
    adapterId: "fake",
    agentSessionId: "smoke",
    transcriptDir: chatsDir,
  });
  const transcriptPath = join(chatsDir, "smoke.jsonl");

  try {
    const result = await session.prompt("hello transcript");
    console.log("result:", result.text);
    console.log("transcriptPath:", transcriptPath);
    console.log("messages:", JSON.stringify(await readTranscript(transcriptPath), null, 2));
  } finally {
    await session.stop();
  }
}

async function runFakeAgent(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!raw) continue;
      await handleMessage(JSON.parse(raw));
    }
  }
}

async function handleMessage(message: any): Promise<void> {
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
          agentInfo: { name: "fake-acp", title: "Fake ACP" },
        },
      });
      return;

    case "session/new":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessionId: "fake-internal-session-1",
          configOptions: [],
        },
      });
      return;

    case "session/prompt": {
      const sessionId = message.params?.sessionId ?? "fake-internal-session-1";
      const text = message.params?.prompt?.find((block: any) => block.type === "text")?.text ?? "";
      for (const chunk of ["fake reply to: ", text]) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: chunk },
            },
          },
        });
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 2, outputTokens: 4 },
        },
      });
      return;
    }

    default:
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `unknown method: ${message.method}` },
      });
  }
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
