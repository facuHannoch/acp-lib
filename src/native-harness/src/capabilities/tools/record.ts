import { appendFileSync } from "node:fs";
import type { ExecuteTool, ToolDefinition } from "../../contracts/loop.ts";

/** Offline scenarios only: a tool with an effect outside the session, so a test
 * can count how many times a call really ran across process restarts. */
export const recordDefinition: ToolDefinition = {
  name: "record",
  description: "Append the supplied text as one line to the scenario's effect log. Available only in offline test scenarios.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
};

export function createRecordTool(path: string | undefined): ExecuteTool {
  return async call => {
    try {
      const args = JSON.parse(call.arguments);
      if (!args || typeof args !== "object" || typeof args.text !== "string" || Object.keys(args).length !== 1) throw new Error("record requires exactly one string argument: text");
      if (!path) throw new Error("No effect log is configured for this scenario");
      appendFileSync(path, `${args.text}\n`);
      return JSON.stringify({ ok: true });
    } catch (error) { return JSON.stringify({ ok: false, error: String(error) }); }
  };
}
