import { expect, test } from "bun:test";
import type { AgentHarnessConfig } from "../../src/agent/config.ts";
import { HarnessClientError } from "../../src/native-harness/src/client.ts";
import type { InferenceRelayGrantProviderResult, InferenceRelayGrantProvider } from "../../src/native/inference-relay.ts";
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
  let grant: InferenceRelayGrantProviderResult | undefined, grants = 0;
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
    grant = { baseUrl, bearerToken: token, lifetime: { mode: "process" }, grantRef: "host-only-reference" };
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
    grant = { baseUrl, lifetime: { mode: "process" }, bearerToken: "replacement-credential" };
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

test("failed relay opens clean up the exact reference before reissue and keep it off wire", async () => {
  const { executableRelayOpen, RelayIssuanceFence } = await import("../../src/native/inference-relay.ts");
  const fence = new RelayIssuanceFence(100), signal = new AbortController().signal;
  const calls: unknown[] = [];
  const provider = () => ({ baseUrl: "http://127.0.0.1/v1", bearerToken: "fixture-key",
    lifetime: { mode: "process" as const }, grantRef: "host-only-reference" });
  const cleanup = (value: unknown) => { calls.push(value); };
  await expect(executableRelayOpen(provider, "s", signal, async (grant, markSent) => {
    expect(JSON.stringify(grant)).not.toContain("host-only-reference");
    markSent();
    throw new HarnessClientError("timeout", "raw secret");
  }, cleanup, fence)).rejects.toMatchObject({ code: "timeout", message: "Native inference relay open failed" });
  await expect(executableRelayOpen(provider, "s", signal, async () => { throw Error("preflight"); }, cleanup, fence)).rejects.toThrow();
  expect(calls).toEqual([{ grantRef: "host-only-reference", delivery: "unknown" }, { grantRef: "host-only-reference", delivery: "not_sent" }]);
});

test("late grant gets one independent cleanup; unconfirmed fences later acquisition", async () => {
  const { executableRelayOpen, RelayIssuanceFence } = await import("../../src/native/inference-relay.ts");
  const fence = new RelayIssuanceFence(30), controller = new AbortController();
  const late = Promise.withResolvers<{ baseUrl: string; bearerToken: string; expiresAtMs: number; grantRef: string }>();
  const started = Promise.withResolvers<void>(), cleaned = Promise.withResolvers<unknown>();
  let calls = 0, sends = 0;
  const opening = executableRelayOpen(() => { calls++; started.resolve(); return late.promise; }, "s", controller.signal,
    async () => { sends++; }, value => { cleaned.resolve(value); }, fence);
  void opening.catch(() => {});
  await started.promise;
  controller.abort();
  await expect(fence.awaitIdle()).rejects.toMatchObject({ code: "relay_cleanup_unconfirmed" });
  late.resolve({ baseUrl: "http://127.0.0.1", bearerToken: "fixture", expiresAtMs: Date.now() + 1000, grantRef: "late" });
  expect(await cleaned.promise).toEqual({ grantRef: "late", delivery: "not_sent" });
  await expect(opening).rejects.toThrow();
  await expect(executableRelayOpen(() => { calls++; }, "s", new AbortController().signal, async () => {}, undefined, fence))
    .rejects.toMatchObject({ code: "relay_cleanup_unconfirmed" });
  expect([calls, sends]).toEqual([1, 0]);
});

test("outer native startup timeout waits for independently acknowledged late-grant cleanup", async () => {
  const rig = await nativeRig();
  const baseUrl = "http://127.0.0.1:1/v1";
  const enteredCleanup = Promise.withResolvers<{ grantRef: string; delivery: string }>();
  const finishCleanup = Promise.withResolvers<void>();
  rig.harness.config = {
    version: 1, system: "", defaultPolicy: "owner", policies: { owner: { fallback: "allow", tools: {} } },
    model: { protocol: "openai-compatible", credentialMode: "relay", providerId: "fixture", model: "fixture", baseUrl },
  };
  rig.harness.startupTimeoutMs = 600;
  rig.harness.inferenceRelayCleanupMs = 500;
  rig.harness.inferenceRelayGrant = ({ signal }) => new Promise(resolve => {
    const issue = () => resolve({ baseUrl, bearerToken: "late-fixture", lifetime: { mode: "process" }, grantRef: "late" });
    if (signal.aborted) issue();
    else signal.addEventListener("abort", issue, { once: true });
  });
  rig.harness.onInferenceRelayOpenFailure = value => { enteredCleanup.resolve(value); return finishCleanup.promise; };
  const agent = await rig.open();
  try {
    const channel = await agent.conversations.create();
    let settled = false;
    const result = channel.prompt("fixture").finally(() => { settled = true; });
    void result.catch(() => {});
    const cleanup = await Promise.race([enteredCleanup.promise, Bun.sleep(2000).then(() => { throw Error("No cleanup after deadline"); })]);
    expect(cleanup).toEqual({ grantRef: "late", delivery: "not_sent" });
    expect(settled).toBe(false);
    finishCleanup.resolve();
    await expect(result).rejects.toThrow(/did not open within/);
  } finally { finishCleanup.resolve(); await agent.close(); await rig.clean(); }
});

