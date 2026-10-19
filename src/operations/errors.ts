import type { ResponseMessage } from "../types.ts";
import type { OperationMeteringRecord } from "../metering/record.ts";
import type { StallPhase } from "./stale-policy.ts";

/**
 * The provider stopped producing output and the request was cancelled. `phase` says whether
 * anything had arrived; `messages` holds what did.
 */
export class OperationStalledError extends Error {
  readonly code = "stalled";
  readonly data: { providerCode: string; phase: StallPhase };
  messages: readonly ResponseMessage[] = Object.freeze([]);
  /** Steers delivered right after this turn, as the recovery prompt. */
  followedBy?: readonly string[];
  metering?: OperationMeteringRecord;
  cancel?: "acknowledged" | "forced";

  constructor(readonly operationId: string, readonly phase: StallPhase) {
    super(`Provider operation stalled (${phase}).`);
    this.name = "OperationStalledError";
    this.data = { providerCode: "stalled", phase };
  }
}

/** The in-flight request ended because its provider process was killed. */
export class ForcedStopError extends Error {
  constructor() {
    super("Provider process was forcibly stopped.");
    this.name = "ForcedStopError";
  }
}
