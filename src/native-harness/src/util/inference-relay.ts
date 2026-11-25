import type { ManagedModel } from "../contracts/config-permissions.ts";
import type { InferenceRelayGrant } from "../contracts/protocol.ts";

/** Strict grammar for the execution exception, checked before URL rewrites. */
export function canonicalRelayUrl(raw: unknown): string {
  const invalid = () => new Error("Invalid inference relay base URL");
  if (typeof raw !== "string" || raw.length > 2048 || /[\s\\?#%\p{Cc}\p{Cf}]/u.test(raw)) throw invalid();
  const match = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(raw);
  if (!match || match[2]!.includes("@") || match[3]?.split("/").some(segment => segment === "." || segment === ".."))
    throw invalid();
  let url: URL;
  try { url = new URL(raw); } catch { throw invalid(); }
  // Anything encoded by URL parsing would fail the portable declaration's
  // next validation pass, just like an explicit escape in the input.
  if (url.pathname.includes("%")) throw invalid();
  if (url.protocol === "http:") {
    const authority = /^(\[[0-9a-f:]+\]|(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})(?::(0|[1-9]\d{0,4}))?$/.exec(match[2]!);
    if (!authority || authority[1] !== url.hostname || /^\[::ffff:/i.test(url.hostname)) throw invalid();
  } else {
    const authority = /^(\[[0-9a-f:]+\]|[a-z\d.-]+)(?::(?:0|[1-9]\d{0,4}))?$/i.exec(match[2]!);
    if (!authority || (!authority[1]!.startsWith("[") && authority[1]!.toLowerCase() !== url.hostname))
      throw invalid();
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** The validated grant is detached from the request and held only in memory. */
export function resolveInferenceRelayGrant(model: ManagedModel, value: unknown,
  now = Date.now()): InferenceRelayGrant | undefined {
  const failure = (reason: string): never => { throw new Error(`Inference relay grant ${reason}`); };
  if (model.protocol !== "openai-compatible" || model.credentialMode !== "relay") {
    if (value !== undefined) failure("requires relay credential mode");
    return;
  }
  if (value === undefined) return failure("is required");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["baseUrl", "bearerToken", "expiresAtMs"].includes(key))) return failure("is invalid");
  const { baseUrl, bearerToken, expiresAtMs } = value as Partial<InferenceRelayGrant>;
  if (typeof bearerToken !== "string" || !/^[A-Za-z0-9._~+/-]{1,2048}={0,2}$/.test(bearerToken)
    || typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs)) return failure("is invalid");
  let endpoint: string;
  try { endpoint = canonicalRelayUrl(baseUrl); } catch { return failure("is invalid"); }
  if (endpoint !== model.baseUrl) return failure("does not match the configured endpoint");
  if (expiresAtMs <= now) return failure("has expired");
  return { baseUrl: endpoint, bearerToken, expiresAtMs };
}
