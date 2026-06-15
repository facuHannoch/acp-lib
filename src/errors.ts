// Library error types. Kept minimal — surface protocol facts, don't over-classify.

/** The agent process exited unexpectedly (not via stop()). */
export class ProcessCrashError extends Error {
  constructor(
    public readonly code: number | null,
    message?: string,
  ) {
    super(message ?? `ACP process exited unexpectedly (${code ?? "killed"})`);
    this.name = "ProcessCrashError";
  }
}

/** A method was used before connect() established the connection. */
export class NotConnectedError extends Error {
  constructor(message = "AcpClient is not connected — call connect() first") {
    super(message);
    this.name = "NotConnectedError";
  }
}

/** An operation timed out. */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${Math.round(ms / 1000)}s`);
    this.name = "TimeoutError";
  }
}
