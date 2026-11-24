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

 test("provider echoes cannot expose credential values in content or metadata", async () => {
  const key = "synthetic-secret-canary";
  const result = await runExa({ operation: "web_search", args: { query: "a" }, key, transport: async () => ({ status: 200, body: { requestId: `req-${key}`, results: [{ url: "https://example.com/", title: key, highlights: [key] }] } }) });
  expect(JSON.stringify(result)).not.toContain(key);
  expect(result.ok).toBe(true);
});

test("web configuration selects credentials only for selected backends", async () => {
  const { resolveWebCredentials, validateWebConfig } = await import("../src/capabilities/tools/web/config.ts");
  const plain = validateWebConfig({ webFetch: { backend: "http" } });
  expect(plain.ok).toBe(true); if (!plain.ok) return;
  expect(resolveWebCredentials(plain.value, {})).toEqual({ ok: true, value: {} });
  expect(validateWebConfig({ webFetch: { backend: "http", apiKeyEnv: "FOO" } }).ok).toBe(false);
  expect(validateWebConfig({ webSearch: { backend: "exa", maxResults: 6 } }).ok).toBe(false);
  const exa = validateWebConfig({ webSearch: { backend: "exa" }, webFetch: { backend: "exa", apiKeyEnv: "FETCH_KEY" } });
  expect(exa.ok).toBe(true); if (!exa.ok) return;
  expect(resolveWebCredentials(exa.value, { EXA_API_KEY: "secret" })).toMatchObject({ ok: false, error: { code: "invalid_config", message: "Missing or empty environment variable FETCH_KEY" } });
  expect(resolveWebCredentials(exa.value, { EXA_API_KEY: "secret", FETCH_KEY: "another" })).toEqual({ ok: true, value: { searchKey: "secret", fetchKey: "another" } });
  expect(JSON.stringify(exa.value)).not.toContain("secret");
});

test("missing, duplicate, and mismatched per-URL statuses fail closed with usage", async () => {
  const url = "https://example.com/a";
  for (const statuses of [undefined, [], [{ id: url, status: "error" }], [{ id: url, status: "success" }, { id: url, status: "success" }], [{ id: "https://example.com/b", status: "success" }]]) {
    const result = await runExa({ operation: "web_fetch", args: { url }, key: "key", transport: async () => ({ status: 200, body: { requestId: "paid", costDollars: { total: 0 }, statuses, results: [{ url, text: "text" }] } }) });
    expect(result).toMatchObject({ ok: false, code: "page_unavailable", usage: { requestId: "paid", usd: 0 } });
  }
});

test("Exa rate limits and invalid costs do not fabricate zero or leak errors", async () => {
  for (const total of [-1, null, "0", Number.POSITIVE_INFINITY]) {
    const result = await runExa({ operation: "web_search", args: { query: "x" }, key: "canary", transport: async () => ({ status: 429, body: { error: "canary", requestId: "id", costDollars: { total } } }) });
    expect(result).toMatchObject({ ok: false, code: "rate_limited", usage: { requestId: "id" } });
    expect(result.usage.usd).toBeUndefined(); expect(JSON.stringify(result)).not.toContain("canary");
  }
});

test("unrepresentable fetch URL fails as a bounded typed result while retaining cost", async () => {
  const url = `https://example.com/${"a".repeat(1990)}`;
  const result = await runExa({ operation: "web_fetch", args: { url }, key: "key", transport: async () => ({ status: 200, body: { costDollars: { total: 0.01 }, statuses: [{ id: url, status: "success" }], results: [{ url, text: "example" }] } }) });
  expect(result).toMatchObject({ ok: false, code: "result_too_large", usage: { usd: 0.01 } });
});

test("already aborted calls do not invoke the Exa transport", async () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  const result = await runExa({ operation: "web_search", args: { query: "a" }, key: "key", signal: controller.signal, transport: async () => { called = true; return { status: 200, body: {} }; } });
  expect(called).toBe(false); expect(result).toMatchObject({ ok: false, code: "tool_interrupted" });
});
