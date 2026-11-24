import type { WebDispatchEvidence, WebResultUsage as CommittedWebUsage, WebUsageView } from "../contracts/web.ts";
export type { WebDispatchEvidence, WebResultUsage as CommittedWebUsage, WebUsageView } from "../contracts/web.ts";
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

/** Untrusted archive/storage data must not manufacture paid classification. */
export function validWebDispatch(value: unknown): value is WebDispatchEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !["backend", "operation", "paid"].includes(key))) return false;
  return (item.backend === "exa" && item.paid === true && (item.operation === "web_search" || item.operation === "web_fetch"))
    || (item.backend === "http" && item.paid === false && item.operation === "web_fetch");
}
export function validCommittedWebUsage(value: unknown): value is CommittedWebUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  if (Object.keys(usage).some(key => !["requestId", "usd"].includes(key))) return false;
  if (usage.requestId !== undefined && (typeof usage.requestId !== "string" || !usage.requestId.trim()
    || Buffer.byteLength(usage.requestId) > 256 || /[\u0000-\u001f\u007f]/u.test(usage.requestId))) return false;
  return usage.usd === undefined || (typeof usage.usd === "number" && Number.isFinite(usage.usd) && usage.usd >= 0);
}
