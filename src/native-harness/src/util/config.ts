import { validateMcpServers } from "./mcp-config.ts";
import { validateWebConfig } from "./web-config.ts";
import { OPENCODE_GO_KEY_ENV, type CompatibleModel, type ManagedConfig, type ModelContextBudget, type ToolDecision, type ToolPolicy } from "../contracts/config-permissions.ts";
import { effectiveContextBudget, MAX_MODEL_REQUEST_BYTES } from "./context-budget.ts";

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

function modelContextBudget(input: unknown): { contextBudget?: ModelContextBudget } {
  if (input === undefined) return {};
  const field = "config.model.contextBudget", raw = record(input, field);
  const optional = ["outputReserveTokens", "maxOutputTokens", "estimationMarginTokens", "maxRequestBytes"] as const;
  keys(raw, ["contextWindowTokens", ...optional], field);
  function integer(key: keyof ModelContextBudget, min: number, max = Number.MAX_SAFE_INTEGER) {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
      return fail(`${field}.${key}`, `expected an integer from ${min} to ${max}`);
    return value;
  }
  const contextBudget: ModelContextBudget = { contextWindowTokens: integer("contextWindowTokens", 1) };
  for (const key of optional) if (raw[key] !== undefined)
    contextBudget[key] = integer(key, key === "estimationMarginTokens" ? 0 : 1, key === "maxRequestBytes" ? MAX_MODEL_REQUEST_BYTES : undefined);
  if (effectiveContextBudget(contextBudget).inputBudgetTokens <= 0) fail(field, "expected a positive input allowance after reserves");
  return { contextBudget };
}

