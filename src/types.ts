import type { ResolvedPart } from "./media/parts.ts";
// Core shared types — the OUTPUT contract.
// These are what every client (AcpClient, and later PtyClient) produces, so callers
// render against these regardless of which mode is active. See SPEC.md.

import type { ApplyResult } from "./activity.ts";
import type { PermissionOption, PermissionTool } from "./permissions/request.ts";

/**
 * A slash command exposed by the replaceable ACP-backed internal session (e.g. codex
 * /model, kimi /sessions), learned from `available_commands_update`.
 */
export interface InternalSessionCommand {
  readonly name: string;
  readonly description: string;
  /** ACP currently defines command input as unstructured text after the command name. */
  readonly input?: InternalSessionCommandInput;
}

export interface InternalSessionCommandInput {
  readonly kind: "unstructured";
  /** Placeholder/help text supplied by the harness. */
  readonly hint: string;
}

/**
 * Normalized ACP token counters, using the ACP field names verbatim.
 *
 * These are NOT guaranteed per-turn. The ACP SDK documents `PromptResponse.usage` as
 * usage "for this turn" while documenting the individual fields as totals across all
 * turns/the session, and exposes no discriminator. The library reads them as cumulative
 * internal-session counters and stamps that choice into metering provenance; callers
 * must not sum successive reports. See 9-6-SPEC-metering.md §4.
 *
 * An absent optional counter means the harness did not report the category. It does NOT
 * mean the category was zero.
 */
export interface TokenUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  /** Only providers that do extended thinking report this. */
  thoughtTokens?: number;
}

/**
 * @deprecated Renamed to {@link TokenUsage}. The old shape used non-ACP field names
 * (`cacheReadTokens`/`cacheWriteTokens`), omitted `totalTokens`, and was described as
 * per-turn. Pre-1.0 rename — see the changelog.
 */
export type Usage = TokenUsage;

/**
 * The result of a single prompt turn.
 *
 * `status` carries cancel/error state so the caller can react (mark not-delivered,
 * errored, etc.) — but interpreting it is the caller's concern. On cancellation the
 * call RESOLVES (not rejects) with whatever partial text arrived.
 */
export interface PromptResult {
  readonly cancel?: "acknowledged" | "forced";
  /**
   * Legacy lossy projection of `messages`, separated by one blank line.
   * @deprecated Use `messages`, preserving each logical ACP response message. Consumers
   * that require one string can call `formatResponseMessages` with their own separator.
   */
  text: string;
  /** Canonical assistant result in protocol order, preserving ACP message boundaries. */
  messages: readonly ResponseMessage[];
  /** Raw protocol stop reason: "end_turn" | "cancelled" | "max_tokens" | ... */
  stopReason: string;
  status: "completed" | "cancelled" | "error";
  /**
   * Normalized cumulative counters, or null when the harness reported none or reported
   * something malformed. Null is "unknown", never "zero".
   */
  usage: TokenUsage | null;
}

/** One boundary-aware delta from an ACP `agent_message_chunk`. */
export interface ResponseChunk {
  /** Non-text delta; text remains the compatibility projection. */
  part?: ResolvedPart;
  text: string;
  messageId?: string;
  /** True when this chunk begins a new assistant message. */
  startsMessage: boolean;
}

/** One assistant message assembled from consecutive ACP response chunks. */
export interface ResponseMessage {
  /** Ordered normalized parts, present for messages containing media. */
  parts?: readonly ResolvedPart[];
  messageId?: string;
  text: string;
}

/**
 * One line of raw traffic between us and the agent process — the debugging view.
 *
 * `line` is the ndjson VERBATIM, never reserialized, so what you read is exactly what
 * crossed the pipe (reserializing can mangle numbers we never parse). Notifications the
 * transport intercepts before the SDK are included: this is the wire, not our model of it.
 */
export interface WireEntry {
  /** `in` from the agent's stdout, `out` to its stdin, `err` from its stderr. */
  dir: "in" | "out" | "err";
  ts: number;
  line: string;
}

/** A raw content block: "text" | "image" | "audio" | "resource" | "resource_link". */
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

/** A file location a tool call touched — enables "follow along" UIs. */
export interface ToolLocation {
  path: string;
  line?: number;
}

/** How a terminal command ended. Both fields are null while it is still running. */
export interface TerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}

/**
 * Output produced by a tool call. Mirrors the protocol's three shapes; anything we
 * don't recognize is preserved verbatim as `other` rather than dropped.
 *
 * `terminal` content names a live terminal the AGENT is driving through us. We resolve
 * its output before handing the event to the caller, so `output`/`exitStatus` are
 * populated whenever the terminal is still ours to read.
 */
export type ToolContent =
  | { type: "content"; content: ContentBlock; /** Convenience: set for text blocks. */ text?: string }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | {
      type: "terminal";
      terminalId: string;
      output?: string;
      truncated?: boolean;
      exitStatus?: TerminalExitStatus | null;
    }
  | { type: "other"; raw: unknown };

/**
 * A tool call the agent started. The protocol lets an agent announce a call before it
 * knows much about it, so most fields fill in later via `tool_update`.
 */
