/**
 * A small FIFO executor for operations which must never overlap within one
 * conversation. It owns scheduling only; operation meaning and lifecycle events stay
 * with the conversation runtime.
 */
export class AgentConversationQueue<T> {
  readonly #items: T[] = [];
  #draining = false;

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
   * Drain every item serially. Concurrent calls share the active drain by becoming
   * no-ops; an item enqueued by an active operation is observed by the same loop.
   */
  async drain(execute: (item: T) => Promise<void>): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#items.length > 0) {
        const item = this.#items.shift()!;
        await execute(item);
      }
    } finally {
      this.#draining = false;
    }
  }
}

