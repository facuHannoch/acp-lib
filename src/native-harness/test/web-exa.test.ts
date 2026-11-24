import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, gzipSync } from "node:zlib";
import { boundedBytes, ExaResponseLimit } from "../src/capabilities/tools/web/exa-transport.ts";
import { runExa, normalizedWebUrl, webArgumentsProblem, type ExaTransport } from "../src/capabilities/tools/web/exa.ts";
import { fetchPreview, searchPreview } from "../src/capabilities/tools/web/preview.ts";

test("Exa search sends one exact request and emits ranked bounded JSON", async () => {
  const requests: Parameters<ExaTransport>[0][] = [];
  const transport: ExaTransport = async request => { requests.push(request); return { status: 200, body: { requestId: "id", costDollars: { total: 0 }, results: [
    { url: "https://example.com/a", title: "A", highlights: ["😀".repeat(400)] },
    { url: "http://127.0.0.1/", title: "private", highlights: ["x"] },
    { url: "https://example.com/b", title: "B", highlights: ["line\nquotes \" "] },
  ] } }; };
  const result = await runExa({ operation: "web_search", args: { query: "hello" }, key: "secret", transport });
  expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ path: "/search", key: "secret", body: { query: "hello", type: "auto", numResults: 5, contents: { highlights: { maxCharacters: 512 } } } });
  expect(result.ok).toBe(true); expect(result.usage).toEqual({ requestId: "id", usd: 0 });
  if (!result.ok) throw new Error(result.code);
  expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(2048);
  const data = JSON.parse(result.content); expect(data.results.map((hit: { url: string }) => hit.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
  expect(Buffer.byteLength(data.results[0].excerpt)).toBeLessThanOrEqual(512);
});

test("Exa fetch checks status and retains reported cost on failure", async () => {
  const calls: Parameters<ExaTransport>[0][] = [];
  const transport: ExaTransport = async request => { calls.push(request); return { status: 200, body: { requestId: "req", costDollars: { total: 0.03 }, statuses: [{ id: "https://example.com/", status: "error" }], results: [] } }; };
  const result = await runExa({ operation: "web_fetch", args: { url: "https://example.com/" }, key: "secret", transport });
  expect(calls[0]).toMatchObject({ path: "/contents", body: { urls: ["https://example.com/"], text: { maxCharacters: 16000 }, maxAgeHours: 24, livecrawlTimeout: 10000, subpages: 0 } });
  expect(result).toMatchObject({ ok: false, code: "page_unavailable", usage: { requestId: "req", usd: 0.03 } });
  const success: ExaTransport = async () => ({ status: 200, body: { statuses: [{ id: "https://example.com/", status: "success" }], results: [{ url: "https://example.com/", title: "Title", text: "A".repeat(4000) }] } });
  const page = await runExa({ operation: "web_fetch", args: { url: "https://example.com/" }, key: "secret", transport: success });
  if (!page.ok) throw new Error(page.code);
  expect(JSON.parse(page.content)).toMatchObject({ url: "https://example.com/", title: "Title", truncated: true, coverage: "unknown" });
  expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(2048);
});

test("serialized preview budgets escaping, scalar boundaries, and required metadata", () => {
  const page = fetchPreview({ url: "https://example.com/", title: "😀", text: "\n\"😀".repeat(2000), truncated: false, coverage: "unknown" })!;
  expect(Buffer.byteLength(page)).toBeLessThanOrEqual(2048); expect(JSON.parse(page).truncated).toBe(true);
  expect(fetchPreview({ url: `https://example.com/${"x".repeat(2048)}`, title: null, text: "x", truncated: false, coverage: "unknown" })).toBeUndefined();
  const hits = searchPreview(Array.from({ length: 5 }, (_, i) => ({ title: "x".repeat(2000), url: `https://example.com/${i}`, excerpt: "\\".repeat(300) })));
  expect(Buffer.byteLength(hits)).toBeLessThanOrEqual(2048); expect(JSON.parse(hits).results.length).toBeGreaterThan(0);
});

test("URL and arguments reject local, ambiguous and malformed destinations", () => {
  for (const url of ["http://127.0.0.1/", "http://2130706433/", "https://localhost/", "http://10.0.0.1/", "http://[::1]/", "https://user:pass@example.com/", "https://example.com/#x"]) expect(normalizedWebUrl(url)).toBeUndefined();
  expect(normalizedWebUrl("https://Example.com/path")).toBe("https://example.com/path");
  expect(webArgumentsProblem("web_search", { query: " " })).toBeDefined();
  expect(webArgumentsProblem("web_search", { query: "ok", extra: 1 })).toBeDefined();
});

test("deadline and interruption abort the provider request", async () => {
  const transport: ExaTransport = request => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  expect(await runExa({ operation: "web_search", args: { query: "x" }, key: "secret", transport, deadlineMs: 10 })).toMatchObject({ ok: false, code: "tool_timeout" });
  const controller = new AbortController(); const task = runExa({ operation: "web_search", args: { query: "x" }, key: "secret", transport, signal: controller.signal });
  controller.abort(); expect(await task).toMatchObject({ ok: false, code: "tool_interrupted" });
});

 test("hosted transport caps both raw and decoded streams without sockets", async () => {
  const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
  await expect(pipeline(Readable.from([Buffer.alloc(1025)]), boundedBytes(1024), sink())).rejects.toBeInstanceOf(ExaResponseLimit);
  const compressed = gzipSync(Buffer.alloc(4096));
  await expect(pipeline(Readable.from([compressed]), boundedBytes(1024), createGunzip(), boundedBytes(1024), sink())).rejects.toBeInstanceOf(ExaResponseLimit);
});