export interface ToolActivity {
  kind: "tool";
  toolCallId: string;
  title?: string;
  toolKind: string;
  status: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolContent[];
  locations?: ToolLocation[];
}

/**
 * A change to an in-flight tool call. Only the fields the agent actually changed are
 * present — an absent field means "unchanged", NOT "empty". `content` and `locations`
 * REPLACE the previous collections when present.
 */
export interface ToolUpdateActivity {
  kind: "tool_update";
  toolCallId: string;
  status?: string;
  title?: string;
  toolKind?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolContent[];
  locations?: ToolLocation[];
}

/**
 * Real-time, observation-only events during a turn — separate from the response text.
 * Fire-and-forget; the caller renders them if it wants. (Permission requests are NOT
 * here — they are blocking and handled via PromptHandlers.onPermissionRequest.)
 *
 * Every session update except `agent_message_chunk` (which is the response text) maps to
 * one of these; unrecognized kinds arrive as `unknown` with the raw payload attached, so
 * a newer agent can never silently starve the caller of activity.
 */
export type ActivityEvent =
  | { kind: "thinking"; text: string; messageId?: string }
  /** The agent echoed back user input — session/load replay, or a queued message. */
  | { kind: "user_message"; text: string; messageId?: string }
  | ToolActivity
  | ToolUpdateActivity
  /** Full plan snapshot: replaces any previous plan. */
  | { kind: "plan"; entries: PlanEntry[] }
  /** Per-plan update (experimental protocol extension). */
  | { kind: "plan_update"; planId: string; plan: unknown }
  | { kind: "plan_removed"; planId: string }
  /** ACP available commands changed; also reflected in `client.availableCommands`. */
  | { kind: "commands"; commands: readonly InternalSessionCommand[] }
  /** The agent switched session mode. */
  | { kind: "mode"; modeId: string }
  /** Context-window accounting. `used`/`size` are tokens. */
  | { kind: "usage"; used: number; size: number; cost?: unknown }
  /** The agent retitled the session or bumped its activity timestamp. */
  | { kind: "session_info"; title?: string | null; updatedAt?: string | null }
  /** Config options changed; also reflected in `client.configOptions`. */
  | { kind: "config"; configOptions: unknown }
  /** A session update we don't model. The raw notification payload is attached. */
  | { kind: "unknown"; sessionUpdate: string; raw: unknown };

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

/** Outcome the caller returns from a permission request. */
export type PermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

/**
 * What an option DOES, independent of what it is called or where it sits in the list.
 * The only safe thing to branch on: `name` is prose and the order is the agent's whim
 * (Claude puts its reject option first). `allow_always` and `reject_always` persist into
 * the agent's own settings and outlive the session — treat them as policy, not answers.
 *
 * The open arm keeps a kind we don't know yet from failing to typecheck; branch with a
 * fallback rather than assuming the four.
 */
export type { PermissionOptionKind } from "./permissions/request.ts";

/** A permission request surfaced to the caller. The agent BLOCKS until this resolves. */
export interface PermissionRequest {
  toolCallId: string;
  title?: string;
  options: PermissionOption[];
  /** Neutral tool data when the producer supplies it. */
  tool?: PermissionTool;
  /** The raw SDK request, for callers that need fields we haven't surfaced. */
  raw: unknown;
}

/** Per-prompt callbacks. All optional. */
export interface PromptHandlers {
  /** Legacy raw text stream. Concatenation does not encode message boundaries. */
  onChunk?: (text: string) => void;
  /** Boundary-aware response stream preserving ACP `messageId`. */
  onResponseChunk?: (chunk: ResponseChunk) => void;
  /** Observation-only activity (thinking, tool calls, plan) as RAW protocol deltas. */
  onActivity?: (event: ActivityEvent) => void;
  /**
   * The same activity, FOLDED into full-state records — see `src/activity.ts`. Prefer this
   * over hand-rolling the merge: `current` is always complete state, `emitted` is the
   * subset worth persisting, `delta` is the incremental piece for thinking.
   *
   * Only fires when prompting through `AgentSession`, which runs exactly one aggregator
   * per session. A caller holding a raw `AcpClient` owns its own aggregator and calls
   * `apply()` from `onActivity`.
   */
  onRecord?: (result: ApplyResult) => void;
  /**
   * Every raw `session/update` notification for this turn, before any mapping. The
   * escape hatch for protocol fields the ActivityEvent contract doesn't model yet.
   */
  onUpdate?: (notification: unknown) => void;
  /**
   * Blocking callback for a request whose configured permission level is ask.
   */
  onPermissionRequest?: (
    request: PermissionRequest,
    signal?: AbortSignal,
  ) => PermissionOutcome | Promise<PermissionOutcome>;
}

/** Attachment passed alongside a prompt (e.g. an image). */
export interface Attachment {
  data: ArrayBuffer;
  mimeType: string;
}

/** A session as reported by the agent via session/list (the authoritative source). */
export interface SessionListEntry {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

/** Result of a paginated session/list call. */
export interface SessionListPage {
  sessions: SessionListEntry[];
  /** Pass back as `cursor` to fetch the next page; absent when there are no more. */
  nextCursor?: string;
}
