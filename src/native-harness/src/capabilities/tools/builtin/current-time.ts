import type { ExecuteTool, ToolDefinition } from "../../../contracts/loop.ts";

export const currentTimeDefinition: ToolDefinition = {
  name: "current_time",
  description: "Get the current UTC date and time.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export const executeCurrentTime: ExecuteTool = async (call) => {
  console.log(`[tool] ${call.name} ${call.arguments}`);
  try {
    // The advertised schema is not an execution gate: reject unknown tools and
    // invalid arguments here even if the model was only shown this definition.
    if (call.name !== "current_time") throw new Error(`Tool not allowed: ${call.name}`);
    const args = JSON.parse(call.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) {
      throw new Error("current_time requires an empty object");
    }
    const result = JSON.stringify({ ok: true, time: new Date().toISOString() });
    console.log(`[result] ${result}`);
    return result;
  } catch (error) {
    // Expected tool failures go back to the model so it can choose what to do.
    const result = JSON.stringify({ ok: false, error: String(error) });
    console.log(`[result] ${result}`);
    return result;
  }
};
