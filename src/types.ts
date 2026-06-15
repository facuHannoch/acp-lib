// Core shared types — the OUTPUT contract.
// These are what every client (AcpClient, and later PtyClient) produces, so callers
// render against these regardless of which mode is active. See SPEC.md.

/** Token accounting for a turn. Nullable per-field — not all providers report all of it. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Only providers that do extended thinking report this. */
  thoughtTokens?: number;
}

/**
 * The result of a single prompt turn.
 *
 * `status` carries cancel/error state so the caller can react (mark not-delivered,
 * errored, etc.) — but interpreting it is the caller's concern. On cancellation the
 * call RESOLVES (not rejects) with whatever partial text arrived.
 */
export interface PromptResult {
  /** Accumulated response text (partial if cancelled). */
  text: string;
  /** Raw protocol stop reason: "end_turn" | "cancelled" | "max_tokens" | ... */
  stopReason: string;
  status: "completed" | "cancelled" | "error";
  usage: Usage | null;
}

/**
 * Real-time, observation-only events during a turn — separate from the response text.
 * Fire-and-forget; the caller renders them if it wants. (Permission requests are NOT
 * here — they are blocking and handled via PromptHandlers.onPermissionRequest.)
 */
export type ActivityEvent =
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      title?: string;
      toolKind: string;
      status: string;
      rawInput?: unknown;
    }
  | { kind: "tool_update"; toolCallId: string; status: string }
  | { kind: "plan"; entries: PlanEntry[] };

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

/** Outcome the caller returns from a permission request. */
export type PermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

/** A permission request surfaced to the caller. The agent BLOCKS until this resolves. */
export interface PermissionRequest {
  toolCallId: string;
  title?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  /** The raw SDK request, for callers that need fields we haven't surfaced. */
  raw: unknown;
}

/** Per-prompt callbacks. All optional. */
export interface PromptHandlers {
  /** Partial response text (agent_message_chunk) as it streams. */
  onChunk?: (text: string) => void;
  /** Observation-only activity (thinking, tool calls, plan). */
  onActivity?: (event: ActivityEvent) => void;
  /**
   * Blocking permission request. Must return an outcome. If omitted, the client
   * falls back to its configured `defaultPermission`.
   */
  onPermissionRequest?: (
    request: PermissionRequest,
  ) => PermissionOutcome | Promise<PermissionOutcome>;
}

/** Attachment passed alongside a prompt (e.g. an image). */
export interface Attachment {
  data: ArrayBuffer;
  mimeType: string;
}
