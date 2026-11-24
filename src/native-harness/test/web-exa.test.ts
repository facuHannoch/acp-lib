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
  for (const url of ["http://127.0.0.1/", "http://2130706433/", "https://localhost/", "https://localhost./", "https://host.internal/", "http://10.0.0.1/", "http://[::1]/", "https://user:pass@example.com/", "https://example.com/#x"]) expect(normalizedWebUrl(url)).toBeUndefined();
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

test("production Exa transport sends fixed-origin headers and does not follow redirects", async () => {
  const { createExaHttpsTransport } = await import("../src/capabilities/tools/web/exa-transport.ts");
  const { Writable, Readable } = await import("node:stream");
  const requests: Array<{ options: any; payload: string }> = [];
  const send = ((options: any, callback: (response: any) => void) => {
    let payload = "";
    return new Writable({
      write(chunk, _encoding, done) { payload += chunk.toString(); done(); },
      final(done) {
        requests.push({ options, payload });
        const response = Object.assign(Readable.from([Buffer.from('{"requestId":"id","costDollars":{"total":0}}')]), { statusCode: 302, headers: { location: "https://hostile.invalid/" } });
        callback(response); done();
      },
    });
  }) as unknown as typeof import("node:https").request;
  const result = await runExa({ operation: "web_search", args: { query: "x" }, key: "canary", transport: createExaHttpsTransport(send) });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.options).toMatchObject({ protocol: "https:", hostname: "api.exa.ai", path: "/search", method: "POST", headers: { "x-api-key": "canary", "content-type": "application/json" } });
  expect(JSON.parse(requests[0]!.payload).query).toBe("x");
  expect(result).toMatchObject({ ok: false, code: "provider_error", usage: { requestId: "id", usd: 0 } });
});

 test("invalid arguments fail before provider transport", async () => {
  let called = false;
  const result = await runExa({ operation: "web_search", args: { query: " " }, key: "key", transport: async () => { called = true; return { status: 200, body: {} }; } });
  expect(called).toBe(false); expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
});

test("usage projection distinguishes denial, unknown, zero and legacy", async () => {
  const { webUsageView } = await import("../src/capabilities/tools/web/usage.ts");
  const exa = { backend: "exa" as const, operation: "web_fetch" as const, paid: true as const };
  expect(webUsageView({ knownWebCall: false, dispatched: true })).toBeUndefined();
  expect(webUsageView({ knownWebCall: true, dispatched: true })).toBeUndefined();
  expect(webUsageView({ knownWebCall: true, dispatched: false })).toEqual({ cost: { kind: "none" } });
  expect(webUsageView({ knownWebCall: true, dispatched: true, evidence: exa })).toEqual({ backend: "exa", operation: "web_fetch", cost: { kind: "unknown" } });
  expect(webUsageView({ knownWebCall: true, dispatched: true, evidence: exa, committedUsage: { requestId: "req", usd: 0 } })).toEqual({ backend: "exa", operation: "web_fetch", requestId: "req", cost: { kind: "provider_estimate", usd: 0 } });
  expect(webUsageView({ knownWebCall: true, dispatched: true, evidence: { ...exa, backend: "http", paid: false } })).toEqual({ backend: "http", operation: "web_fetch", cost: { kind: "none" } });
});

test("registry exposes only enabled tools and freezes nonsecret dispatch attribution", async () => {
  const { createWebRegistry } = await import("../src/capabilities/tools/web/registry.ts");
  let exaCalls = 0, httpCalls = 0;
  const providers = { exa: async () => { exaCalls++; return { status: 200, body: { results: [] } }; }, http: async () => { httpCalls++; return { ok: true as const, content: "{}", usage: {} }; } };
  const result = createWebRegistry({ webSearch: { backend: "exa" }, webFetch: { backend: "http" } }, { EXA_API_KEY: "canary" }, providers);
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.value.map(x => x.definition.name)).toEqual(["web_search", "web_fetch"]);
  expect(result.value.map(x => x.dispatch)).toEqual([{ backend: "exa", operation: "web_search", paid: true }, { backend: "http", operation: "web_fetch", paid: false }]);
  expect(JSON.stringify(result.value)).not.toContain("canary");
  const signal = new AbortController().signal;
  expect(await result.value[1]!.execute({ url: "http://127.0.0.1" }, signal)).toMatchObject({ ok: false, code: "invalid_arguments" });
  expect(httpCalls).toBe(0); expect(exaCalls).toBe(0);
  expect(createWebRegistry({}, {}, providers)).toEqual({ ok: true, value: [] });
  expect(createWebRegistry({ webFetch: { backend: "http" } }, {}, { exa: providers.exa })).toMatchObject({ ok: false, error: { code: "invalid_config" } });
});

