import { expect, test } from "bun:test";
import { spawnHarness } from "./helpers/stdio.ts";
import { once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { createServer as tlsServer } from "node:tls";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixedServiceTransport, resolveServiceEgress } from "../src/capabilities/tools/web/service-egress.ts";
import { exaServiceTransport } from "../src/capabilities/tools/web/exa-transport.ts";

test("service egress accepts only the trusted uppercase variable and canonical authority", () => {
  expect(resolveServiceEgress({ HTTPS_PROXY: "https://proxy.example" })).toEqual({ mode: "direct" });
  expect(resolveServiceEgress({ HARNESS_WEB_EGRESS: "" })).toEqual({ mode: "unavailable", reason: "invalid_egress_mode" });
  for (const proxy of ["http://proxy.example:8080", "https://[::1]:8080/"]) {
    expect(resolveServiceEgress({ HARNESS_WEB_EGRESS: "proxy-required", HTTPS_PROXY: proxy, NO_PROXY: "*" }))
      .toEqual({ mode: "proxy-required", proxy: new URL(proxy).origin });
  }
  for (const proxy of [undefined, "http://user@proxy.example", "http://proxy.example/a", "http://proxy.example/?", "http://proxy.example/#", "http:////proxy.example", "http://127.1", "http://0x7f000001"]) {
    expect(resolveServiceEgress({ HARNESS_WEB_EGRESS: "proxy-required", HTTPS_PROXY: proxy }))
      .toEqual({ mode: "unavailable", reason: "invalid_egress_proxy" });
  }
});

