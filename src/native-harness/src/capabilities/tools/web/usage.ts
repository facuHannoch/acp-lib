/** Pure projection over committed facts. Persisting these facts atomically is
 * the session owner's responsibility; never infer backend from current config. */
export type WebDispatchEvidence = { backend: "exa"; operation: "web_search" | "web_fetch"; paid: true } | { backend: "http"; operation: "web_fetch"; paid: false };
export interface CommittedWebUsage { requestId?: string; usd?: number }
export type WebCost = { kind: "none" } | { kind: "unknown" } | { kind: "provider_estimate"; usd: number };
export interface WebUsageView { backend?: "exa" | "http"; operation?: "web_search" | "web_fetch"; requestId?: string; cost: WebCost }

/** undefined means a legacy invocation whose classification was never recorded. */
export function webUsageView(input: { knownWebCall: boolean; dispatched: boolean; evidence?: WebDispatchEvidence; committedUsage?: CommittedWebUsage }): WebUsageView | undefined {
  if (!input.knownWebCall) return;
  if (!input.dispatched) return { cost: { kind: "none" } };
  const evidence = input.evidence;
  if (!evidence) return;
  const result: WebUsageView = { backend: evidence.backend, operation: evidence.operation, cost: { kind: "none" } };
  if (input.committedUsage?.requestId) result.requestId = input.committedUsage.requestId;
  if (evidence.paid) {
    const usd = input.committedUsage?.usd;
    result.cost = typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? { kind: "provider_estimate", usd } : { kind: "unknown" };
  }
  return result;
}
