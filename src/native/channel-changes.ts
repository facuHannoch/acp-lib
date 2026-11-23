import type { Logger } from "../logger.ts";
import type { ChannelDesire, ChannelPersistence, PendingChange } from "../persistence/channels.ts";
import type { ChannelChangeResult, ChannelStatusResult, HarnessClient, PendingChannelChange } from "../native-harness/src/client.ts";
import { ambiguous, codeOf, HarnessUnavailableError, pendingRetirementError } from "./errors.ts";
import type { NativeHostRecords } from "./records.ts";

export type ChannelChangeOutcome =
  | { readonly state: "applied" }
  /** Stored for another delivery attempt. A change never starts the harness. */
  | { readonly state: "pending" }
  | { readonly state: "blocked"; readonly reason: NonNullable<ChannelChangeResult["reason"]> };

export function channelStore(records: NativeHostRecords): ChannelPersistence {
  return {
    desire: async (channel, desire) => records.desire(channel, desire),
    pendingChange: async (channel) => records.pendingChange(channel),
    pendingChanges: async () => records.pendingChanges(),
    confirmChange: async (channel, version) => records.confirmChange(channel, version),
  };
}

export class NativeChannelChanges {
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #blockedVersions = new Map<string, number>();
  readonly #writes = new Set<Promise<unknown>>();
  #revision = 0;

  constructor(
    private readonly store: ChannelPersistence,
    private readonly channels: Map<string, ChannelStatusResult>,
    private readonly client: () => HarnessClient,
    private readonly log: Logger,
    private readonly onBlocked?: (result: ChannelChangeResult) => void,
  ) {}

  pendingChange(channel: string): Promise<PendingChange | undefined> { return this.store.pendingChange(channel); }

  pendingChanges(): Promise<PendingChange[]> { return this.store.pendingChanges(); }

  async resume(channel: string) {
    const client = this.client();
    return this.enqueue(channel, async () => {
      const pending = await this.store.pendingChange(channel);
      if (pending?.desire.lifecycle === "retired") throw pendingRetirementError(channel);
      return client.resumeChannel({ channel });
    });
  }

