import type { RoutineCalendar, RoutineDeliveryOptions } from "../../contracts/routines.ts";
import { routineBacklog, type OrdinalRange } from "./routine-backlog.ts";
import { routineExpiry } from "./routine-expiry.ts";

type SkipReason = "expired" | "missed" | "catch_up_limit";
export type RoutineStep = OrdinalRange & (
  | { kind: SkipReason }
  | { kind: "enqueue"; represented: number }
  | { kind: "coalesced" }
);

/** Build one episode's chronological steps. A persisted cursor can consume
 * these in transaction-sized batches without reclassifying elapsed work. */
export function planRoutineEpisode(
  calendar: RoutineCalendar, next: number, cutoff: number, grace: number | null | undefined,
  missed: NonNullable<RoutineDeliveryOptions["missedRuns"]>,
): RoutineStep[] {
  const backlog = routineBacklog(calendar, next, cutoff, grace, missed);
  const steps: RoutineStep[] = backlog.expired.map(range => ({ ...range, kind: "expired" }));
  for (const range of backlog.discarded) steps.push({ ...range, kind: missed === "skip" ? "missed" : "catch_up_limit" });
  for (const ordinal of backlog.queue) steps.push({ first: ordinal, last: ordinal, kind: "enqueue", represented: 1 });
  const represented = backlog.coalesced.reduce((sum, range) => sum + range.last - range.first + 1, 0);
  for (const [index, range] of backlog.coalesced.entries()) {
    if (index + 1 === backlog.coalesced.length) steps.push({ ...range, kind: "enqueue", represented });
    else steps.push({ ...range, kind: "coalesced" });
  }
  const current = calendar.rank(cutoff) - 1;
  if (current >= next && current >= calendar.rank(Math.floor(cutoff / 60_000) * 60_000 - 1)) {
    const expiry = routineExpiry(calendar, calendar.at(current)!, grace).expiresAt;
    steps.push(expiry !== null && expiry <= cutoff ? { first: current, last: current, kind: "expired" }
      : { first: current, last: current, kind: "enqueue", represented: 1 });
  }
  return steps.sort((left, right) => left.first - right.first);
}

export function routineOccurrenceIdentity(reminderId: string, instant: number) {
  const scheduledAt = new Date(instant).toISOString();
  return { scheduledAt, occurrenceId: `reminder:${reminderId}:${scheduledAt}`,
    noticeId: `reminder-notice:${reminderId}:${scheduledAt}` };
}
