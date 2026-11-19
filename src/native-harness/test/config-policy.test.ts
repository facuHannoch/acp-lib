import { expect, test } from "bun:test";
import { validateManagedConfig, LEGACY_POLICY } from "../src/runtime/config/managed.ts";
import { policyFingerprint, resolvePolicy, toolDecision } from "../src/governance/policy/resolve.ts";
import { createInProcessHarness } from "../src/testing.ts";
import { spawnHarness } from "./helpers/stdio.ts";
const base = { version: 1, system: "S", model: { protocol: "scripted", script: "script.json" } };
const value = { ...base, defaultPolicy: "default", policies: {
  default: { fallback: "allow", tools: { edit: "ask", safe: "allow" } },
  strict: { fallback: "deny", tools: { safe: "allow" } },
  review: { fallback: "ask", tools: { safe: "allow" } },
} };
test("configuration validation identifies fields and upgrades only complete legacy shapes", () => {
  expect(validateManagedConfig(base, true)).toMatchObject({ defaultPolicy: LEGACY_POLICY, policies: { [LEGACY_POLICY]: { fallback: "allow", tools: {} } } });
  expect(() => validateManagedConfig(base)).toThrow("config.defaultPolicy");
  expect(() => validateManagedConfig({ ...base, defaultPolicy: "x" }, true)).toThrow("config.policies");
  expect(() => validateManagedConfig({ ...value, defaultPolicy: "missing" })).toThrow("config.defaultPolicy");
  expect(() => validateManagedConfig({ ...value, model: { ...value.model, script: " " } })).toThrow("config.model.script");
  expect(() => validateManagedConfig({ ...value, extra: true })).toThrow("config.extra");
});
test("policy precedence and fingerprints depend on named contributing rules", () => {
  const config = validateManagedConfig(value);
  expect(resolvePolicy(config)).toBe("default");
  expect(resolvePolicy(config, undefined, "strict")).toBe("strict");
  expect(resolvePolicy(config, "review", "strict")).toBe("review");
  expect(() => resolvePolicy(config, "unknown")).toThrow("Unknown policy");
  expect(toolDecision(config, ["default", "strict"], "edit")).toBe("deny");
  expect(toolDecision(config, ["default", "review"], "edit")).toBe("ask");
  expect(toolDecision(config, ["default", "strict"], "safe")).toBe("allow");
  expect(policyFingerprint(config, ["review", "strict", "review"])).toBe(policyFingerprint(config, ["strict", "review"]));
  const changed = validateManagedConfig({ ...value, policies: { ...value.policies, default: { fallback: "deny", tools: {} } } });
  expect(policyFingerprint(changed, ["strict"])).toBe(policyFingerprint(config, ["strict"]));
  expect(policyFingerprint(changed, ["default"])).not.toBe(policyFingerprint(config, ["default"]));
});
for (const transport of ["in-process", "stdio"] as const) test(`${transport}: validate config without creating a session`, async () => {
  const harness = transport === "stdio" ? spawnHarness() : createInProcessHarness();
  try {
    await harness.client.initialize();
    expect(await harness.client.validateConfig(value)).toEqual({ valid: true });
    await expect(harness.client.validateConfig({ ...value, defaultPolicy: "missing" })).rejects.toMatchObject({ code: "invalid_config", message: expect.stringContaining("config.defaultPolicy") });
    await expect(harness.client.status()).rejects.toMatchObject({ code: "not_ready" });
  } finally { await harness.close(); }
});

test("dedup distinguishes an explicit override and notice restrictions propagate", async () => {
  const { legacyItemSignature, policyItemSignature, contributingPolicies } = await import("../src/state/storage/policy-metadata.ts");
  const item = { kind: "participant_message", channelId: "a", senderId: "u", text: "same" };
  expect(policyItemSignature(item)).toBe(policyItemSignature({ ...item, explicitPolicy: null }));
  expect(policyItemSignature(item)).not.toBe(policyItemSignature({ ...item, explicitPolicy: "default" }));
  expect(policyItemSignature(item)).not.toBe(legacyItemSignature(item));
  expect(contributingPolicies([{ resolved: "target", inherited: ["strict", "older"] }, { resolved: "strict", inherited: ["older", "other"] }]))
    .toEqual(["target", "strict", "older", "other"]);
});
