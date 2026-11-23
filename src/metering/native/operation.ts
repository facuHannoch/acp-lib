import type { TokenUsage } from "../../types.ts";
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
}

const observedProvenance: MeteringProvenance = Object.freeze({
  source: "native_ledger",
  measurement: "provider_normalized",
  routing: "unknown",
  attribution: "partial",
});

/** Called once from operation close. A read failure becomes evidence without discarding the turn. */
export async function measureNativeTurn(channel: string, metering?: NativeTurnMetering): Promise<NativeMeasurement> {
  const identity = { channel, turnId: metering?.turnId ?? null };
  const base = { applicability: null, ratingComplete: false, ratingFailureReason: nativeRouteUnavailable } as const;
  const unavailable = (reason: string, evidence: NativeOperationUsage): NativeMeasurement => ({
    ...base, usage: { status: "usage_unavailable", reason }, attributable: null,
    provenance: UNAVAILABLE_PROVENANCE, evidence,
  });
  if (!metering) {
    const reason = "the native turn was not prepared";
    return unavailable(reason, { ...identity, status: "unavailable", reason });
  }

  try {
    const { calls, unmeasured, inferences } = await metering.read();
    const evidence: NativeOperationUsage = { ...identity, status: "observed", calls, unmeasured };
    if (!inferences.length) {
      return unavailable(calls.length ? "native model-call usage is incomplete" : "native ledger has no calls for this turn", evidence);
    }

    // Sum every reported dimension independently, including the harness's reported total.
    const summed: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const { tokens } of inferences) {
      summed.inputTokens += tokens.inputTokens;
      summed.outputTokens += tokens.outputTokens;
      summed.totalTokens += tokens.totalTokens;
    }
    const attributable = unpricedUsage(summed);
    return {
      ...base, evidence, provenance: observedProvenance, attributable,
      usage: { status: "metered", reportedCumulative: summed, attributable },
    };
  } catch (error) {
    const reason = `native ledger unavailable: ${String(error)}`;
    return unavailable(reason, { ...identity, status: "unavailable", reason });
  }
}
