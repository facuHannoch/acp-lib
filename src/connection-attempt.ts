import { ConnectionCancelledError } from "./errors.ts";

export class ConnectionAttempt<Progress = never> {
  private readonly abort = new AbortController();
  private readonly observers = new Set<(event: Progress) => void>();
  private readonly progress: Progress[] = [];
  private cleanup?: () => Promise<void>;
  private cancellation?: ConnectionCancelledError;

  get signal(): AbortSignal { return this.abort.signal; }

  throwIfCancelled(): void {
    if (this.cancellation) throw this.cancellation;
  }

  own(cleanup: () => Promise<void>): void {
    this.throwIfCancelled();
    this.cleanup = cleanup;
  }

  async cancel(): Promise<void> {
    this.cancellation ??= new ConnectionCancelledError();
    this.abort.abort(this.cancellation);
    await this.cleanup?.();
  }

  observe(observer: (event: Progress) => void): void {
    this.observers.add(observer);
    for (const event of this.progress) {
      if (this.signal.aborted) break;
      observer(event);
    }
  }

  report(event: Progress): void {
    this.progress.push(event);
    for (const observer of [...this.observers]) {
      if (this.signal.aborted) break;
      observer(event);
    }
  }
}

/** Equivalent attempts share readiness. An incompatible request cancels and drains the candidate first. */
export class ConnectionAttempts<T, Progress = never> {
  private active?: { key: string; attempt: ConnectionAttempt<Progress>; result: Promise<T> };
  private teardown = Promise.resolve();

  run(key: string, work: (attempt: ConnectionAttempt<Progress>) => Promise<T>, observer?: (event: Progress) => void): Promise<T> {
    const active = this.active;
    if (active?.key === key) {
      if (observer) active.attempt.observe(observer);
      return active.result;
    }
    void this.cancel().catch(() => undefined);
    const prior = this.teardown;
    const attempt = new ConnectionAttempt<Progress>();
    if (observer) attempt.observe(observer);
    const result = prior.then(() => {
      attempt.throwIfCancelled();
      return work(attempt);
    }).then(value => {
      attempt.throwIfCancelled();
      return value;
    }, error => {
      // A stopped attempt owns its public outcome, regardless of how the leaf unwinds.
      attempt.throwIfCancelled();
      throw error;
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
