import { appendFileSync, existsSync } from "node:fs";
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

/** Offline scenarios only: a tool a test can keep running. It logs `start:<key>`,
 * waits until the file `<log>.release-<key>` exists, then logs `done:<key>`.
 * Cancellation rejects without logging `done`. */
export const holdDefinition: ToolDefinition = {
  name: "hold",
  description: "Wait until the scenario releases the named key. Available only in offline test scenarios.",
  parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
};

export function createHoldTool(path: string | undefined): ExecuteTool {
  return async (call, signal) => {
    const args = JSON.parse(call.arguments);
    if (!path || typeof args?.key !== "string" || !/^[a-z0-9-]+$/.test(args.key)) return JSON.stringify({ ok: false, error: "hold requires a key and a configured effect log" });
    appendFileSync(path, `start:${args.key}\n`);
    while (!existsSync(`${path}.release-${args.key}`)) {
      signal?.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    // Released and cancelled in the same instant still counts as cancelled.
    signal?.throwIfAborted();
    appendFileSync(path, `done:${args.key}\n`);
    return JSON.stringify({ ok: true });
  };
}
