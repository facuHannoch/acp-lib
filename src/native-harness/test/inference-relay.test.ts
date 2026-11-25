import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProtocolConfig } from "../src/client.ts";
import { createInProcessHarness } from "../src/testing.ts";
import { validateManagedConfig } from "../src/util/config.ts";
import { canonicalRelayUrl } from "../src/util/inference-relay.ts";
import { decodeSessionFile } from "../src/state/storage/session-file.ts";

const configFor = (baseUrl: string) => ({
  version: 1, system: "Relay fixture", defaultPolicy: "all", policies: { all: { fallback: "allow", tools: {} } },
  model: { protocol: "openai-compatible", credentialMode: "relay", providerId: "relay", model: "fixture", baseUrl },
} satisfies ProtocolConfig);

test("relay comparison canonicalizes only the specified URL forms", () => {
  expect(canonicalRelayUrl("HTTP://10.250.0.4:80/v1/")).toBe("http://10.250.0.4/v1");
  expect(canonicalRelayUrl("HTTP://[fd00::1]:80/v1//")).toBe("http://[fd00::1]/v1");
  expect(canonicalRelayUrl("HTTPS://RELAY.Example:443/V1/")).toBe("https://relay.example/V1");
  for (const baseUrl of ["http://host/v1", "http://10.250.4", "http://010.250.0.4/v1", "http://0x0a.fa.0.4/v1",
    "http://[FD00::1]/v1", "http://[fd00:0:0:0:0:0:0:1]/v1", "http://[::ffff:a00:1]/v1", "http://[fe80::1%25zone]",
    "http://relay@10.250.0.4/v1", "http://10.250.0.4:080/v1", "http://10.250.0.4/v1?",
    "http://10.250.0.4/v1#", "http://10.250.0.4/a/../v1", "http://10.250.0.4/%76%31", "http://10.250.0.4/café", "https://0x7f.0.0.1/v1"])
    expect(() => validateManagedConfig(configFor(baseUrl))).toThrow("invalid inference relay URL");
  const config = configFor("http://10.250.0.4:8080/v1");
  expect(validateManagedConfig(config).model).toMatchObject({ baseUrl: config.model.baseUrl });
  expect(() => validateManagedConfig({ ...config, model: { ...config.model, apiKeyEnv: "UPSTREAM_KEY" } })).toThrow("requires runtime credentials");
  const { credentialMode: _, ...ordinary } = config.model;
  expect(() => validateManagedConfig({ ...config, model: ordinary })).toThrow("canonical loopback");
});

test("relay archives preserve only the portable declaration and need new runtime authority", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-archive-"));
  const destination = await mkdtemp(join(tmpdir(), "relay-import-"));
  const token = "archive-relay-credential";
  const config = configFor("http://10.250.0.4:8080/v1");
  const material = { baseUrl: config.model.baseUrl, bearerToken: token, expiresAtMs: Date.now() + 60_000 };
  const first = createInProcessHarness({ home });
  const restored = createInProcessHarness({ home: destination, environment: { UPSTREAM_KEY: "upstream-key" } });
  try {
    await first.client.initialize();
    await first.client.createSession({ sessionId: "relay", config, participants: [], channels: {}, inferenceRelayGrant: material });
    await first.client.suspend();
    const archive = await first.client.exportArchive();
    expect(Buffer.from(archive).includes(token)).toBe(false);
    const decoded = decodeSessionFile(archive, 268435456);
    expect(JSON.stringify(decoded)).not.toContain("inferenceRelayGrant");
    expect(JSON.stringify(decoded)).not.toContain(token);
    expect(decoded).toMatchObject({ config });
    await restored.client.initialize();
    await restored.client.validateConfig(config);
    await restored.client.importArchive(archive);
    const path = join(destination, "relay", "session.sqlite");
    using writable = new Database(path);
    // Simulate an owner that exited during suspension. A successful executable
    // open would recover this interrupted state.
    writable.run("UPDATE meta SET value = 'suspending' WHERE key = 'lifecycle'");
    writable.close();
    await expect(restored.client.openSession({ sessionId: "relay" })).rejects.toMatchObject({ code: "invalid_config" });
    using readOnly = new Database(path, { readonly: true });
    expect(readOnly.query("SELECT value FROM meta WHERE key = 'lifecycle'").get()).toEqual({ value: "suspending" });
    readOnly.close();
    await restored.client.openSession({ sessionId: "relay", inferenceRelayGrant: { ...material, bearerToken: "new-relay-credential" } });
    await expect(restored.client.openSession({ sessionId: "relay", inferenceRelayGrant: material })).rejects.toMatchObject({ code: "invalid_params" });
  } finally {
    first.close();
    restored.close();
    await rm(home, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

test("expiry on an open relay session prevents dispatch", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-expiry-"));
  const harness = createInProcessHarness({ home });
  const now = Date.now(), clock = spyOn(Date, "now");
  let received = 0;
  const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { received++; return new Response(); } });
  const config = configFor(relay.url.origin + "/v1");
  try {
    clock.mockReturnValue(now);
    await harness.client.initialize();
    await harness.client.createSession({ sessionId: "relay", config, participants: [], channels: {},
      inferenceRelayGrant: { baseUrl: config.model.baseUrl, bearerToken: "expired-relay-fixture", expiresAtMs: now + 10 } });
    clock.mockReturnValue(now + 20);
    const ended = Promise.withResolvers<string | undefined>();
    const stop = harness.client.onChannelEvent(({ event }) => { if (event.type === "turn_ended") ended.resolve(event.error); });
    try {
      await harness.client.push({ channel: "fixture", item: { kind: "user_message", sender: "user", id: "one", content: [{ type: "text", text: "go" }] } });
      expect(await ended.promise).toContain("Inference relay credential expired");
      expect(received).toBe(0);
    } finally { stop(); }
  } finally {
    clock.mockRestore();
    relay.stop(true);
    harness.close();
    await rm(home, { recursive: true, force: true });
  }
});