for (const behavior of ["reject", "stall"] as const) test(`relay cleanup ${behavior} fences reissue with a fixed diagnostic`, async () => {
  const { executableRelayOpen, RelayIssuanceFence } = await import("../../src/native/inference-relay.ts");
  const fence = new RelayIssuanceFence(20);
  expect(new RelayIssuanceFence().ms).toBe(10_000);
  let issued = 0;
  const provider = () => {
    issued++;
    return { baseUrl: "http://127.0.0.1", bearerToken: "fixture", lifetime: { mode: "process" as const }, grantRef: "host-only" };
  };
  const signal = new AbortController().signal;
  const invoke = () => executableRelayOpen(provider, "s", signal, async (_grant, markSent) => {
    markSent();
    throw new HarnessClientError("timeout", "fixture failure");
  }, async () => {
    if (behavior === "reject") throw Error("raw cleanup error");
    await new Promise(() => {});
  }, fence);
  await expect(invoke()).rejects.toMatchObject({ code: "relay_cleanup_unconfirmed", message: "Inference relay cleanup unconfirmed" });
  await expect(invoke()).rejects.toMatchObject({ code: "relay_cleanup_unconfirmed" });
  expect(issued).toBe(1);
});

test("cleanup beginning near the end of issuance wait keeps its own deadline", async () => {
  const { executableRelayOpen, RelayIssuanceFence } = await import("../../src/native/inference-relay.ts");
  const fence = new RelayIssuanceFence(200), abort = new AbortController();
  const pending = Promise.withResolvers<InferenceRelayGrantProviderResult>(), entered = Promise.withResolvers<void>();
  const opening = executableRelayOpen(() => { entered.resolve(); return pending.promise; }, "s", abort.signal,
    async () => { throw Error("Cancelled grant was sent"); }, async () => { await Bun.sleep(120); }, fence);
  const failed = opening.catch(error => error);
  await entered.promise;
  abort.abort();
  const idle = fence.awaitIdle();
  await Bun.sleep(140);
  pending.resolve({ baseUrl: "http://127.0.0.1", bearerToken: "fixture", lifetime: { mode: "process" }, grantRef: "fixture" });
  await idle;
  expect(await failed).toBe(abort.signal.reason);
});

test("a late acknowledgement leaves its SDK host fenced while independent and fresh hosts can open", async () => {
  const rig = await nativeRig(), independent = await nativeRig();
  const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response('data: {"choices":[{"delta":{"content":"fresh"},"finish_reason":"stop"}]}\n\n',
      { headers: { "content-type": "text/event-stream" } });
  } });
  const baseUrl = relay.url.origin;
  const config = {
    version: 1, system: "", defaultPolicy: "owner", policies: { owner: { fallback: "allow", tools: {} } },
    model: { protocol: "openai-compatible", credentialMode: "relay", providerId: "fixture", model: "fixture", baseUrl },
  } satisfies AgentHarnessConfig["config"];
  const material = () => ({ baseUrl, bearerToken: "fixture", lifetime: { mode: "process" as const } });
  const acknowledgement = Promise.withResolvers<void>();
  let issued = 0;
  Object.assign(rig.harness, { config, inferenceRelayCleanupMs: 30,
    inferenceRelayGrant: () => { issued++; return { ...material(), grantRef: "fixture-reference" }; },
    onInferenceRelayOpenFailure: () => acknowledgement.promise });
  Object.assign(independent.harness, { config, inferenceRelayGrant: material });
  const fenced = await rig.open(), other = await independent.open();
  try {
    const channel = await fenced.conversations.create();
    await expect(channel.prompt("fixture")).rejects.toThrow(/cleanup unconfirmed/i);
    const launches = rig.launches.length;
    acknowledgement.resolve();
    const otherChannel = await other.conversations.create();
    expect((await otherChannel.prompt("independent")).text).toBe("fresh");
    await expect(channel.prompt("must remain fenced")).rejects.toThrow(/cleanup unconfirmed/i);
    expect(issued).toBe(1);
    expect(rig.launches).toHaveLength(launches);
    await fenced.close();
    Object.assign(rig.harness, { inferenceRelayGrant: material, onInferenceRelayOpenFailure: undefined });
    const restarted = await rig.open();
    try {
      const fresh = await restarted.conversations.create();
      expect((await fresh.prompt("fresh process")).text).toBe("fresh");
      expect(rig.launches.length).toBeGreaterThan(launches);
    } finally { await restarted.close(); }
  } finally {
    acknowledgement.resolve();
    await fenced.close();
    await other.close();
    await rig.clean();
    await independent.clean();
    await relay.stop(true);
  }
});
