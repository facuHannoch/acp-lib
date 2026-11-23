import type { ExecuteTool, ToolExecutionResult, ToolDefinition } from "../../../contracts/loop.ts";
import { debugArguments, debugFailure } from "./result.ts";

const maxBytes = 1024;
export const testEchoDefinition: ToolDefinition = {
  name: "test_echo",
  description: "Debug only. Return the supplied text exactly, up to 1024 UTF-8 bytes.",
  parameters: { type: "object", properties: { text: { type: "string", maxLength: maxBytes } },
    required: ["text"], additionalProperties: false },
};
export const testEcho: ExecuteTool<string | ToolExecutionResult> = async ({ arguments: raw }) => {
  const args = debugArguments(raw);
  if (!args || typeof args.text !== "string" || Object.keys(args).length !== 1 || Buffer.byteLength(args.text) > maxBytes)
    return debugFailure("invalid_arguments", "Expected only text, up to 1024 UTF-8 bytes.");
  return JSON.stringify({ ok: true, text: args.text });
};
