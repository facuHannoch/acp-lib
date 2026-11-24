import { ExaResponseLimit } from "./exa-transport.ts";
import { BlockList, isIP } from "node:net";
import { fetchPreview, searchPreview, type WebHit } from "./preview.ts";

export type WebError = "rate_limited" | "provider_error" | "tool_timeout" | "page_unavailable" | "result_too_large" | "tool_interrupted" | "response_too_large";
export interface WebUsage { requestId?: string; usd?: number }
export type WebResponse = { ok: true; content: string; usage: WebUsage } | { ok: false; code: WebError; message: string; usage: WebUsage };
/** Transport must reject redirects, enforce raw/decoded 2 MiB caps and abort. */
export type ExaTransport = (request: { path: "/search" | "/contents"; key: string; body: object; signal: AbortSignal }) => Promise<{ status: number; body: unknown }>;
const failed = (code: WebError, usage: WebUsage = {}): WebResponse => ({ ok: false, code, message: ({ rate_limited: "Web provider rate limit reached", provider_error: "Web provider request failed", tool_timeout: "Web request timed out", page_unavailable: "Page content is unavailable", result_too_large: "Page metadata exceeds the result limit", tool_interrupted: "Web request was interrupted", response_too_large: "Web provider response exceeds the limit" })[code], usage });
const record = (v: unknown): Record<string, unknown> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const usageOf = (value: Record<string, unknown> | undefined): WebUsage => {
  const usage: WebUsage = {}, id = value?.requestId, cost = record(value?.costDollars)?.total;
  if (typeof id === "string" && Buffer.byteLength(id) <= 256 && id.trim()) usage.requestId = id;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) usage.usd = cost;
  return usage;
};
const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::",128],["::1",128],["::ffff:0:0",96],["64:ff9b:1::",48],["100::",64],["2001::",23],["2001:db8::",32],["2002::",16],["fc00::",7],["fe80::",10],["ff00::",8]] as const) blocked.addSubnet(address, prefix, "ipv6");
/** URL validation rejects local literals; direct transport additionally pins DNS. */
export function normalizedWebUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 2048 || /[\s\\\u0000-\u001f\u007f#]/u.test(value) || !/^https?:\/\//i.test(value)) return;
  try {
    const url = new URL(value); if (!url.hostname || url.username || url.password || !["http:", "https:"].includes(url.protocol)) return;
    const rawAuthority = value.match(/^https?:\/\/([^/?]+)/i)?.[1] ?? "";
    const rawHost = rawAuthority.startsWith("[") ? rawAuthority.slice(0, rawAuthority.indexOf("]") + 1) : rawAuthority.split(":")[0] ?? "";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (/^(localhost|.*\.localhost|.*\.local)$/i.test(host)) return;
    const family = isIP(host);
    if (family && (blocked.check(host, family === 4 ? "ipv4" : "ipv6") || rawHost.toLowerCase() !== url.hostname.toLowerCase())) return;
    if (family === 6 && !/^[23]/i.test(host)) return;
    return url.href;
  } catch { return; }
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
  if (webArgumentsProblem(input.operation, args)) return failed("provider_error");
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
    if (response.status === 429) return failed("rate_limited", usage);
    if (response.status < 200 || response.status >= 300 || !json) return failed("provider_error", usage);
    if (search) {
      if (!Array.isArray(json.results)) return failed("provider_error", usage);
      const hits: WebHit[] = [];
      for (const value of json.results) {
        const item = record(value), hitUrl = normalizedWebUrl(item?.url); if (!hitUrl) continue;
        const highlights = item?.highlights;
        hits.push({ title: typeof item?.title === "string" ? item.title : null, url: hitUrl,
          excerpt: Array.isArray(highlights) ? highlights.filter((part): part is string => typeof part === "string").join(" ") || null : null });
      }
      return { ok: true, content: searchPreview(hits, input.maxResults ?? 5, input.excerptBytes ?? 512), usage };
    }
    const statuses = Array.isArray(json.statuses) ? json.statuses.map(record).filter(entry => entry?.id === url) : [];
    const results = Array.isArray(json.results) ? json.results.map(record).filter(entry => normalizedWebUrl(entry?.url) === url) : [];
    if (statuses.length !== 1 || statuses[0]?.status !== "success" || results.length !== 1 || typeof results[0]?.text !== "string" || !results[0].text.trim()) return failed("page_unavailable", usage);
    const content = fetchPreview({ url: url!, title: typeof results[0].title === "string" ? results[0].title : null, text: results[0].text, truncated: false, coverage: "unknown" });
    return content === undefined ? failed("result_too_large", usage) : { ok: true, content, usage };
  } catch (error) { return failed(cause ?? (error instanceof ExaResponseLimit ? "response_too_large" : "provider_error")); }
  finally { clearTimeout(timeout); input.signal?.removeEventListener("abort", abort); }
}
