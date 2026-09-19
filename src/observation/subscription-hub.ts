import type { Listener, Subscribable, Unsubscribe } from "./contracts.ts";

export interface SubscriptionListenerError<TEvent> {
  readonly error: unknown;
  readonly event: TEvent;
}

/** Synchronous, exception-isolated event delivery with stable registration ordering. */
export class SubscriptionHub<TEvent> implements Subscribable<TEvent> {
  private readonly listeners = new Set<Listener<TEvent>>();

  constructor(
    private readonly onListenerError?: (failure: SubscriptionListenerError<TEvent>) => void,
  ) {}

  subscribe(listener: Listener<TEvent>): Unsubscribe {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  emit(event: TEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        try {
          this.onListenerError?.({ error, event });
        } catch {
          // Observation cannot become operation authority.
        }
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
