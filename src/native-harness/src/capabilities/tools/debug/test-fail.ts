import type { ExecuteTool, ToolExecutionResult, ToolDefinition } from "../../../contracts/loop.ts";
import { debugArguments, debugFailure } from "./result.ts";

export const testFailDefinition: ToolDefinition = {
  name: "test_fail",
  description: "Debug only. Return an intentional typed failure and let the turn continue.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export const testFail: ExecuteTool<ToolExecutionResult> = async ({ arguments: raw }) => {
  const args = debugArguments(raw);
  if (!args || Object.keys(args).length)
    return debugFailure("invalid_arguments", "Expected an empty object.");
  return debugFailure("debug_failure", "Intentional test failure.");
};
