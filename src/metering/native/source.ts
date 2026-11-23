import type { InferenceSource } from "../engine.ts";
import type { NativeLedgerPosition, NativeUsageLedger } from "./ledger.ts";
import { projectNativeUsage, type NativeCallEvidence, type NativeUsageInference } from "./projection.ts";

export interface NativeTurnUsage {
  readonly calls: readonly NativeCallEvidence[];
  /** An observation for reconciliation. It is not an accounting acknowledgement. */
  readonly lastSeenCallId?: string;
  readonly unmeasured: number;
}

/** Stages one explicitly owned turn before the engine's synchronous drain. */
export class NativeInferenceSource implements InferenceSource {
  readonly certificationId = "native-harness-unverified";
  readonly sessionKey: string;
  #pulling = false;
  #current: NativeTurnUsage | undefined;
  #ready: readonly NativeUsageInference[] = [];

  constructor(
    agentId: string,
    private readonly channel: string,
    private readonly ledger: NativeUsageLedger,
  ) {
    this.sessionKey = `${agentId}/${channel}`;
  }

  async pullTurn(turnId: string, position?: NativeLedgerPosition): Promise<NativeTurnUsage> {
    if (this.#pulling) throw new Error("A native usage pull is already in progress for this channel");
    this.#pulling = true;
    this.#ready = [];
    this.#current = undefined;
    try {
      const { calls, lastSeenCallId } = await this.ledger.readTurn(this.channel, turnId, position);
      const { evidence, inferences, unmeasured } = projectNativeUsage(calls, this.sessionKey);
      this.#current = { calls: evidence, lastSeenCallId, unmeasured };
      this.#ready = inferences;
      return this.#current;
    } finally {
      this.#pulling = false;
    }
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
