/** Decision 0016: a validated, portable scripted session configuration. The
 * script is a destination-side file reference; policy names are exact strings. */
export type ToolDecision = "allow" | "ask" | "deny";
export interface ToolPolicy { fallback: ToolDecision; tools: Record<string, ToolDecision> }
export interface ManagedConfig {
  version: 1;
  system: string;
  model: { protocol: "scripted"; script: string };
  defaultPolicy: string;
  policies: Record<string, ToolPolicy>;
}

/** Immutable acceptance metadata. `explicit` records absence distinctly from
 * a named override. `inherited` is the deduplicated source-turn restriction
 * set for a notice; callers cannot supply it for a participant message. */
export interface ItemPolicy {
  explicit?: string;
  resolved: string;
  inherited: string[];
}

/** One request names one exact call; arguments are the original JSON text.
 * IDs are unique within the lifetime of a server and cannot authorize a
 * different request. Requests never survive restart as grants. */
export interface ApprovalRequest {
  requestId: string;
  channel: string;
  turnId: string;
  toolCallId: string;
  tool: string;
  arguments: string;
}
export type ApprovalAnswer = "allow_once" | "deny";
export type ApprovalCloseReason = "approval_denied" | "approval_timeout" | "approval_unhandled"
  | "approval_disconnected" | "approval_cancelled_by_suspension";

/** A skipped call records a paired tool result with this stable reason. */
export interface SkippedToolResult { ok: false; code: ApprovalCloseReason | "policy_denied"; message: string }
