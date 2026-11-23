import { setTimeout } from "node:timers/promises";
import type { ExecuteTool, ToolExecutionResult, ToolDefinition } from "../../../contracts/loop.ts";
import { debugArguments, debugFailure } from "./result.ts";

export const testWaitDefinition: ToolDefinition = {
  name: "test_wait",
  description: "Debug only. Hold this tool call for the requested duration so another channel can send input or the operator can interrupt. Performs no external work.",
  parameters: { type: "object", properties: { durationMs: { type: "integer", minimum: 1, maximum: 30_000 } },
    required: ["durationMs"], additionalProperties: false },
};
export const testWait: ExecuteTool<string | ToolExecutionResult> = async ({ arguments: raw }, signal) => {
  const args = debugArguments(raw);
  const durationMs = args?.durationMs;
  if (!args || typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 30_000 || Object.keys(args).length !== 1)
    return debugFailure("invalid_arguments", "Expected only durationMs, an integer between 1 and 30000.");
  signal?.throwIfAborted();
  await setTimeout(durationMs, undefined, { signal });
  return JSON.stringify({ ok: true, durationMs });
};
