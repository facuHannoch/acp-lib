import type { ToolDefinition } from "./loop.ts";

/** Decision 0021. How a catalog entry can change while the session is open.
 * `fixed`: declared at open; no runtime operation removes it.
 * `revocable`: declared at open; its grant can be revoked and restored, and
 * that choice is stored with the session.
 * `runtime`: enabled and removed by name; the enabled set lives in memory and
 * the consumer supplies it again when it reconnects. */
export type ToolGroup = "fixed" | "revocable" | "runtime";

/** One consumer function offered to the model. Data only: `handler` names an
 * implementation the consumer serves at runtime. Definitions are supplied on
 * every open and never stored. The tool name also identifies policy rules. */
export interface ToolRegistration extends ToolDefinition {
  handler: string;
  group: ToolGroup;
  /** Execution deadline from dispatch, in milliseconds. Absent: the session
   * default, and without one no wall-clock deadline. */
  deadlineMs?: number;
}

/** Supplied with `session/create` and `session/open`. */
export interface ToolCatalogInput {
  catalog: ToolRegistration[];
  /** Runtime entries enabled from the start. */
  enabled?: string[];
  defaultDeadlineMs?: number;
}

/** Availability, reported apart from policy so a consumer can tell why a tool
 * cannot run. A fixed entry is still subject to its handler being served. */
export interface ToolAvailability {
  name: string;
  group: ToolGroup | "builtin";
  handler?: string;
  available: boolean;
  reason?: "revoked" | "not_enabled" | "handler_missing";
}

/** Recorded with a tool result. Absent on results written before decision
 * 0021 and on built-in tools: read as `succeeded`. */
export interface ToolOutcome {
  /** `skipped`: never dispatched. `interrupted`: the wait ended after
   * dispatch without an authoritative result; the effect is unknown. */
  status: "succeeded" | "failed" | "skipped" | "interrupted";
  /** Stable reason for anything but success, e.g. `policy_denied`,
   * `tool_unavailable`, `invalid_arguments`, `tool_timeout`. */
  code?: string;
  /** The full result is held by its producer; the model saw a preview. */
  reference?: ResultReference;
}

/** An opaque handle to bytes held by the process that produced them. Bound by
 * the harness to the producing session, channel and invocation. The producer
 * owns retention and declares it here. */
export interface ResultReference {
  resultId: string;
  bytes: number;
  /** `temporary` results can expire (`expiresAt`, UTC) and do not survive the
   * producer's restart unless it says `durable`. */
  retention: "temporary" | "durable";
  expiresAt?: string;
}

export type ToolInvocationState = "requested" | "waiting_for_approval" | "started"
  | "succeeded" | "failed" | "skipped" | "interrupted";

/** One requested call, derived from committed records plus, while live, the
 * approval it waits on. `invocationId` is `<turnId>:<toolCallId>`. */
export interface ToolInvocation {
  invocationId: string;
  channel: string;
  turnId: string;
  /** The provider's ID, which pairs the result with the model response. */
  toolCallId: string;
  tool: string;
  /** The original JSON text. */
  arguments: string;
  state: ToolInvocationState;
  code?: string;
  /** `unknown`: dispatched with no authoritative outcome. The harness never
   * repeats such a call. `none`: it never dispatched. */
  effect?: "none" | "unknown";
  reference?: ResultReference;
}

/** What the turn is doing now, with the ID of the model call, approval request
 * or invocation it concerns. Process state: absent after a reopen until the
 * turn does something. */
export interface TurnPhase {
  kind: "model" | "approval" | "tool";
  /** UTC time the phase began. */
  since: string;
  id?: string;
}

/** `functions/call` parameters. Sent only after dispatch evidence committed. */
export interface FunctionCall {
  invocationId: string;
  sessionId: string;
  channel: string;
  turnId: string;
  tool: string;
  handler: string;
  /** Deduplicated configured policy names frozen at authorization, including
   * inherited notice policies. Order grants no precedence. The internal
   * __legacy_allow fallback is omitted. An empty list means none contributed. */
  policyNames: string[];
  /** Parsed and validated against the tool's `parameters`. */
  arguments: Record<string, unknown>;
}

/** A handler's answer: structured output inline, or a preview with a reference
 * to bytes it stored itself. An error is a typed failure, not a thrown call. */
export type FunctionResult =
  | { output: unknown; preview?: never; reference?: never }
  | { output?: never; preview: string; reference: ResultReference };

/** `results/read` parameters and result. The harness has already checked that
 * `channel` produced `resultId`; the host serves bytes it holds. */
export interface ResultRead { resultId: string; invocationId: string; channel: string; offset: number; length: number }
export interface ResultPage { text: string; eof: boolean; totalBytes: number }

/** Runs one authorized catalog call somewhere outside the harness. Resolves
 * with the handler's answer; rejects with `{ code, message }` for a typed
 * error. Aborting `signal` requests cancellation and ends the wait. */
export interface FunctionExecutor {
  call(request: FunctionCall, signal: AbortSignal): Promise<FunctionResult>;
  read(request: ResultRead, signal: AbortSignal): Promise<ResultPage>;
}

/** Adjustable defaults (BUSINESS_RULES.md). */
export interface ToolLimits { inlineBytes: number; previewBytes: number; readBytes: number }
