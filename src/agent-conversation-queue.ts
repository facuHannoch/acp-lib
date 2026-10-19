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

  /** The next queued item, without removing it. */
  peek(): T | undefined {
    return this.#items[0];
  }

  /** Queued (not active) work in FIFO order. The returned array is a copy. */
  snapshot(): readonly T[] {
    return [...this.#items];
  }

  /** Remove and return the first queued item the predicate accepts, if any. */
  remove(predicate: (item: T) => boolean): T | undefined {
    const index = this.#items.findIndex(predicate);
    return index < 0 ? undefined : this.#items.splice(index, 1)[0];
  }

  /** Remove and return the consecutive items at the head of the queue the predicate accepts. */
  takeWhile(predicate: (item: T) => boolean): T[] {
    let count = 0;
    while (count < this.#items.length && predicate(this.#items[count]!)) count += 1;
    return this.#items.splice(0, count);
  }

  /**
   * Drain every item serially. Concurrent calls share the active drain; an item
   * enqueued by an active operation is observed by the same loop.
   */
  drain(execute: (item: T) => Promise<void>, select?: () => T | undefined): Promise<void> {
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
          const item = select ? select() : this.#items.shift();
          if (item === undefined) break;
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
