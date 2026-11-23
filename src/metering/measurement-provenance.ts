import { isTotalComplete } from "./money.ts";
import type { AttributableUsage } from "./rating.ts";
import type { MeteringPricingStatus } from "./record.ts";
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


export function measurementPricingStatus(
  usage: MeteringUsageResult,
  disabled: boolean,
  complete: boolean | undefined,
  attributable: AttributableUsage | null,
): MeteringPricingStatus {
  if (usage.status !== "metered") return "not_attributable";
  if (disabled) return "not_configured";
  // Multi-model pricing has no top-level source, so use completeness of the rated total.
  return complete && attributable && isTotalComplete(attributable.ratedTotal) ? "priced" : "pricing_unavailable";
}
