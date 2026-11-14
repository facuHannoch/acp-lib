import { createInterface } from "node:readline/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecuteTool, ToolDefinition } from "../contracts/loop.ts";
import { runTurn } from "../kernel/loop.ts";
import { createAgent } from "../kernel/agent.ts";
import { openRouter } from "../model/openrouter.ts";
import { sendLocal, serveLocal } from "../src/interfaces/protocol/local.ts";

const systemPrompt = "You are a helpful assistant. Use tools when needed.";
const tools: ToolDefinition[] = [{
  name: "current_time",
  description: "Get the current UTC date and time.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
}];

const executeTool: ExecuteTool = async (call) => {
  console.log(`[tool] ${call.name} ${call.arguments}`);
  try {
    // Only this explicitly configured, harmless tool is allowed.
    if (call.name !== "current_time") throw new Error(`Tool not allowed: ${call.name}`);
    const args = JSON.parse(call.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) {
      throw new Error("current_time requires an empty object");
    }
    const result = JSON.stringify({ ok: true, time: new Date().toISOString() });
    console.log(`[result] ${result}`);
    return result;
  } catch (error) {
    const result = JSON.stringify({ ok: false, error: String(error) });
    console.log(`[result] ${result}`);
    return result;
  }
};

const socketDirectory = join(tmpdir(), `native-harness-${process.getuid?.() ?? "local"}`);
const socketPath = process.env.HARNESS_SOCKET ?? join(socketDirectory, "agent.sock");
const command = process.argv[2];

async function main() {
  if (command === "start") {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("Set OPENROUTER_API_KEY before starting the agent.");
    if (!process.env.HARNESS_SOCKET) await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
    const model = openRouter(apiKey, process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4.1-flash");
    const agent = createAgent(systemPrompt, (messages, input) => runTurn(
      messages,
      `Participant: ${JSON.stringify(input.participantId)}\n\n${input.text}`,
      model, tools, executeTool,
    ));
    // Restrict the socket itself as well as the default parent directory.
    process.umask(0o077);
    const server = serveLocal(agent, socketPath);
    console.log(`Agent listening at ${socketPath}. Ctrl+C stops it and clears all history.`);
    const stop = () => { server.stop(true); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  if (command !== "chat" || !process.argv[3] || !process.argv[4]) {
    throw new Error("Usage: start | chat <channelId> <participantId>");
  }
  const channelId = process.argv[3];
  const participantId = process.argv[4];
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Channel ${channelId}, participant ${participantId}. Type /exit to disconnect.`);
  try {
    while (true) {
      let text: string;
      try { text = await terminal.question("> "); }
      catch { break; }
      if (text.trim() === "/exit") break;
      if (!text.trim()) continue;
      try { console.log(await sendLocal(socketPath, { channelId, participantId, text })); }
      catch (error) { console.error(String(error)); }
    }
  } finally { terminal.close(); }
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
