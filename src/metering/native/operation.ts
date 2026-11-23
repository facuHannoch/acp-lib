import type { CloseOperationInput, OpenOperation } from "../engine.ts";
import type { AgentSessionMeteringState, UnallocatedUsageAccrual } from "../state.ts";
import { sumNativeTokens, evaluateNativeRetirement } from "./retirement.ts";
import { UNAVAILABLE_PROVENANCE, type MeteringProvenance, type MeteringUsageResult, type NativeOperationUsage } from "../record.ts";
import { unpricedUsage, type AttributableUsage } from "../rating.ts";
import type { NativeTurnMetering } from "./source.ts";

export const nativeRouteUnavailable = "native model-call records do not identify the provider or model";

interface NativeMeasurement {
  readonly usage: MeteringUsageResult;
  readonly attributable: AttributableUsage | null;
  readonly provenance: MeteringProvenance;
  readonly evidence: NativeOperationUsage;
  readonly applicability: null;
  readonly ratingComplete: false;
  readonly ratingFailureReason: string;
  readonly accountedThrough?: string;
  readonly partial?: boolean;
  readonly unallocated?: readonly UnallocatedUsageAccrual[];
}

const observedProvenance: MeteringProvenance = Object.freeze({
  source: "native_ledger",
  measurement: "provider_normalized",
  routing: "unknown",
  attribution: "partial",
});

export function measureNativeOperation(open: OpenOperation, input: CloseOperationInput, state: AgentSessionMeteringState) {
  if (open.nativeChannel === undefined) return undefined;
  const cursor = state.nativeCursor;
  return measureNativeTurn(open.nativeChannel, input.nativeMetering,
    cursor?.channelKey === open.internalSessionId ? cursor?.after : undefined);
}

export function advanceNativeCursor(state: AgentSessionMeteringState, channelKey: string | null, through?: string) {
  return through && channelKey ? Object.freeze({ ...state, nativeCursor: { channelKey, after: through } }) : state;
}

/** Called once from operation close. A read failure becomes evidence without discarding the turn. */
export async function measureNativeTurn(channel: string, metering?: NativeTurnMetering, after?: string): Promise<NativeMeasurement> {
  const identity = { channel, turnId: metering?.turnId ?? null };
  const base = { applicability: null, ratingComplete: false, ratingFailureReason: nativeRouteUnavailable } as const;
  const unavailable = (reason: string, evidence: NativeOperationUsage, accountedThrough?: string,
    unallocated?: readonly UnallocatedUsageAccrual[]): NativeMeasurement => ({
    ...base, usage: { status: "usage_unavailable", reason }, attributable: null,
    provenance: UNAVAILABLE_PROVENANCE, evidence, accountedThrough, unallocated,
  });
  if (!metering) {
    const reason = "the native turn was not prepared";
    return unavailable(reason, { ...identity, status: "unavailable", reason });
  }

  try {
    const read = await metering.read({ after });
    const { calls, unmeasured, inferences } = read;
    const terminal = metering.isTerminal?.() === true;
    const { through, earlier, unallocated, pendingEarlier } = await evaluateNativeRetirement(metering, read, terminal);
    const evidence: NativeOperationUsage = { ...identity, status: "observed", calls, unmeasured,
      ...(inferences.length ? { accountedAttemptIds: inferences.map(inference => inference.attemptId) } : {}),
      ...(earlier.length ? { unaccountedEarlierCalls: earlier } : {}),
      ...(pendingEarlier ? { earlierEvidencePending: true } : {}),
    };
    if (!inferences.length) {
      return unavailable(calls.length ? "native model-call usage is incomplete" : "native ledger has no calls for this turn", evidence, through, unallocated);
    }

    const summed = sumNativeTokens(inferences);
    const attributable = unpricedUsage(summed);
    const reason = unmeasured > 0 ? "some native model-call attempts could not be measured"
      : !terminal ? "the native turn's terminal outcome was not confirmed"
      : pendingEarlier ? "earlier native model-call evidence is awaiting retirement"
      : earlier.length ? "earlier native model-call evidence is recorded separately from this turn's total"
      : undefined;
    return {
      ...base, evidence, provenance: observedProvenance, attributable, accountedThrough: through, partial: !!reason, unallocated,
      usage: { status: "metered", reportedCumulative: summed, attributable,
        ...(reason ? { reason } : {}) },
    };
  } catch (error) {
    const reason = `native ledger unavailable: ${String(error)}`;
    return unavailable(reason, { ...identity, status: "unavailable", reason });
  }
}
