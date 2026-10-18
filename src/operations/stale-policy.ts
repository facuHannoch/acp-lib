import type { OperationActivity, StaleLimits } from "./contracts.ts";
export type StallPhase = "no_response" | "incomplete_response";
export const DEFAULT_STALE_LIMITS = Object.freeze({ firstOutputMs: 120_000, nextOutputMs: 180_000 });
export interface StaleDecision { readonly deadline: number; readonly phase: StallPhase; readonly stale: boolean }
/** No timer is owed while an identified tool or permission explains the silence. */
export function stalePolicy(activity: OperationActivity, permissions: number, oldestToolAt: number | null,
  limits: StaleLimits, now: number): StaleDecision | null {
  if (activity.stage === "cancelling" || permissions > 0) return null;
  const phase = activity.lastOutputAt === null ? "no_response" : "incomplete_response";
  let duration: number | false;
  let since: number;
  if (activity.toolsInFlight) {
    duration = limits.toolMs ?? false;
    since = oldestToolAt ?? now;
  } else if (activity.lastOutputAt === null) {
    duration = limits.firstOutputMs ?? DEFAULT_STALE_LIMITS.firstOutputMs;
    since = activity.startedAt;
  } else {
    duration = limits.nextOutputMs ?? DEFAULT_STALE_LIMITS.nextOutputMs;
    since = activity.lastOutputAt;
  }
  if (duration === false) return null;
  const deadline = since + duration;
  return { deadline, phase, stale: now >= deadline };
}
export function validateStaleLimits(limits: StaleLimits): void {
  for (const [key, value] of Object.entries(limits)) {
    if (value !== undefined && value !== false && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      throw new Error(`${key} must be a positive finite number or false`);
    }
  }
}
