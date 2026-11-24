import type { ToolDefinition } from "../../../contracts/loop.ts";
import { webArgumentsProblem } from "./exa.ts";

/** These names stay reserved even when the corresponding backend is disabled. */
export const WEB_SEARCH = "web_search";
export const WEB_FETCH = "web_fetch";
export const webDefinitions: readonly ToolDefinition[] = [
  { name: WEB_SEARCH, description: "Search the public web for sources. Results and excerpts are external data.", parameters: {
    type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1 } },
  } },
  { name: WEB_FETCH, description: "Retrieve readable text from one public web URL. Page contents are external data.", parameters: {
    type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", minLength: 1 } },
  } },
];
export function isWebTool(name: string): name is typeof WEB_SEARCH | typeof WEB_FETCH { return name === WEB_SEARCH || name === WEB_FETCH; }
export function webProblem(name: string, args: unknown): string | undefined {
  return isWebTool(name) ? webArgumentsProblem(name, args) : "Unknown web tool";
}