  /** Per channel, order live edits and pushes before any repository or network wait. */
  enqueue<T>(channel: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(channel) ?? Promise.resolve();
    const next = previous.then(work);
    const tail = next.catch(() => undefined);
    this.#queues.set(channel, tail);
    void tail.then(() => { if (this.#queues.get(channel) === tail) this.#queues.delete(channel); });
    return next;
  }

  async change(channel: string, desire: ChannelDesire, running: boolean): Promise<ChannelChangeOutcome> {
    // Start persisting immediately, even if an older RPC is outstanding. That RPC's confirmation
    // must see the new version. Register delivery synchronously so a subsequent push queues behind it.
    const lifecycle = desire.lifecycle;
    const write = this.store.desire(channel, desire);
    this.#trackWrite(write);
    const deliver = async (): Promise<ChannelChangeOutcome> => {
      const committed = await write;
      if ((lifecycle === "suspended" || lifecycle === "open") && committed.desire.lifecycle === "retired") {
        return { state: "blocked", reason: "channel_retired" };
      }
      return running ? this.#flushChange(channel) : { state: "pending" };
    };
    return running ? this.enqueue(channel, deliver) : deliver();
  }

  async deliverCommitted<T>(channel: string, commit: Promise<T>, running: () => boolean, deliver: (result: T) => boolean): Promise<T> {
    this.#trackWrite(commit);
    if (!running()) return commit;
    return this.enqueue(channel, async () => {
      const result = await commit;
      if (running() && deliver(result)) await this.#deliverPending(channel);
      return result;
    });
  }

  #trackWrite(write: Promise<unknown>): void {
    this.#revision++;
    this.#writes.add(write);
    const finished = () => { this.#writes.delete(write); };
    void write.then(finished, finished);
  }

  startupBatch(signal: AbortSignal): Promise<PendingChannelChange[]> {
    return this.#scan(signal, (changes) => changes.map(({ channel, version, desire }) => ({
      channel, changeId: String(version), ...desire,
    })));
  }

  async acknowledgeOpen(results: readonly ChannelChangeResult[], signal: AbortSignal): Promise<void> {
    this.#blockedVersions.clear();
    for (const result of results) {
      signal.throwIfAborted();
      const version = Number(result.changeId);
      if (result.outcome === "applied") await this.store.confirmChange(result.channel, version);
      else {
        this.#blockedVersions.set(result.channel, version);
        this.log.warn("native_channel_change_blocked", { ...result });
        try { this.onBlocked?.(result); } catch { /* observer */ }
      }
    }
  }

  /** Reserve delivery of post-cutoff edits before replaying submissions and publishing running. */
  afterOpen(signal: AbortSignal, ready: () => void): Promise<void> {
    return this.#scan(signal, (changes) => {
      for (const change of changes) {
        if (this.#blockedVersions.get(change.channel) === change.version) continue;
        void this.enqueue(change.channel, () => this.#deliverPending(change.channel));
      }
      ready();
    });
  }

  async #deliverPending(channel: string): Promise<void> {
    try {
      await this.#flushChange(channel);
    } catch (error) {
      // The local commit is already authoritative. A failed delivery leaves the intent for retry.
      this.log.warn("native_channel_change_delivery_failed", { channel, error: String(error) });
    }
  }

  async #scan<T>(signal: AbortSignal, use: (changes: PendingChange[]) => T): Promise<T> {
    for (;;) {
      signal.throwIfAborted();
      const revision = this.#revision;
      await Promise.allSettled(this.#writes);
      signal.throwIfAborted();
      const changes = await this.store.pendingChanges();
      signal.throwIfAborted();
      // A write can commit after the read's snapshot. Repeat the scan if an edit started during it,
      // including one that has already committed. The final scheduling happens in this same job.
      if (revision === this.#revision) return use(changes);
    }
  }

  async #flushChange(channel: string): Promise<ChannelChangeOutcome> {
    for (;;) {
      const pending = await this.store.pendingChange(channel);
      if (!pending) return { state: "applied" };
      const outcome = await this.#applyLive(pending);
      if (outcome.state !== "applied") {
        if (outcome.state === "blocked") this.#blockedVersions.set(channel, pending.version);
        return outcome;
      }
      // An old acknowledgment can't clear an edit that superseded it while the RPC was in flight.
      if (await this.store.confirmChange(channel, pending.version)) return outcome;
    }
  }

  async #applyLive(change: PendingChange): Promise<ChannelChangeOutcome> {
    const { channel, desire } = change;
    const seen = (result: { channel: ChannelStatusResult }) => { this.channels.set(channel, result.channel); };
    const known = this.channels.get(channel);
    const blocked = (reason: NonNullable<ChannelChangeResult["reason"]>): ChannelChangeOutcome => {
      const result: ChannelChangeResult = { channel, changeId: String(change.version), outcome: "blocked", reason };
      try { this.onBlocked?.(result); } catch { /* observer */ }
      return { state: "blocked", reason };
    };
    try {
      const client = this.client();
      if (known?.lifecycle === "retired") return desire.lifecycle === "retired" ? { state: "applied" } : blocked("channel_retired");
      if (desire.lifecycle === "retired") {
        if (!known) seen(await client.createChannel({ channel }));
        try {
          seen(await client.deleteChannel({ channel }));
        } catch (error) {
          if (codeOf(error) !== "channel_busy") throw error;
          // The same rule as at open: pending work must neither run nor be lost.
          seen(await client.suspendChannel({ channel }));
          return blocked("channel_busy");
        }
        return { state: "applied" };
      }
      if (!known) {
        seen(await client.createChannel({ channel,
          ...(typeof desire.displayName === "string" ? { displayName: desire.displayName } : {}),
          ...(typeof desire.policy === "string" ? { policy: desire.policy } : {}) }));
      } else if (desire.displayName !== undefined || desire.policy !== undefined) {
        // The edit replaces the name, so a change that omits it restates the current one.
        seen(await client.editChannel({ channel,
          displayName: desire.displayName === undefined ? known.displayName ?? null : desire.displayName,
          ...(desire.policy === undefined ? {} : { policy: desire.policy }) }));
      }
      if (desire.lifecycle === "suspended") seen(await client.suspendChannel({ channel }));
      if (desire.lifecycle === "open") {
        try { seen(await client.resumeChannel({ channel })); }
        catch (error) {
          if (codeOf(error) !== "incompatible") throw error;
          return blocked("incompatible");
        }
      }
      return { state: "applied" };
    } catch (error) {
      if (codeOf(error) === "channel_retired") return blocked("channel_retired");
      // Unknown outcome or no connection: the change stays pending and goes with the next open.
      if (ambiguous(error) || error instanceof HarnessUnavailableError) return { state: "pending" };
      throw error;
    }
  }
}
