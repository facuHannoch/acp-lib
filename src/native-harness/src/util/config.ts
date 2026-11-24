import type { ManagedConfig, ToolDecision, ToolPolicy } from "../contracts/config-permissions.ts";

/** The upgrade preserves the behavior of sessions created before policies existed. */
export const LEGACY_POLICY = "__legacy_allow";
export class ConfigError extends Error {
  constructor(readonly field: string, message: string) { super(`${field}: ${message}`); }
}
const fail = (field: string, message: string): never => { throw new ConfigError(field, message); };
const record = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(field, "expected an object");
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: string[], field: string) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${field}.${key}`, "unknown field");
};
const name = (value: unknown, field: string): string => typeof value === "string" && value.trim() ? value : fail(field, "expected a nonempty string");
const decision = (value: unknown, field: string): ToolDecision => value === "allow" || value === "ask" || value === "deny" ? value : fail(field, "expected allow, ask or deny");

/** Validate without side effects. Only explicitly requested legacy imports may
 * fill absent policy fields; partly specified modern configs are invalid. */
export function validateManagedConfig(input: unknown, legacy = false): ManagedConfig {
  const raw = record(input, "config"); keys(raw, ["version", "system", "model", "defaultPolicy", "policies", "timelineTools"], "config");
  if (raw.version !== 1) fail("config.version", "expected version 1");
  if (typeof raw.system !== "string") fail("config.system", "expected a string");
  const model = record(raw.model, "config.model");
  let selectedModel: ManagedConfig["model"];
  if (model.protocol === "scripted") {
    keys(model, ["protocol", "script"], "config.model");
    selectedModel = { protocol: "scripted", script: name(model.script, "config.model.script") };
  } else if (model.protocol === "openrouter") {
    keys(model, ["protocol", "model", "apiKeyEnv"], "config.model");
    const reference = model.apiKeyEnv === undefined ? "OPENROUTER_API_KEY" : name(model.apiKeyEnv, "config.model.apiKeyEnv");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) fail("config.model.apiKeyEnv", "expected an environment variable name");
    selectedModel = { protocol: "openrouter", model: model.model === undefined ? "deepseek/deepseek-v4.1-flash" : name(model.model, "config.model.model"), apiKeyEnv: reference };
  } else return fail("config.model.protocol", "expected scripted or openrouter");
  const isLegacy = legacy && raw.defaultPolicy === undefined && raw.policies === undefined;
  const defaultPolicy = isLegacy ? LEGACY_POLICY : name(raw.defaultPolicy, "config.defaultPolicy");
  const policiesInput = isLegacy ? { [LEGACY_POLICY]: { fallback: "allow", tools: {} } } : record(raw.policies, "config.policies");
  const policies: Record<string, ToolPolicy> = Object.create(null);
  for (const [policyName, rawPolicy] of Object.entries(policiesInput)) {
    name(policyName, "config.policies");
    const field = `config.policies.${policyName}`, policy = record(rawPolicy, field);
    keys(policy, ["fallback", "tools"], field);
    const toolInput = record(policy.tools, `${field}.tools`), tools: Record<string, ToolDecision> = Object.create(null);
    for (const [tool, rule] of Object.entries(toolInput)) { name(tool, `${field}.tools`); tools[tool] = decision(rule, `${field}.tools.${tool}`); }
    policies[policyName] = { fallback: decision(policy.fallback, `${field}.fallback`), tools };
  }
  if (!Object.hasOwn(policies, defaultPolicy)) fail("config.defaultPolicy", `unknown policy ${defaultPolicy}`);
  if (raw.timelineTools !== undefined && typeof raw.timelineTools !== "boolean") fail("config.timelineTools", "expected a boolean");
  return { ...(typeof raw.timelineTools === "boolean" ? { timelineTools: raw.timelineTools } : {}), version: 1, system: raw.system as string, model: selectedModel, defaultPolicy, policies };
}

/** Resolve only at execution open, never during validation or import. */
export function resolveCredential(model: Extract<ManagedConfig["model"], { protocol: "openrouter" }>, environment: Record<string, string | undefined>): string {
  const value = environment[model.apiKeyEnv];
  if (!value) return fail(`config.model.apiKeyEnv`, `environment variable ${model.apiKeyEnv} is missing or empty`);
  return value;
}
