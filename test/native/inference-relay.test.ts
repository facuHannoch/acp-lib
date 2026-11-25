import { expect, test } from "bun:test";
import type { AgentHarnessConfig } from "../../src/agent/config.ts";
import type { InferenceRelayGrant, InferenceRelayGrantProvider } from "../../src/native/inference-relay.ts";
import { nativeRig } from "./support.ts";

test("native stdio binds inference to a fresh relay grant and bypasses ambient proxies", async () => {
  const rig = await nativeRig();
  const token = "relay-fixture-credential";
  const received: { path: string; bearer: string | null }[] = [];
  let proxyRequests = 0, redirect = false;
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { proxyRequests++; return new Response("proxy trap"); } });
  const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    received.push({ path: new URL(request.url).pathname, bearer: request.headers.get("authorization") });
    if (redirect) return Response.redirect(proxy.url);
    return new Response([
      { choices: [{ delta: { content: "safe relay-fixture-" } }] },
      { choices: [{ delta: { content: "credential" }, finish_reason: "stop" }] },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  } });
  const baseUrl = `http://127.0.0.1:${relay.port}/v1`;
  const config = {
    version: 1, system: "Safe fixture", defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } },
    model: { protocol: "openai-compatible", credentialMode: "relay", providerId: "relay", model: "fixture", baseUrl },
  } satisfies AgentHarnessConfig["config"];
  rig.harness.config = config;
  Object.assign(rig.env, { HTTP_PROXY: proxy.url.href, http_proxy: proxy.url.href, NO_PROXY: "", no_proxy: "",
    OPENROUTER_API_KEY: "upstream-key-canary" });
  let grant: InferenceRelayGrant | undefined, grants = 0;
  const provider: InferenceRelayGrantProvider = ({ sessionId, signal }) => {
    expect(sessionId).toBeTruthy();
    expect(signal.aborted).toBe(false);
    grants++;
    return grant;
  };
  rig.harness.inferenceRelayGrant = provider;
  const material = () => ({ baseUrl: baseUrl + "/", bearerToken: token, expiresAtMs: Date.now() + 60_000 });
  try {
    for (const denied of [undefined, { ...material(), baseUrl: baseUrl + "/wrong" },
      { ...material(), expiresAtMs: 1 }, { ...material(), bearerToken: "" }]) {
      grant = denied;
      const agent = await rig.open();
      try {
        const channel = await agent.conversations.create();
        await expect(channel.prompt("relay fixture")).rejects.toThrow();
        expect(received).toHaveLength(0);
      } finally { await agent.close(); }
    }
    grant = material();
    const agent = await rig.open();
    try {
      const channel = await agent.conversations.create();
      const result = await channel.prompt("relay fixture");
      expect(result.text).toBe("safe [relay credential hidden]");
      expect(received).toEqual([{ path: "/v1/chat/completions", bearer: "Bearer " + token }]);
      redirect = true;
      await expect(channel.prompt("redirect")).rejects.toThrow("redirect refused");
      expect(received).toHaveLength(2);
    } finally { await agent.close(); }
    redirect = false;
    const before = grants;
    grant = { ...material(), bearerToken: "replacement-credential" };
    const reopened = await rig.open();
    try {
      const channel = await reopened.conversations.create();
      await channel.prompt("relay fixture after reopen");
      expect(grants).toBeGreaterThan(before);
      expect(received.at(-1)?.bearer).toBe("Bearer replacement-credential");
      expect(proxyRequests).toBe(0);
    } finally { await reopened.close(); }
  } finally {
    await rig.clean();
    relay.stop(true);
    proxy.stop(true);
  }
}, 25_000);
