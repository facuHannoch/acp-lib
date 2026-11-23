import { ConnectionCancelledError } from "./errors.ts";
import type { AgentConversationRuntimeDefaults, OpenAgentConversationConfig, ProviderStart } from "./agent/config.ts";

export function resolveProviderStart(value: ProviderStart | undefined): ProviderStart {
  if (value === undefined) return "on_open";
  if (value === "on_open" || value === "on_first_use") return value;
  throw new TypeError("providerStart must be on_open or on_first_use");
}

export function defersProvider(
  config: Pick<OpenAgentConversationConfig, "runtime" | "mode">, defaults: AgentConversationRuntimeDefaults, native: boolean,
): boolean {
  return (config.runtime?.providerStart ?? defaults.providerStart) === "on_first_use" && !native
    && (config.mode ?? config.runtime?.mode ?? defaults.mode) !== "degraded";
}

/** The factory can be cancelled before it hands its session back to the caller. */
export async function withStartupCancellation<T>(
  signal: AbortSignal | undefined, stop: () => Promise<void>, start: () => Promise<T>,
): Promise<T> {
  if (!signal) return start();
  if (signal.aborted) throw new ConnectionCancelledError();
  const cancel = () => { void stop().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await start();
    if (signal.aborted) throw new ConnectionCancelledError();
    return result;
  } catch (error) {
    if (signal.aborted && !(error instanceof ConnectionCancelledError)) throw new ConnectionCancelledError();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
