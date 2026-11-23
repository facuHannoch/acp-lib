import { ConnectionCancelledError } from "./errors.ts";

export class ConnectionAttempt {
  private readonly abort = new AbortController();
  private cleanup?: () => Promise<void>;

  get signal(): AbortSignal { return this.abort.signal; }

  own(cleanup: () => Promise<void>): void {
    this.signal.throwIfAborted();
    this.cleanup = cleanup;
  }

  async cancel(): Promise<void> {
    this.abort.abort(new ConnectionCancelledError());
    await this.cleanup?.();
  }
}

/** Equivalent attempts share readiness. An incompatible request cancels and drains the candidate first. */
export class ConnectionAttempts<T> {
  private active?: { key: string; attempt: ConnectionAttempt; result: Promise<T> };
  private teardown = Promise.resolve();

  run(key: string, work: (attempt: ConnectionAttempt) => Promise<T>): Promise<T> {
    if (this.active?.key === key) return this.active.result;
    void this.cancel().catch(() => undefined);
    const prior = this.teardown;
    const attempt = new ConnectionAttempt();
    const result = prior.then(() => {
      attempt.signal.throwIfAborted();
      return work(attempt);
    }).finally(() => {
      if (this.active?.attempt === attempt) this.active = undefined;
    });
    this.active = { key, attempt, result };
    return result;
  }

  cancel(): Promise<void> {
    const active = this.active;
    if (!active) return this.teardown;
    this.active = undefined;
    const teardown = Promise.all([this.teardown, active.attempt.cancel()]).then(() => undefined);
    this.teardown = teardown.catch(() => undefined);
    return teardown;
  }
}

/** Observe the original promise even if its result loses the race. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const release = () => signal.removeEventListener("abort", abort);
    void work.then(value => { release(); resolve(value); }, error => { release(); reject(error); });
  });
}
