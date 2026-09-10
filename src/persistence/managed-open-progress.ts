import type { Capabilities } from "../capabilities.ts";
import type { AgentSessionPromptability } from "../agent-session.ts";
import type { Logger } from "../logger.ts";

/** Ephemeral progress reported while a managed logical session is becoming usable. */
export type AgentSessionOpenStage =
  | { readonly stage: "initializing" }
  | { readonly stage: "initialized"; readonly capabilities: Capabilities }
  | {
      readonly stage: "internal_session_acquired";
      readonly internalSessionId: string;
      readonly disposition: "created" | "resumed";
    }
  | {
      readonly stage: "ready";
      readonly promptability: AgentSessionPromptability;
    };

/**
 * A presentation hook, not a persistence or transaction hook.
 *
 * Calls are made in lifecycle order. A retry starts a new sequence, and a failed open
 * does not report `ready`. Listener failures are logged and never fail the managed open.
 */
export type AgentSessionOpenProgressListener = (event: AgentSessionOpenStage) => void;

/** @internal A listener with failure isolation already applied by the managed coordinator. */
export type ManagedOpenProgressReporter = (event: AgentSessionOpenStage) => void;

/** @internal */
export function createManagedOpenProgressReporter(
  listener: AgentSessionOpenProgressListener | undefined,
  logger: Logger | undefined,
): ManagedOpenProgressReporter {
  if (!listener) return () => undefined;
  return (event) => {
    try {
      const returned: unknown = listener(event);
      if (isPromiseLike(returned)) {
        void Promise.resolve(returned).catch((error) => {
          logger?.warn("managed_open_progress_listener_failed", { error: String(error) });
        });
      }
    } catch (error) {
      logger?.warn("managed_open_progress_listener_failed", { error: String(error) });
    }
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object"
    && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}
