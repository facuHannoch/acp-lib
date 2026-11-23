import type { InferenceSource } from "../engine.ts";
import type { NativeLedgerPosition, NativeUsageLedger } from "./ledger.ts";
import { projectNativeUsage, type NativeCallEvidence, type NativeUsageInference } from "./projection.ts";

export interface NativeTurnUsage {
  readonly calls: readonly NativeCallEvidence[];
  /** An observation for reconciliation. It is not an accounting acknowledgement. */
  readonly lastSeenCallId?: string;
  readonly unmeasured: number;
}

export const UNVERIFIED_NATIVE_SOURCE = "native-harness-unverified";

export interface NativeTurnRead extends NativeTurnUsage {
  readonly inferences: readonly NativeUsageInference[];
}

export interface NativeTurnMetering {
  readonly turnId: string;
  read(): Promise<NativeTurnRead>;
}

/** Stages one explicitly owned turn before the engine's synchronous drain. */
export class NativeInferenceSource implements InferenceSource {
  readonly certificationId = UNVERIFIED_NATIVE_SOURCE;
  readonly sessionKey: string;
  #queue = Promise.resolve();
  #current: NativeTurnUsage | undefined;
  #ready: readonly NativeUsageInference[] = [];

  constructor(
    agentId: string,
    private readonly channel: string,
    private readonly ledger: NativeUsageLedger,
  ) {
    this.sessionKey = `${agentId}/${channel}`;
  }

  pullTurn(turnId: string, position?: NativeLedgerPosition): Promise<NativeTurnUsage> {
    return this.#enqueue(() => this.#pull(turnId, position));
  }

  /** Keep pull and drain in the same queued operation, even if a second close is waiting. */
  readTurn(turnId: string, position?: NativeLedgerPosition): Promise<NativeTurnRead> {
    return this.#enqueue(async () => {
      const evidence = await this.#pull(turnId, position);
      return { ...evidence, inferences: this.drain(this.sessionKey) };
    });
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #pull(turnId: string, position?: NativeLedgerPosition): Promise<NativeTurnUsage> {
    this.#ready = [];
    this.#current = undefined;
    const { calls, lastSeenCallId } = await this.ledger.readTurn(this.channel, turnId, position);
    const { evidence, inferences, unmeasured } = projectNativeUsage(calls, this.sessionKey);
    this.#current = { calls: evidence, lastSeenCallId, unmeasured };
    this.#ready = inferences;
    return this.#current;
  }

  isHealthy(): boolean { return this.#current !== undefined; }

  drain(internalSessionId: string | null): readonly NativeUsageInference[] {
    if (internalSessionId !== this.sessionKey) return [];
    const ready = this.#ready;
    this.#ready = [];
    return ready;
  }

  outstandingReports(internalSessionId: string | null): number {
    return internalSessionId === this.sessionKey ? this.#current?.unmeasured ?? 0 : 0;
  }
}
