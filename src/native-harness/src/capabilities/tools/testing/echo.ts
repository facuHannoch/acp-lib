import type { ExecuteTool, ToolDefinition } from "../../../contracts/loop.ts";

/** Test setup registers this explicitly; normal agent startup never does. */
export const echoDefinition: ToolDefinition = {
  name: "echo",
  description: "Return the supplied text unchanged. Available only in offline test scenarios.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
};

export const executeEcho: ExecuteTool = async call => {
  try {
    if (call.name !== "echo") throw new Error(`Tool not allowed in this test: ${call.name}`);
    const args = JSON.parse(call.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)
      || Object.keys(args).length !== 1 || typeof args.text !== "string") throw new Error("echo requires exactly one string argument: text");
    return JSON.stringify({ ok: true, text: args.text });
  } catch (error) { return JSON.stringify({ ok: false, error: String(error) }); }
};