test("registry freezes open-time settings and direct fetch carries no provider usage", async () => {
  const { createWebRegistry } = await import("../src/capabilities/tools/web/registry.ts");
  const config: import("../src/capabilities/tools/web/config.ts").WebConfig = { webSearch: { backend: "exa", maxResults: 3 }, webFetch: { backend: "http", deadlineMs: 2000 } };
  let searchBody: any, directDeadline = 0;
  const result = createWebRegistry(config, { EXA_API_KEY: "key" }, { exa: async request => { searchBody = request.body; return { status: 200, body: { results: [] } }; }, http: async (_url, _signal, deadline) => { directDeadline = deadline; return { ok: true, content: "{}", usage: { usd: 123, requestId: "fake" } }; } });
  if (!result.ok) throw new Error(result.error.message);
  config.webSearch!.maxResults = 5; config.webFetch!.deadlineMs = 60000;
  const signal = new AbortController().signal;
  await result.value[0]!.execute({ query: "search" }, signal);
  expect(searchBody.numResults).toBe(3);
  const direct = await result.value[1]!.execute({ url: "https://example.com/" }, signal);
  expect(directDeadline).toBe(2000); expect(direct.usage).toEqual({});
});

test("untrusted provider request IDs are bounded and control-free", async () => {
  for (const requestId of ["x".repeat(257), "id\nwith-control", "  "]) {
    const result = await runExa({ operation: "web_search", args: { query: "x" }, key: "secret", transport: async () => ({ status: 200, body: { requestId, results: [] } }) });
    expect(result.usage.requestId).toBeUndefined();
  }
});

test("web usage facts reject invalid archive shapes and preserve explicit zero", async () => {
  const { validCommittedWebUsage, validWebDispatch } = await import("../src/capabilities/tools/web/usage.ts");
  expect(validWebDispatch({ backend: "exa", operation: "web_search", paid: true })).toBe(true);
  expect(validWebDispatch({ backend: "exa", operation: "web_search", paid: false })).toBe(false);
  expect(validWebDispatch({ backend: "http", operation: "web_search", paid: false })).toBe(false);
  expect(validWebDispatch({ backend: "http", operation: "web_fetch", paid: false, credential: "x" })).toBe(false);
  expect(validCommittedWebUsage({ requestId: "req", usd: 0 })).toBe(true);
  for (const value of [{ usd: -1 }, { usd: NaN }, { requestId: "bad\nid" }, { usd: null }, { secret: "x" }]) expect(validCommittedWebUsage(value)).toBe(false);
});

test("hosted production response pipeline rejects decoded and wire overflow", async () => {
  const { createExaHttpsTransport } = await import("../src/capabilities/tools/web/exa-transport.ts");
  const limit = 2 * 1024 * 1024;
  for (const fixture of [{ bytes: Buffer.alloc(limit + 1, 0x61), encoding: "identity" }, { bytes: gzipSync(Buffer.alloc(limit + 1, 0x61)), encoding: "gzip" }]) {
    const send = ((_options: any, callback: (response: any) => void) => new Writable({
      write(_chunk, _encoding, done) { done(); }, final(done) {
        callback(Object.assign(Readable.from([fixture.bytes]), { statusCode: 200, headers: { "content-encoding": fixture.encoding } })); done();
      },
    })) as unknown as typeof import("node:https").request;
    const result = await runExa({ operation: "web_search", args: { query: "x" }, key: "key", transport: createExaHttpsTransport(send) });
    expect(result).toMatchObject({ ok: false, code: "response_too_large", usage: {} });
  }
});

test("hosted production response stream is destroyed on deadline", async () => {
  const { createExaHttpsTransport } = await import("../src/capabilities/tools/web/exa-transport.ts");
  let response: Readable | undefined;
  const send = ((_options: any, callback: (response: any) => void) => new Writable({
    write(_chunk, _encoding, done) { done(); }, final(done) {
      response = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} });
      callback(response); done();
    },
  })) as unknown as typeof import("node:https").request;
  const result = await runExa({ operation: "web_search", args: { query: "x" }, key: "key", deadlineMs: 10, transport: createExaHttpsTransport(send) });
  expect(result).toMatchObject({ ok: false, code: "tool_timeout", usage: {} });
  expect(response?.destroyed).toBe(true);
});
