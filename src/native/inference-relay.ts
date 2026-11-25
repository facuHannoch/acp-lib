import { HarnessClientError, type InferenceRelayGrant } from "../native-harness/src/client.ts";
import { codeOf } from "./errors.ts";

export type { InferenceRelayGrant } from "../native-harness/src/client.ts";

/** Trusted host hook. Return fresh runtime authority for this executable open. */
export type InferenceRelayGrantProvider = (context: { sessionId: string; signal: AbortSignal }) =>
  InferenceRelayGrant | undefined | Promise<InferenceRelayGrant | undefined>;

export async function executableRelayOpen<T>(provider: InferenceRelayGrantProvider | undefined,
  sessionId: string, signal: AbortSignal, send: (grant?: InferenceRelayGrant) => Promise<T>): Promise<T> {
  if (!provider) return send();
  signal.throwIfAborted();
  let grant: InferenceRelayGrant | undefined;
  try { grant = await provider({ sessionId, signal }); }
  catch {
    signal.throwIfAborted();
    throw new HarnessClientError("invalid_config", "Could not obtain native inference relay grant");
  }
  signal.throwIfAborted();
  if (grant === undefined) return send();
  // A custom harness can return arbitrary error strings. Keep the codes used
  // by recovery, and expose only the fixed relay diagnostics we emit ourselves.
  try {
    return await send(grant);
  } catch (error) {
    const code = codeOf(error);
    const allowed = ["not_found", "timeout", "transport_closed", "closed", "storage_failure", "invalid_config",
      "invalid_params", "incompatible", "busy", "already_exists"];
    const message = error instanceof Error ? error.message : "";
    const safe = /^(?:Error: )?Inference relay grant (?:is required|is invalid|has expired|does not match the configured endpoint|requires relay credential mode|requires executable access)$/.test(message);
    throw new HarnessClientError(code && allowed.includes(code) ? code : "invalid_config",
      safe ? message.replace(/^Error: /, "") : "Native inference relay open failed");
  }
}
