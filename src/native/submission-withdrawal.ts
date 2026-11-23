import type { ItemStatus } from "../native-harness/src/client.ts";
import { codeOf } from "./errors.ts";
import type { NativeHostRecords } from "./records.ts";

export type WithdrawalObservation = { outcome: "withdrawn" } | { outcome: "taken"; turnId: string | undefined };

/** An in-flight push can still commit after withdraw returns not_found. */
export class SubmissionWithdrawal {
  readonly #running = new Map<string, Promise<WithdrawalObservation>>();

  constructor(
    private readonly records: NativeHostRecords,
    private readonly timeoutMs: number,
    private readonly request: (channel: string, id: string) => Promise<WithdrawalObservation>,
    private readonly lookup: (channel: string, id: string) => Promise<ItemStatus | undefined>,
    private readonly confirmed: (channel: string, id: string) => void,
  ) {}

  async withdraw(channel: string, id: string, acceptance?: Promise<ItemStatus>): Promise<WithdrawalObservation | undefined> {
    const submission = this.records.submission(id);
    if (!submission || submission.channel !== channel) return;
    if (submission.state === "saved") {
      this.confirmed(channel, id);
      return { outcome: "withdrawn" };
    }
    if (!this.records.markWithdrawing) throw new Error("the native submission store cannot record a withdrawal intent");
    this.records.markWithdrawing(id);
    return this.retry(channel, id, acceptance);
  }

  retry(channel: string, id: string, acceptance?: Promise<ItemStatus>, reopened = false): Promise<WithdrawalObservation> {
    const pending = this.#running.get(id);
    if (pending) return reopened ? pending.catch(() => this.retry(channel, id, acceptance)) : pending;
    const request = this.#attempt(channel, id, acceptance).finally(() => this.#running.delete(id));
    this.#running.set(id, request);
    return request;
  }

  async #attempt(channel: string, id: string, acceptance?: Promise<ItemStatus>): Promise<WithdrawalObservation> {
    try {
      return await this.request(channel, id);
    } catch (error) {
      if (codeOf(error) !== "not_found") throw error;
      const item = await this.#findItem(channel, id, acceptance);
      if (!item) throw error;
      if (item.milestone === "withdrawn") {
        this.confirmed(channel, id);
        return { outcome: "withdrawn" };
      }
      return await this.request(channel, id);
    }
  }

  async #findItem(channel: string, id: string, acceptance?: Promise<ItemStatus>): Promise<ItemStatus | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const accepted = acceptance && await Promise.race([acceptance, new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), this.timeoutMs);
      })]);
      return accepted ?? await this.lookup(channel, id);
    } finally {
      clearTimeout(timer);
    }
  }
}
