/** Immutable non-secret dispatch evidence, committed before external effects. */
export type WebDispatchEvidence = { backend: "exa"; operation: "web_search" | "web_fetch"; paid: true } | { backend: "http"; operation: "web_fetch"; paid: false };
/** Provider-reported metadata; committed atomically with the paired result. */
export interface WebResultUsage { requestId?: string; usd?: number }
export interface StoredWebDispatch { turnId: number; callId: string; evidence: WebDispatchEvidence }
export type WebCost = { kind: "none" } | { kind: "unknown" } | { kind: "provider_estimate"; usd: number };
export interface WebUsageView { backend?: "exa" | "http"; operation?: "web_search" | "web_fetch"; requestId?: string; cost: WebCost }
export type WebToolError = "invalid_arguments" | "rate_limited" | "provider_error" | "tool_timeout" | "page_unavailable" | "result_too_large" | "tool_interrupted" | "response_too_large";
export type WebToolResponse = { ok: true; content: string; usage: WebResultUsage } | { ok: false; code: WebToolError; message: string; usage: WebResultUsage };
/** Trusted local tool assembly; dispatch metadata is frozen for this open. */
export interface CheckedWebRegistration {
  definition: import("./loop.ts").ToolDefinition;
  validate(args: unknown): string | undefined;
  dispatch: WebDispatchEvidence;
  execute(args: unknown, signal: AbortSignal): Promise<WebToolResponse>;
}
