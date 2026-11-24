/** Decisions 0016 and 0017: a validated portable session configuration.
 * Script files and credential environment variables are destination resources. */
export type ToolDecision = "allow" | "ask" | "deny";
export interface ToolPolicy { fallback: ToolDecision; tools: Record<string, ToolDecision> }
export type ManagedModel = { protocol: "scripted"; script: string; imageInput?: boolean }
  | { protocol: "openrouter"; model: string; apiKeyEnv: string; imageInput?: boolean }
  | { protocol: "openai-compatible"; providerId: string; model: string; baseUrl: string; apiKeyEnv?: string };
/** Decision 0035: independent portable web backends, with credential names only. */
export interface ExaSearchConfig { backend: "exa"; apiKeyEnv?: string; maxResults?: number; excerptBytes?: number; deadlineMs?: number }
export type WebFetchConfig = { backend: "exa"; apiKeyEnv?: string; deadlineMs?: number } | { backend: "http"; deadlineMs?: number };
export interface WebConfig { webSearch?: ExaSearchConfig; webFetch?: WebFetchConfig }
export interface ManagedConfig {
  version: 1;
  limits?: { unattendedTurns: number };
  system: string;
  model: ManagedModel;
  defaultPolicy: string;
  timelineTools?: boolean;
  webSearch?: ExaSearchConfig;
  webFetch?: WebFetchConfig;
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
/** Optional initialize field. Only true declares this connection as the
 * approval consumer; callbacks must remain empty. */
export interface ApprovalInitialization { approval?: boolean }
export type ApprovalCloseReason = "approval_denied" | "approval_timeout" | "approval_unhandled"
  | "approval_disconnected" | "approval_cancelled_by_suspension"
  | "approval_cancelled_by_interrupt" | "approval_cancelled_by_stop"
  /** Decision 0021: the tool was revoked or removed, or its handler left, while the request was open. */
  | "tool_unavailable";

/** A skipped call records a paired tool result with this stable reason. */
export interface SkippedToolResult { ok: false; code: ApprovalCloseReason | "policy_denied"; message: string }
