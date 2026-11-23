import type { CounterInterpretation } from "./provider.ts";
import { acpProvenance, UNAVAILABLE_PROVENANCE, type MeteringProvenance, type MeteringUsageResult } from "./record.ts";

export function measurementProvenance(
  usage: MeteringUsageResult,
  interpretation: CounterInterpretation,
  certificationId: string | undefined,
  incomplete: boolean,
): MeteringProvenance {
  if (usage.status !== "metered") return UNAVAILABLE_PROVENANCE;
  if (certificationId === undefined) return acpProvenance(interpretation);
  return Object.freeze({
    source: "certified",
    measurement: "provider_normalized",
    // The integration observes the route but cannot establish that no traffic bypassed it.
    routing: "observed",
    attribution: incomplete ? "partial" : "complete",
    certificationId,
  });
}