function baseUrl(value: unknown): string {
  const field = "config.model.baseUrl", raw = name(value, field);
  const match = /^(https?):\/\/([^/]+)(?:\/|$)/i.exec(raw);
  if (!match || /[\s\\?#]/.test(raw) || match[2]!.includes("@")) return fail(field, "expected an HTTP(S) URL prefix without credentials, query or fragment");
  let url: URL;
  try { url = new URL(raw); } catch { return fail(field, "invalid URL"); }
  if (url.protocol === "http:") {
    const authority = match[2]!;
    const ipv4 = /^127(?:\.(?:0|[1-9]\d{0,2})){3}(?::\d+)?$/.test(authority) && url.hostname.startsWith("127.");
    const ipv6 = /^\[::1\](?::\d+)?$/.test(authority) && url.hostname === "[::1]";
    if (!ipv4 && !ipv6) return fail(field, "HTTP requires a canonical loopback IP literal");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Validate without side effects. Only explicitly requested legacy imports may
 * fill absent policy fields; partly specified modern configs are invalid. */
export function validateManagedConfig(input: unknown, legacy = false): ManagedConfig {
  const raw = record(input, "config"); keys(raw, ["version", "system", "model", "defaultPolicy", "policies", "timelineTools", "limits", "webSearch", "webFetch", "mcpServers"], "config");
  if (raw.version !== 1) fail("config.version", "expected version 1");
  if (typeof raw.system !== "string") fail("config.system", "expected a string");
  const model = record(raw.model, "config.model");
  if (model.imageInput !== undefined && typeof model.imageInput !== "boolean") fail("config.model.imageInput", "expected a boolean");
  const imageInput = model.imageInput === undefined ? {} : { imageInput: model.imageInput as boolean };
  let selectedModel: ManagedConfig["model"];
  if (model.protocol === "scripted") {
    keys(model, ["protocol", "script", "imageInput"], "config.model");
    selectedModel = { protocol: "scripted", script: name(model.script, "config.model.script"), ...imageInput };
  } else if (model.protocol === "openrouter") {
    keys(model, ["protocol", "model", "apiKeyEnv", "imageInput", "contextBudget"], "config.model");
    const reference = model.apiKeyEnv === undefined ? "OPENROUTER_API_KEY" : name(model.apiKeyEnv, "config.model.apiKeyEnv");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) fail("config.model.apiKeyEnv", "expected an environment variable name");
    selectedModel = { protocol: "openrouter", model: model.model === undefined ? "deepseek/deepseek-v4.1-flash" : name(model.model, "config.model.model"), apiKeyEnv: reference, ...imageInput, ...modelContextBudget(model.contextBudget) };
  } else if (model.protocol === "openai-compatible") {
    keys(model, ["protocol", "providerId", "model", "baseUrl", "apiKeyEnv", "contextBudget"], "config.model");
    const reference = model.apiKeyEnv === undefined ? undefined : name(model.apiKeyEnv, "config.model.apiKeyEnv");
    if (reference !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) fail("config.model.apiKeyEnv", "expected an environment variable name");
    selectedModel = { protocol: "openai-compatible", providerId: name(model.providerId, "config.model.providerId"),
      model: name(model.model, "config.model.model"), baseUrl: baseUrl(model.baseUrl), ...(reference === undefined ? {} : { apiKeyEnv: reference }), ...modelContextBudget(model.contextBudget) };
  } else if (model.protocol === "opencode-go") {
    keys(model, ["protocol", "model", "apiKeyEnv", "contextBudget"], "config.model");
    const reference = model.apiKeyEnv === undefined ? OPENCODE_GO_KEY_ENV : name(model.apiKeyEnv, "config.model.apiKeyEnv");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) return fail("config.model.apiKeyEnv", "expected an environment variable name");
    selectedModel = { protocol: "opencode-go", model: name(model.model, "config.model.model"), apiKeyEnv: reference, ...modelContextBudget(model.contextBudget) };
  } else return fail("config.model.protocol", "expected scripted, openrouter, openai-compatible or opencode-go");
  const isLegacy = legacy && raw.defaultPolicy === undefined && raw.policies === undefined;
  const defaultPolicy = isLegacy ? LEGACY_POLICY : name(raw.defaultPolicy, "config.defaultPolicy");
  const policiesInput = isLegacy ? { [LEGACY_POLICY]: { fallback: "allow", tools: {} } } : record(raw.policies, "config.policies");
  const policies: Record<string, ToolPolicy> = Object.create(null);
  for (const [policyName, rawPolicy] of Object.entries(policiesInput)) {
    name(policyName, "config.policies");
    const field = `config.policies.${policyName}`, policy = record(rawPolicy, field);
    keys(policy, ["fallback", "tools", "mcp"], field);
    const mcp = policy.mcp;
    if (mcp !== undefined && mcp !== "allow" && mcp !== "deny") return fail(`${field}.mcp`, "expected allow or deny");
    const toolInput = record(policy.tools, `${field}.tools`), tools: Record<string, ToolDecision> = Object.create(null);
    for (const [tool, rule] of Object.entries(toolInput)) { name(tool, `${field}.tools`); tools[tool] = decision(rule, `${field}.tools.${tool}`); }
    policies[policyName] = { fallback: decision(policy.fallback, `${field}.fallback`), tools, ...(mcp === undefined ? {} : { mcp }) };
  }
  if (!Object.hasOwn(policies, defaultPolicy)) fail("config.defaultPolicy", `unknown policy ${defaultPolicy}`);
  if (raw.timelineTools !== undefined && typeof raw.timelineTools !== "boolean") fail("config.timelineTools", "expected a boolean");
  let limits: ManagedConfig["limits"];
  if (raw.limits !== undefined) {
    const value = record(raw.limits, "config.limits");
    keys(value, ["unattendedTurns", "mcpCallTimeoutMs"], "config.limits");
    const { unattendedTurns, mcpCallTimeoutMs } = value;
    if (unattendedTurns !== undefined && (typeof unattendedTurns !== "number" || !Number.isSafeInteger(unattendedTurns) || unattendedTurns < 1))
      return fail("config.limits.unattendedTurns", "expected a positive safe integer");
    if (mcpCallTimeoutMs !== undefined && (typeof mcpCallTimeoutMs !== "number" || !Number.isInteger(mcpCallTimeoutMs) ||
      mcpCallTimeoutMs < 1000 || mcpCallTimeoutMs > 1_800_000)) return fail("config.limits.mcpCallTimeoutMs", "expected 1000–1800000 milliseconds");
    if (unattendedTurns === undefined && mcpCallTimeoutMs === undefined) return fail("config.limits", "expected at least one limit");
    limits = { ...(unattendedTurns === undefined ? {} : { unattendedTurns }), ...(mcpCallTimeoutMs === undefined ? {} : { mcpCallTimeoutMs }) };
  }
  const web = validateWebConfig({ webSearch: raw.webSearch, webFetch: raw.webFetch });
  if (!web.ok) return fail("config", web.error.message);
  let mcpServers: ManagedConfig["mcpServers"];
  if (raw.mcpServers !== undefined) {
    try { mcpServers = validateMcpServers(raw.mcpServers); }
    catch { return fail("config.mcpServers", "invalid server declaration"); }
  }
  return { ...web.value, ...(mcpServers === undefined ? {} : { mcpServers }), ...(limits ? { limits } : {}), ...(typeof raw.timelineTools === "boolean" ? { timelineTools: raw.timelineTools } : {}), version: 1, system: raw.system as string, model: selectedModel, defaultPolicy, policies };
}

/** Resolve only at execution open, never during validation or import. */
export function resolveCredential(model: Extract<ManagedConfig["model"], { protocol: "openrouter" }>, environment: Record<string, string | undefined>): string {
  const value = environment[model.apiKeyEnv];
  if (!value) return fail(`config.model.apiKeyEnv`, `environment variable ${model.apiKeyEnv} is missing or empty`);
  return value;
}


export function resolveCompatibleCredential(model: CompatibleModel,
  environment: Record<string, string | undefined>): string | undefined {
  const reference = model.apiKeyEnv ?? (model.protocol === "opencode-go" ? OPENCODE_GO_KEY_ENV : undefined);
  if (reference === undefined) return;
  const value = environment[reference];
  if (!value?.trim() || /[\r\n]/.test(value)) return fail("config.model.apiKeyEnv", "configured credential is missing, empty or invalid");
  return value;
}
