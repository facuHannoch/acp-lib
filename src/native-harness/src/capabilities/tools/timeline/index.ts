import { SESSION_INPUT_MAX_BYTES } from "../../../contracts/input-limits.ts";
import type { TimelineRetrievalReads } from "../../../contracts/storage.ts";
import type { TimelineSearch, TimelineWindow } from "../../../contracts/timeline-retrieval.ts";
import type { ToolDefinition } from "../../../contracts/loop.ts";
import { timelineQuery } from "../../../util/timeline-text.ts";
import { timelineToolNames } from "../../../util/timeline-tool-names.ts";
import { schemaProblem } from "../../../util/schema.ts";

const [search, read] = timelineToolNames;
const text = { type: "string", minLength: 1 };
const count = { type: "integer", minimum: 0, maximum: 20 };
export const timelineDefinitions: readonly ToolDefinition[] = [
  { name: search, description: "Find earlier attributed text in the shared session timeline.", parameters: {
    type: "object", required: ["query"], additionalProperties: false, properties: {
      query: text, channel: text, match: { enum: ["keywords", "phrase"] }, case_sensitive: { type: "boolean" },
    },
  } },
  { name: read, description: "Read an attributed timeline message and optional same-channel neighbors.", parameters: {
    type: "object", required: ["message_id"], additionalProperties: false, properties: {
      message_id: text, before: count, after: count, cursor: text,
    },
  } },
];

export function timelineArgumentsProblem(name: string, args: unknown): string | undefined {
  const definition = timelineDefinitions.find(tool => tool.name === name)!;
  const problem = schemaProblem(definition.parameters, args);
  if (problem) return problem;
  const value = args as Record<string, unknown>;
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string" && (!field.trim() || Buffer.byteLength(field) > (key === "cursor" ? 32768 : key === "query" ? 1024 : SESSION_INPUT_MAX_BYTES))) return `Invalid ${key}`;
  }
  if (name === search && !timelineQuery(args as TimelineSearch)) return "Query requires searchable words within timeline limits";
  return undefined;
}

export function runTimelineTool(store: TimelineRetrievalReads, name: string, args: unknown, signal?: AbortSignal): string {
  signal?.throwIfAborted();
  const result = name === search ? store.searchTimeline(args as TimelineSearch, 8192) : store.readMessage(args as TimelineWindow, 8192);
  return JSON.stringify(result.ok ? result.value : { ok: false, ...result.error });
}