for (const secure of [false, true]) test(`Exa operations use the verified ${secure ? "HTTPS" : "HTTP"} CONNECT tunnel`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-egress-")), certFile = join(dir, "cert"), keyFile = join(dir, "key");
  expect(Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile,
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
  const cert = readFileSync(certFile), key = readFileSync(keyFile);
  let refuse = false, stall = false, redirect = false, holdResponse = false;
  const seen: string[] = [], payloads: unknown[] = [];
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key, cert }, async fetch(request) {
    if (request.headers.get("x-api-key") !== "fixture-only") return new Response(null, { status: 401 });
    payloads.push(await request.json());
    const path = new URL(request.url).pathname;
    if (holdResponse) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([123])); },
    }), { headers: { "content-type": "application/json" } });
    if (redirect) return new Response(null, { status: 302, headers: { location: "/must-not-follow" } });
    const source = "https://example.com/source";
    return Response.json({ ok: path, requestId: "request-fixture", costDollars: { total: 0 },
      results: [{ url: source, title: "Fixture", text: "Fixture result", highlights: ["Fixture result"] }],
      statuses: [{ id: source, status: "success" }] });
  } });
  const sockets = new Set<Socket>();
  const accept = (peer: Socket) => {
    sockets.add(peer);
    peer.on("error", () => {});
    peer.once("close", () => sockets.delete(peer));
    peer.once("data", chunk => {
      seen.push(chunk.toString("ascii"));
      if (stall) return;
      if (refuse) { peer.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); return; }
      const upstream = connect(service.port!, "127.0.0.1");
      sockets.add(upstream);
      upstream.on("error", () => peer.destroy());
      upstream.once("close", () => { sockets.delete(upstream); peer.destroy(); });
      peer.once("close", () => upstream.destroy());
      upstream.once("connect", () => {
        peer.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(peer).pipe(upstream);
      });
    });
  };
  const proxy = secure ? tlsServer({ key, cert }, accept) : createServer(accept);
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    const address = proxy.address();
    if (!address || typeof address === "string") throw Error("Missing fixture proxy address");
    const send = exaServiceTransport({ mode: "proxy-required", proxy: `${secure ? "https" : "http"}://127.0.0.1:${address.port}` }, service.url.origin, cert.toString());
    const signal = AbortSignal.timeout(2500);
    for (const path of ["/search", "/contents"] as const) {
      expect(await send({ path, key: "fixture-only", body: { query: "fixture" }, signal })).toMatchObject({ status: 200, body: { ok: path } });
    }
    expect(payloads).toHaveLength(2);
    expect(seen).toHaveLength(2);
    expect(seen.every(header => header.startsWith(`CONNECT 127.0.0.1:${service.port} HTTP/1.1\r\n`) && !/fixture-only|proxy-authorization/i.test(header))).toBe(true);
    const environment = { HARNESS_WEB_EGRESS: "proxy-required", HTTPS_PROXY: `${secure ? "https" : "http"}://127.0.0.1:${address.port}`,
      NO_PROXY: "*", NODE_EXTRA_CA_CERTS: certFile, TEST_SERVICE_ORIGIN: service.url.origin };
    const script = join(dir, "scenario.jsonl");
    writeFileSync(script, [
      { type: "scenario", version: 1, name: "proxy-fixture" },
      { type: "model", content: null, calls: [{ id: "search", name: "web_search", arguments: { query: "fixture" } },
        { id: "fetch", name: "web_fetch", arguments: { url: "https://example.com/source" } }] },
      { type: "model", content: "done" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    for (const variant of ["success", "refused", "disabled", "direct"] as const) {
      refuse = variant === "refused";
      const harness = spawnHarness({ entrypoint: new URL("./fixtures/service-egress-stdio.ts", import.meta.url).pathname,
        env: variant === "direct" ? { ...environment, HARNESS_WEB_EGRESS: "direct" } : environment, exaKey: "fixture-only" });
      const before = payloads.length, proxyBefore = seen.length;
      try {
        await harness.client.initialize();
        const result = await harness.client.createSession({ sessionId: "proxy", participants: [], channels: {}, config: {
          version: 1, system: "", model: { protocol: "scripted", script }, defaultPolicy: "owner",
          policies: { owner: { fallback: "allow", tools: {} } },
          webSearch: { backend: "exa" }, webFetch: { backend: variant === "disabled" ? "http" : "exa" },
        } });
        if (variant === "disabled") expect(result.webUnavailable).toEqual({ web_fetch: "direct_fetch_requires_direct_egress" });
        await harness.client.push({ channel: "channel", item: { id: "input", sender: "owner", kind: "user_message", content: [{ type: "text", text: "fixture" }] } });
        const deadline = performance.now() + 4000;
        while (!(await harness.client.idle()).idle) {
          if (performance.now() > deadline) throw Error("Proxy fixture did not settle");
          await Bun.sleep(5);
        }
        const { invocations } = await harness.client.toolInvocations("1");
        expect(invocations.map(call => call.webUsage?.cost.kind)).toEqual(variant === "success" || variant === "direct" ? ["provider_estimate", "provider_estimate"]
          : variant === "refused" ? ["unknown", "unknown"] : ["provider_estimate", "none"]);
        expect(payloads.length - before).toBe(variant === "success" || variant === "direct" ? 2 : variant === "refused" ? 0 : 1);
        if (variant === "direct") expect(seen).toHaveLength(proxyBefore);
      } finally { await harness.close(); }
    }

    refuse = false;
    const egress = resolveServiceEgress(environment);
    const args = { path: "/search" as const, key: "fixture-only", body: {}, signal: AbortSignal.timeout(5000) };
    let before = payloads.length;
    if (secure) {
      const untrusted = exaServiceTransport(egress, service.url.origin);
      await expect(untrusted(args)).rejects.toThrow("Service proxy connection or TLS failed");
    }
    const wrongOrigin = exaServiceTransport(egress, `https://wrong.example:${service.port}`, cert.toString());
    await expect(wrongOrigin(args)).rejects.toThrow("Service connection or TLS failed");
    expect(payloads).toHaveLength(before);
    const routed = exaServiceTransport(egress, service.url.origin, cert.toString());
    redirect = true;
    await expect(routed(args)).rejects.toThrow("Service redirect refused");
    expect(payloads).toHaveLength(++before);
    redirect = false;
    holdResponse = true;
    const abort = new AbortController();
    const streaming = routed({ ...args, signal: abort.signal });
    const deadline = performance.now() + 2000;
    while (payloads.length === before && performance.now() < deadline) await Bun.sleep(5);
    abort.abort();
    await expect(streaming).rejects.toThrow();
    expect(payloads).toHaveLength(++before);
    holdResponse = false;
    const fixed = fixedServiceTransport(service.url.origin, egress, cert.toString());
    await expect(fixed("//other.example/search", {}, "{}", args.signal)).rejects.toThrow("routing refused");
    await expect(fixed("/search", { Host: "other.example" }, "{}", args.signal)).rejects.toThrow("routing refused");
    if (!secure) {
      const second = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key, cert }, fetch(request) {
        return new Response(null, { status: request.headers.get("x-service-key") === "second-fixture-only" ? 204 : 403 });
      } });
      try {
        const sendSecond = fixedServiceTransport(second.url.origin, { mode: "direct" }, cert.toString());
        const result = await sendSecond("/other", { "x-service-key": "second-fixture-only" }, "{}", args.signal);
        try { expect(result.response.statusCode).toBe(204); }
        finally { await result.close(); }
        expect(payloads).toHaveLength(before);
      } finally { await second.stop(true); }
    }
    stall = true;
    await expect(routed({ ...args, signal: AbortSignal.timeout(75) })).rejects.toThrow();
    expect(payloads).toHaveLength(before);
    expect(seen.every(header => !/fixture-only|proxy-authorization/i.test(header))).toBe(true);

  } finally {
    for (const socket of sockets) socket.destroy();
    const stopped = once(proxy, "close");
    proxy.close();
    await stopped;
    await service.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid startup mode disables web entry-locally in standalone and stdio", async () => {
  const { openDevelopment } = await import("../src/interfaces/cli/development.ts");
  const dir = mkdtempSync(join(tmpdir(), "invalid-egress-")), script = join(dir, "scenario.jsonl");
  writeFileSync(script, '{"type":"scenario","version":1,"name":"invalid-egress"}\n{"type":"model","content":"done"}\n');
  const config = { version: 1 as const, system: "", model: { protocol: "scripted" as const, script }, defaultPolicy: "owner",
    policies: { owner: { fallback: "allow" as const, tools: {} } }, webSearch: { backend: "exa" as const } };
  const env = { HARNESS_WEB_EGRESS: "" };
  const harness = spawnHarness({ env });
  try {
    await harness.client.initialize();
    const result = await harness.client.createSession({ sessionId: "test", config, participants: [], channels: {} });
    const development = await openDevelopment({ systemPrompt: "", managedConfig: config, environment: env });
    try {
      expect(result.webUnavailable).toEqual({ web_search: "invalid_egress_mode" });
      expect(development.inspection.status().session.webUnavailable).toEqual(result.webUnavailable);
    } finally { await development.close(); }
  } finally { await harness.close(); rmSync(dir, { recursive: true, force: true }); }
});
