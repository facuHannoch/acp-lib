/**
 * A small FIFO executor for operations which must never overlap within one
 * conversation. It owns scheduling only; operation meaning and lifecycle events stay
 * with the conversation runtime.
 */
export class AgentConversationQueue<T> {
  readonly #items: T[] = [];
  #draining = false;
  #activeDrain: Promise<void> | null = null;

  get queuedCount(): number {
    return this.#items.length;
  }

  get isDraining(): boolean {
    return this.#draining;
  }

  enqueue(item: T): void {
    this.#items.push(item);
  }

  /** Remove queued (not active) work and return it in FIFO order. */
  clear(): T[] {
    return this.#items.splice(0);
  }

  /**
   * Drain every item serially. Concurrent calls share the active drain; an item
   * enqueued by an active operation is observed by the same loop.
   */
  drain(execute: (item: T) => Promise<void>): Promise<void> {
    if (this.#activeDrain) return this.#activeDrain;
    this.#draining = true;
    let resolveDrain!: () => void;
    let rejectDrain!: (error: unknown) => void;
    const active = new Promise<void>((resolve, reject) => {
      resolveDrain = resolve;
      rejectDrain = reject;
    });
    // Install the waitable promise before invoking execute: callbacks may call
    // stop() synchronously while the first item is being started.
    this.#activeDrain = active;
    void (async () => {
      try {
        while (this.#items.length > 0) {
          const item = this.#items.shift()!;
          await execute(item);
        }
      } finally {
        this.#draining = false;
        this.#activeDrain = null;
      }
    })().then(resolveDrain, rejectDrain);
    return active;
  }

  /** Wait for the active executor, including its current item's finalization. */
  waitForIdle(): Promise<void> {
    return this.#activeDrain ?? Promise.resolve();
  }
}
