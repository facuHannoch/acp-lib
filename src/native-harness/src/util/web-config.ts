import type { ExaSearchConfig, WebFetchConfig, WebConfig } from "../contracts/config-permissions.ts";
export type { ExaSearchConfig, WebFetchConfig, WebConfig } from "../contracts/config-permissions.ts";
export type WebConfigError = { code: "invalid_config"; message: string };
export type Validated<T> = { ok: true; value: T } | { ok: false; error: WebConfigError };
const bad = (message: string): Validated<never> => ({ ok: false, error: { code: "invalid_config", message } });
function entry(value: unknown, operation: "search" | "fetch"): Validated<ExaSearchConfig | WebFetchConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad(`Invalid web ${operation} configuration`);
  const data = value as Record<string, unknown>, backend = data.backend;
  if (backend !== "exa" && !(operation === "fetch" && backend === "http")) return bad(`Invalid web ${operation} backend`);
  const allowed = operation === "search" ? ["backend", "apiKeyEnv", "maxResults", "excerptBytes", "deadlineMs"] : backend === "exa" ? ["backend", "apiKeyEnv", "deadlineMs"] : ["backend", "deadlineMs"];
  if (Object.keys(data).some(key => !allowed.includes(key))) return bad(`Unknown web ${operation} configuration field`);
  if (data.apiKeyEnv !== undefined && (typeof data.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(data.apiKeyEnv))) return bad("Invalid Exa credential environment name");
  for (const [field, min, max] of [["deadlineMs", 1000, 60000], ["maxResults", 1, 5], ["excerptBytes", 1, 512]] as const) {
    const n = data[field]; if (n !== undefined && (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max)) return bad(`Invalid ${field}`);
  }
  return { ok: true, value: structuredClone(data) as unknown as ExaSearchConfig | WebFetchConfig };
}
export function validateWebConfig(input: { webSearch?: unknown; webFetch?: unknown }): Validated<WebConfig> {
  const config: WebConfig = {};
  if (input.webSearch !== undefined) { const result = entry(input.webSearch, "search"); if (!result.ok) return result; config.webSearch = result.value as ExaSearchConfig; }
  if (input.webFetch !== undefined) { const result = entry(input.webFetch, "fetch"); if (!result.ok) return result; config.webFetch = result.value as WebFetchConfig; }
  return { ok: true, value: config };
}
/** Called for executable open only; no credential is persisted with config. */
export function resolveWebCredentials(config: WebConfig, env: Readonly<Record<string, string | undefined>>): Validated<{ searchKey?: string; fetchKey?: string }> {
  const keys: { searchKey?: string; fetchKey?: string } = {};
  for (const [field, value] of [["searchKey", config.webSearch], ["fetchKey", config.webFetch]] as const) {
    if (!value || value.backend !== "exa") continue;
    const name = value.apiKeyEnv ?? "EXA_API_KEY", secret = env[name];
    if (!secret?.trim()) return bad(`Missing or empty environment variable ${name}`);
    keys[field] = secret;
  }
  return { ok: true, value: keys };
}
