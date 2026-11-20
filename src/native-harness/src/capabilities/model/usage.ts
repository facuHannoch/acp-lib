import type { ModelAttemptSummary, ModelUsage } from "../../contracts/model-execution.ts";

/** Sum each attempt's latest absolute report once. Unknown fields stay absent;
 * total is provider-reported and is never inferred from input plus output. */
export function aggregateUsage(attempts: readonly ModelAttemptSummary[]): ModelUsage {
  const result: ModelUsage = {};
  for (const attempt of attempts) for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const value = attempt.usage?.[key];
    if (value === undefined) continue;
    const sum = (result[key] ?? 0) + value;
    if (!Number.isSafeInteger(sum)) throw new RangeError("Aggregated usage exceeds safe integer range");
    result[key] = sum;
  }
  return result;
}
