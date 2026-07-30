// Maps raw session/update notifications into our output-contract types.
// `agent_message_chunk` → response text; everything else → ActivityEvent.
// See SPEC.md "Protocol facts": all agent→client events are session/update,
// discriminated by `sessionUpdate`.
//
// Two rules govern this file:
//   1. NOTHING is dropped. An update we don't model becomes `{kind:"unknown", raw}`.
//   2. On tool_call_update, absent/null means UNCHANGED — never invent a value. The
//      caller merges updates onto the tool call it already has.

import type * as schema from "@agentclientprotocol/sdk";
import type {
  ActivityEvent,
  AgentCommand,
  ContentBlock,
  PlanEntry,
  ToolActivity,
  ToolContent,
  ToolLocation,
  ToolUpdateActivity,
} from "./types.ts";

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
    // The response text itself — delivered through onChunk, not as activity.
    case "agent_message_chunk":
      return null;

    // `messageId` is optional in ContentChunk but authoritative when present: "a change
    // in messageId indicates a new message has started". It is the only protocol-given
    // way to bound a thinking block, so carry it through.
    case "agent_thought_chunk": {
      const text = blockText(u.content);
      if (!text) return null;
      return u.messageId != null
        ? { kind: "thinking", text, messageId: String(u.messageId) }
        : { kind: "thinking", text };
    }

    case "user_message_chunk": {
      const text = blockText(u.content);
      if (!text) return null;
      return u.messageId != null
        ? { kind: "user_message", text, messageId: String(u.messageId) }
        : { kind: "user_message", text };
    }

    case "tool_call": {
      const event: ToolActivity = {
        kind: "tool",
        toolCallId: u.toolCallId,
        toolKind: u.kind ?? "other",
        status: u.status ?? "pending",
      };
      if (u.title != null) event.title = u.title;
      if (u.rawInput !== undefined && u.rawInput !== null) event.rawInput = u.rawInput;
      if (u.rawOutput !== undefined && u.rawOutput !== null) event.rawOutput = u.rawOutput;
      if (Array.isArray(u.content)) event.content = toToolContent(u.content);
      if (Array.isArray(u.locations)) event.locations = toToolLocations(u.locations);
      return event;
    }

    case "tool_call_update": {
      // Every field but toolCallId is optional here, and the wire encodes "unchanged"
      // as either absent or null. Copying only what's present is what lets a caller
      // merge safely; the old code invented `status: "in_progress"` and dropped the
      // command, output and diff entirely.
      const event: ToolUpdateActivity = { kind: "tool_update", toolCallId: u.toolCallId };
      if (u.status != null) event.status = u.status;
      if (u.title != null) event.title = u.title;
      if (u.kind != null) event.toolKind = u.kind;
      if (u.rawInput !== undefined && u.rawInput !== null) event.rawInput = u.rawInput;
      if (u.rawOutput !== undefined && u.rawOutput !== null) event.rawOutput = u.rawOutput;
      if (Array.isArray(u.content)) event.content = toToolContent(u.content);
      if (Array.isArray(u.locations)) event.locations = toToolLocations(u.locations);
      return event;
    }

    case "plan":
      return { kind: "plan", entries: (u.entries ?? []) as PlanEntry[] };
    case "plan_update":
      return { kind: "plan_update", planId: u.id, plan: u.plan };
    case "plan_removed":
      return { kind: "plan_removed", planId: u.id };

    case "available_commands_update":
      return { kind: "commands", commands: toAgentCommands(u.availableCommands) };
    case "current_mode_update":
      return { kind: "mode", modeId: u.currentModeId };
    case "config_option_update":
      return { kind: "config", configOptions: u.configOptions };

    case "usage_update":
      return {
        kind: "usage",
        used: Number(u.used ?? 0),
        size: Number(u.size ?? 0),
        ...(u.cost != null ? { cost: u.cost } : {}),
      };

    case "session_info_update":
      return { kind: "session_info", title: u.title ?? null, updatedAt: u.updatedAt ?? null };

    default:
      return {
        kind: "unknown",
        sessionUpdate: String(u.sessionUpdate ?? "unknown"),
        raw: update,
      };
  }
}

/** Slash commands from an available_commands_update payload. */
export function toAgentCommands(raw: unknown): AgentCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c: Record<string, any>) => ({
    name: c?.name,
    description: c?.description ?? "",
  }));
}

/** Normalize a ToolCallContent[] — keeping unrecognized shapes verbatim. */
export function toToolContent(raw: unknown[]): ToolContent[] {
  return raw.map((item): ToolContent => {
    const c = item as Record<string, any>;
    switch (c?.type) {
      case "content": {
        const block = (c.content ?? {}) as ContentBlock;
        const text = blockText(block);
        return text ? { type: "content", content: block, text } : { type: "content", content: block };
      }
      case "diff":
        return {
          type: "diff",
          path: c.path,
          oldText: c.oldText ?? null,
          newText: c.newText ?? "",
        };
      case "terminal":
        return { type: "terminal", terminalId: c.terminalId };
      default:
        return { type: "other", raw: item };
    }
  });
}

function toToolLocations(raw: unknown[]): ToolLocation[] {
  return raw.map((item) => {
    const l = item as Record<string, any>;
    return l?.line != null ? { path: l.path, line: l.line } : { path: l?.path };
  });
}

/** Text out of a ContentBlock, or "" when it isn't a text block. */
function blockText(block: unknown): string {
  const b = block as Record<string, any> | null | undefined;
  return b?.type === "text" ? (b.text ?? "") : "";
}
