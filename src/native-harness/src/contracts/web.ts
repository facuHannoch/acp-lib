/** Immutable non-secret dispatch evidence, committed before external effects. */
export type WebDispatchEvidence = { backend: "exa"; operation: "web_search" | "web_fetch"; paid: true } | { backend: "http"; operation: "web_fetch"; paid: false };
/** Provider-reported metadata; committed atomically with the paired result. */
export interface WebResultUsage { requestId?: string; usd?: number }
export interface StoredWebDispatch { turnId: number; callId: string; evidence: WebDispatchEvidence }
export type WebCost = { kind: "none" } | { kind: "unknown" } | { kind: "provider_estimate"; usd: number };
export interface WebUsageView { backend?: "exa" | "http"; operation?: "web_search" | "web_fetch"; requestId?: string; cost: WebCost }
