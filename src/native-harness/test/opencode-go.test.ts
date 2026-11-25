import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInProcessHarness } from "../src/testing.ts";
import type { ProtocolConfig } from "../src/client.ts";
import { compatibleInferenceKey } from "../src/runtime/config/inference-key.ts";
import { validateManagedConfig } from "../src/util/config.ts";

const config = {
  version: 1, system: "Go provider fixture", defaultPolicy: "allow",
  policies: { allow: { fallback: "allow", tools: {} } },
  model: { protocol: "opencode-go", model: "deepseek-v4.1-flash", contextBudget: { contextWindowTokens: 32_000 } },
} satisfies ProtocolConfig;

test("Go config fixes its destination and credential rotation preserves checkpoint identity", () => {
  expect(validateManagedConfig(config).model).toMatchObject({ apiKeyEnv: "OPENCODE_API_KEY" });
  for (const field of [{ baseUrl: "https://example.test" }, { headers: {} }, { imageInput: true }, { apiKeyEnv: "bad key" }]) {
    expect(() => validateManagedConfig({ ...config, model: { ...config.model, ...field } })).toThrow("config.model");
  }
  const key = (model: typeof config.model & { apiKeyEnv?: string }) => compatibleInferenceKey(model, config.system, []);
  expect(key(config.model)).toBe(key({ ...config.model, apiKeyEnv: "ROTATED" }));
  expect(key(config.model)).not.toBe(key({ ...config.model, model: "another" }));
});

test("Go routing is channel-scoped, survives executable reopen, and reports safe provider failures", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-go-"));
  const secret = "fixture-go-secret";
  const requests: { url: string; headers: Headers; redirect?: string; body: string }[] = [];
  let mode: "ok" | "missing" | "rate" | "rotate" | "redirect" = "ok";
  let failedOnce = false;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], options?: Parameters<typeof globalThis.fetch>[1]) => {
    requests.push({ url: String(input), headers: new Headers(options?.headers), redirect: options?.redirect, body: String(options?.body) });
    if (mode === "missing") return Response.json({ type: "MissingSessionID", message: secret }, { status: 400 });
    if (mode === "rotate") return Response.json({ error: { message: secret } }, { status: 401 });
    if (mode === "redirect") return new Response(null, { status: 307, headers: { location: "https://example.test" } });
    if (mode === "rate" && !failedOnce) { failedOnce = true; return Response.json({ message: secret }, { status: 429 }); }
    return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
  }, { preconnect: globalThis.fetch.preconnect }));
  let harness = createInProcessHarness({ home, environment: { OPENCODE_API_KEY: secret } });
  let item = 0;
  async function turn(channel: string) {
    const ended = Promise.withResolvers<string | undefined>();
    const unsubscribe = harness.client.onChannelEvent(value => {
      if (value.channel === channel && value.event.type === "turn_ended") ended.resolve(value.event.error);
    });
    try {
      await harness.client.push({ channel, item: { kind: "user_message", id: String(++item), sender: "fixture",
        content: [{ type: "text", text: "fixture" }] } });
      return await ended.promise;
    } finally { unsubscribe(); }
  }
  try {
    await harness.client.initialize();
    await harness.client.createSession({ sessionId: "fixture-session", config, participants: [], channels: {} });
    mode = "missing";
    expect(await turn("one")).toBe("OpenCode Go HTTP 400 (missing_session_id)");
    mode = "rate";
    expect(await turn("one")).toBeUndefined();
    expect(requests).toHaveLength(3);
    expect(requests[2]?.body).toBe(requests[1]?.body);
    mode = "rotate";
    expect(await turn("two")).toBe("OpenCode Go HTTP 401 (invalid_api_key)");
    mode = "redirect";
    expect(await turn("two")).toBe("OpenCode Go HTTP 307 (redirect_refused)");
    await harness.client.suspend();
    expect(Buffer.from(await harness.client.exportArchive()).includes(secret)).toBe(false);
    harness.close();

    harness = createInProcessHarness({ home, environment: { OPENCODE_API_KEY: secret } });
    await harness.client.initialize();
    await harness.client.openSession({ sessionId: "fixture-session" });
    await harness.client.resume();
    mode = "ok";
    expect(await turn("one")).toBeUndefined();
    const session = (index: number) => requests[index]?.headers.get("x-opencode-session");
    expect(session(0)).toMatch(/^ses_[a-f0-9]{64}$/);
    expect([session(1), session(2), session(5)]).toEqual([session(0), session(0), session(0)]);
    expect(session(3)).not.toBe(session(0));
    expect(session(4)).toBe(session(3));
    for (const request of requests) {
      expect(request.url).toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("user-agent")).toBe("acp-client/native-harness");
      expect(request.headers.get("authorization")).toBe("Bearer " + secret);
      expect(JSON.parse(request.body).model).toBe("deepseek-v4.1-flash");
      expect(request.body).not.toContain(secret);
    }
  } finally {
    harness.close();
    fetch.mockRestore();
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);
