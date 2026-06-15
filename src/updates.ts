// Maps raw session/update notifications into our output-contract types.
// `agent_message_chunk` → response text; everything else → ActivityEvent.
// See SPEC.md "Protocol facts": all agent→client events are session/update,
// discriminated by `sessionUpdate`.

import type * as schema from "@agentclientprotocol/sdk";
import type { ActivityEvent, PlanEntry } from "./types.ts";

/** Response text from an agent_message_chunk, or "" for any other update. */
export function extractChunkText(update: schema.SessionUpdate): string {
  const u = update as Record<string, any>;
  if (u.sessionUpdate !== "agent_message_chunk") return "";
  const content = u.content;
  return content?.type === "text" ? (content.text ?? "") : "";
}

/** Map an update to an ActivityEvent, or null if it carries no observable activity. */
export function toActivityEvent(update: schema.SessionUpdate): ActivityEvent | null {
  const u = update as Record<string, any>;
  switch (u.sessionUpdate) {
    case "agent_thought_chunk": {
      const text = u.content?.type === "text" ? (u.content.text ?? "") : "";
      return text ? { kind: "thinking", text } : null;
    }
    case "tool_call":
      return {
        kind: "tool",
        toolCallId: u.toolCallId,
        title: u.title,
        toolKind: u.kind ?? "other",
        status: u.status ?? "pending",
        rawInput: u.rawInput ?? undefined,
      };
    case "tool_call_update":
      return {
        kind: "tool_update",
        toolCallId: u.toolCallId,
        status: u.status ?? "in_progress",
      };
    case "plan":
      return { kind: "plan", entries: (u.entries ?? []) as PlanEntry[] };
    default:
      return null;
  }
}
