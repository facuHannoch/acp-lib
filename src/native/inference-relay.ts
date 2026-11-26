import { HarnessClientError, type InferenceRelayGrant } from "../native-harness/src/client.ts";
import { codeOf } from "./errors.ts";

export type { InferenceRelayGrant } from "../native-harness/src/client.ts";
export type InferenceRelayGrantProviderResult = InferenceRelayGrant & { grantRef?: string };
export type InferenceRelayGrantProvider = (context: { sessionId: string; signal: AbortSignal }) =>
  InferenceRelayGrantProviderResult | undefined | Promise<InferenceRelayGrantProviderResult | undefined>;
export type InferenceRelayOpenFailure = (context: { grantRef: string; delivery: "not_sent" | "unknown" }) => void | Promise<void>;

const unconfirmed = () => new HarnessClientError("relay_cleanup_unconfirmed", "Inference relay cleanup unconfirmed");
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(unconfirmed()), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export class RelayIssuanceFence {
  readonly #pending = new Set<Promise<unknown>>();
  readonly #cleanups = new Set<Promise<void>>();
  #blocked = false;
  readonly ms: number;

  constructor(ms = 10_000) {
    if (!Number.isInteger(ms) || ms < 1 || ms > 2_147_483_647)
      throw new HarnessClientError("invalid_config", "Invalid inference relay cleanup deadline");
    this.ms = ms;
  }

  track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
    return tracked;
  }

  async awaitIdle() {
    if (this.#blocked) throw unconfirmed();
    try { await bounded(Promise.allSettled([...this.#pending]), this.ms); }
    catch {
      // A cleanup that began near the end of the issuance wait still owns
      // its separate deadline. An acquisition that never returned is fenced.
      if (this.#cleanups.size) await Promise.allSettled([...this.#cleanups]);
      else this.#blocked = true;
    }
    if (this.#blocked) throw unconfirmed();
  }

  async cleanup(hook: InferenceRelayOpenFailure, grantRef: string, delivery: "not_sent" | "unknown") {
    const task = bounded(Promise.resolve().then(() => hook({ grantRef, delivery })), this.ms);
    this.#cleanups.add(task);
    try { await task; }
    catch { this.#blocked = true; throw unconfirmed(); }
    finally { this.#cleanups.delete(task); }
  }
}

export async function executableRelayOpen<T>(provider: InferenceRelayGrantProvider | undefined,
  sessionId: string, signal: AbortSignal, send: (grant: InferenceRelayGrant | undefined, markSent: () => void) => Promise<T>,
  cleanup?: InferenceRelayOpenFailure, fence = new RelayIssuanceFence()): Promise<T> {
  if (!provider) return send(undefined, () => {});
  await fence.awaitIdle();
  signal.throwIfAborted();
  return fence.track((async () => {
    let result: InferenceRelayGrantProviderResult | undefined;
    try { result = await provider({ sessionId, signal }); }
    catch {
      signal.throwIfAborted();
      throw new HarnessClientError("invalid_config", "Could not obtain native inference relay grant");
    }
    if (result === undefined) { signal.throwIfAborted(); return send(undefined, () => {}); }
    let delivery: "not_sent" | "unknown" = "not_sent";
    const reference = result?.grantRef;
    const validRef = typeof reference === "string" && !!reference.trim() && Buffer.byteLength(reference) <= 256 && !/[\p{Cc}\p{Cf}]/u.test(reference);
    try {
      signal.throwIfAborted();
      if (reference !== undefined && !validRef)
        throw new HarnessClientError("invalid_config", "Inference relay grant is invalid");
      const { baseUrl, bearerToken } = result;
      const numeric = Object.hasOwn(result, "expiresAtMs"), process = Object.hasOwn(result, "lifetime");
      if (numeric === process || (numeric && !Number.isSafeInteger(result.expiresAtMs)) ||
        (process && (!result.lifetime || Array.isArray(result.lifetime) || !Object.hasOwn(result.lifetime, "mode") || result.lifetime.mode !== "process" || Object.keys(result.lifetime).length !== 1)))
        throw new HarnessClientError("invalid_config", "Inference relay grant is invalid");
      const grant: InferenceRelayGrant = process ? { baseUrl, bearerToken, lifetime: { mode: "process" } }
        : { baseUrl, bearerToken, expiresAtMs: result.expiresAtMs! };
      const opened = await send(grant, () => { signal.throwIfAborted(); delivery = "unknown"; });
      signal.throwIfAborted();
      return opened;
    } catch (error) {
      if (cleanup && validRef) await fence.cleanup(cleanup, reference, delivery);
      signal.throwIfAborted();
      const code = codeOf(error);
      const allowed = ["not_found", "timeout", "transport_closed", "closed", "storage_failure", "invalid_config",
        "invalid_params", "incompatible", "busy", "already_exists"];
      const message = error instanceof Error ? error.message : "";
      const safe = /^(?:Error: )?Inference relay grant (?:is required|is invalid|has expired|does not match the configured endpoint|requires relay credential mode|requires executable access)$/.test(message);
      throw new HarnessClientError(code && allowed.includes(code) ? code : "invalid_config",
        safe ? message.replace(/^Error: /, "") : "Native inference relay open failed");
    }
  })());
}
