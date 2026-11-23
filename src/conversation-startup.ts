import { ConnectionCancelledError } from "./errors.ts";

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
