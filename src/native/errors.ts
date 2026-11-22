import { HarnessClientError } from "../native-harness/src/client.ts";

export type HarnessUnavailableCode = "not_running" | "failed" | "stopped" | "open_timeout" | "start_failed" | "reopen_failed";

/** The harness cannot currently be used. The code identifies which lifecycle condition prevented it. */
export class HarnessUnavailableError extends Error {
  readonly code: HarnessUnavailableCode;

  constructor(message: string, options?: { cause?: unknown; code?: HarnessUnavailableCode }) {
    super(message, options);
    this.name = "HarnessUnavailableError";
    this.code = options?.code ?? "failed";
  }
}

/** The running harness lacks a capability required by this integration. */
export class HarnessIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessIncompatibleError";
  }
}

export function pendingRetirementError(channel: string): HarnessClientError {
  return new HarnessClientError("channel_retired", `Channel ${channel} is pending retirement`);
}

export const codeOf = (error: unknown): string | undefined => error instanceof HarnessClientError ? error.code : undefined;
/** The request's outcome is unknown: it may or may not have been applied. */
export const ambiguous = (error: unknown) => { const code = codeOf(error); return code === "timeout" || code === "transport_closed" || code === "closed"; };
