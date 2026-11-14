import { createInterface } from "node:readline/promises";
import type { ExecuteTool, Message, ToolDefinition } from "../contracts/loop.ts";
import { runTurn } from "../kernel/loop.ts";
import { openRouter } from "../model/openrouter.ts";

const systemPrompt = "You are a helpful assistant. Use tools when needed.";
const messages: Message[] = [{ role: "system", content: systemPrompt }];
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

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY before starting the REPL.");
  process.exit(1);
}
const model = openRouter(apiKey, process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4.1-flash");
const terminal = createInterface({ input: process.stdin, output: process.stdout });
console.log("Native harness REPL. Type /exit to quit. History stays in memory.");
try {
  while (true) {
    let prompt: string;
    try { prompt = await terminal.question("> "); }
    catch { break; }
    if (prompt.trim() === "/exit") break;
    if (!prompt.trim()) continue;
    console.log(await runTurn(messages, prompt, model, tools, executeTool));
  }
} catch (error) {
  // Stop rather than reuse a possibly incomplete tool exchange.
  console.error(String(error));
  process.exitCode = 1;
} finally {
  terminal.close();
}
