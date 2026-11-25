import { ServiceTransportError } from "./service-egress.ts";
import { ExaResponseLimit } from "./exa-transport.ts";
import { directUrl } from "./direct-address.ts";
import { fetchPreview, searchPreview, type WebHit } from "./preview.ts";

import type { WebToolError as WebError, WebResultUsage as WebUsage, WebToolResponse as WebResponse } from "../../../contracts/web.ts";
export type { WebToolError as WebError, WebResultUsage as WebUsage, WebToolResponse as WebResponse } from "../../../contracts/web.ts";
/** Transport must reject redirects, enforce raw/decoded 2 MiB caps and abort. */
export type ExaTransport = (request: { path: "/search" | "/contents"; key: string; body: object; signal: AbortSignal }) => Promise<{ status: number; body: unknown }>;
const failed = (code: WebError, usage: WebUsage = {}): WebResponse => ({ ok: false, code, message: ({ blocked_destination: "Web destination is blocked", unsupported_content: "Unsupported page content", invalid_arguments: "Invalid web tool arguments", rate_limited: "Web provider rate limit reached", provider_error: "Web provider request failed", tool_timeout: "Web request timed out", page_unavailable: "Page content is unavailable", result_too_large: "Page metadata exceeds the result limit", tool_interrupted: "Web request was interrupted", response_too_large: "Web provider response exceeds the limit" })[code], usage });
const record = (v: unknown): Record<string, unknown> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const usageOf = (value: Record<string, unknown> | undefined): WebUsage => {
  const usage: WebUsage = {}, id = value?.requestId, cost = record(value?.costDollars)?.total;
  if (typeof id === "string" && Buffer.byteLength(id) <= 256 && id.trim() && !/[\u0000-\u001f\u007f]/u.test(id)) usage.requestId = id;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) usage.usd = cost;
  return usage;
};
/** Share strict public URL syntax and literal checks with the direct adapter;
 * actual DNS binding remains the direct transport's responsibility. */
export function normalizedWebUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try { const result = directUrl(value).href; return Buffer.byteLength(result) <= 2048 ? result : undefined; } catch { return; }
}
export function webArgumentsProblem(name: "web_search" | "web_fetch", value: unknown): string | undefined {
  const input = record(value), field = name === "web_search" ? "query" : "url";
  if (!input || Object.keys(input).length !== 1 || !(field in input)) return "Expected exactly one argument";
  if (field === "query") return typeof input.query === "string" && !!input.query.trim() && Buffer.byteLength(input.query) <= 1024 ? undefined : "Invalid query";
  return normalizedWebUrl(input.url) ? undefined : "Invalid URL";
}
export async function runExa(input: { operation: "web_search" | "web_fetch"; args: { query: string } | { url: string }; key: string; transport: ExaTransport; maxResults?: number; excerptBytes?: number; deadlineMs?: number; signal?: AbortSignal }): Promise<WebResponse> {
  if (input.signal?.aborted) return failed("tool_interrupted");
  const args = input.args, search = input.operation === "web_search";
  if (webArgumentsProblem(input.operation, args)) return failed("invalid_arguments");
  const url = !search && "url" in args ? normalizedWebUrl(args.url)! : undefined;
  const body = search && "query" in args ? { query: args.query, type: "auto", numResults: input.maxResults ?? 5, contents: { highlights: { maxCharacters: 512 } } }
    : { urls: [url], text: { maxCharacters: 16000 }, maxAgeHours: 24, livecrawlTimeout: 10000, subpages: 0 };
  const controller = new AbortController(); let cause: "tool_timeout" | "tool_interrupted" | undefined;
  const abort = () => { cause ??= "tool_interrupted"; controller.abort(); };
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  const timeout = setTimeout(() => { cause ??= "tool_timeout"; controller.abort(); }, input.deadlineMs ?? 15000);
  try {
    if (cause) return failed(cause);
    const response = await input.transport({ path: search ? "/search" : "/contents", key: input.key, body, signal: controller.signal });
    if (cause) return failed(cause);
    const json = record(response.body), usage = usageOf(json);
    // Provider output is untrusted and may echo request headers. Do not allow
    // the resolved credential to escape via content or request metadata.
    if (input.key && usage.requestId?.includes(input.key)) delete usage.requestId;
    const redact = (value: string) => input.key ? value.replaceAll(input.key, "[redacted]") : value;
    if (response.status === 429) return failed("rate_limited", usage);
    if (response.status < 200 || response.status >= 300 || !json) return failed("provider_error", usage);
    if (search) {
      if (!Array.isArray(json.results)) return failed("provider_error", usage);
      const hits: WebHit[] = [];
      for (const value of json.results) {
        const item = record(value), hitUrl = normalizedWebUrl(item?.url); if (!hitUrl || (input.key && hitUrl.includes(input.key))) continue;
        const highlights = item?.highlights;
        hits.push({ title: typeof item?.title === "string" ? redact(item.title) : null, url: hitUrl,
          excerpt: Array.isArray(highlights) ? highlights.filter((part): part is string => typeof part === "string").map(redact).join(" ") || null : null });
      }
      return { ok: true, content: searchPreview(hits, input.maxResults ?? 5, input.excerptBytes ?? 512), usage };
    }
    const statuses = Array.isArray(json.statuses) ? json.statuses.map(record).filter(entry => entry?.id === url) : [];
    const results = Array.isArray(json.results) ? json.results.map(record).filter(entry => normalizedWebUrl(entry?.url) === url) : [];
    if (statuses.length !== 1 || statuses[0]?.status !== "success" || results.length !== 1 || typeof results[0]?.text !== "string" || !results[0].text.trim()) return failed("page_unavailable", usage);
    if (input.key && url!.includes(input.key)) return failed("page_unavailable", usage);
    const content = fetchPreview({ url: url!, title: typeof results[0].title === "string" ? redact(results[0].title) : null, text: redact(results[0].text), truncated: false, coverage: "unknown" });
    return content === undefined ? failed("result_too_large", usage) : { ok: true, content, usage };
  } catch (error) {
    const result = failed(cause ?? (error instanceof ExaResponseLimit ? "response_too_large" : "provider_error"));
    return !result.ok && !cause && error instanceof ServiceTransportError ? { ...result, message: error.message } : result;
  }
  finally { clearTimeout(timeout); input.signal?.removeEventListener("abort", abort); }
}
