import type { RoutineCalendar, RoutineDeliveryOptions } from "../../contracts/routines.ts";
import { REMINDER_LIMITS } from "../../util/reminder-schedule.ts";
import { routineExpiry } from "./routine-expiry.ts";

export const MAX_ROUTINE_CATCH_UP = 10;
export interface OrdinalRange { first: number; last: number }

function range(first: number, last: number): OrdinalRange[] {
  return first <= last ? [{ first, last }] : [];
}

function append(ranges: OrdinalRange[], ordinal: number) {
  const tail = ranges.at(-1);
  if (tail?.last === ordinal - 1) tail.last = ordinal;
  else ranges.push({ first: ordinal, last: ordinal });
}

/** Select expired and missed ranges before the fixed episode cutoff.
 * Ordinals preserve the exact represented occurrences without materializing
 * the backlog. Current-minute occurrences are handled by normal admission. */
export function routineBacklog(
  calendar: RoutineCalendar, next: number, cutoff: number, grace: number | null | undefined,
  policy: NonNullable<RoutineDeliveryOptions["missedRuns"]>,
) {
  const last = calendar.rank(Math.floor(cutoff / 60_000) * 60_000 - 1) - 1;
  const expired: OrdinalRange[] = [], live: OrdinalRange[] = [];
  if (grace === null) live.push(...range(next, last));
  else {
    const certainExpiry = Math.min(last, calendar.rank(cutoff - REMINDER_LIMITS.maxExpiryGraceMs) - 1);
    expired.push(...range(next, certainExpiry));
    for (let ordinal = Math.max(next, certainExpiry + 1); ordinal <= last; ordinal++) {
      const timing = routineExpiry(calendar, calendar.at(ordinal)!, grace);
      append(timing.expiresAt! <= cutoff ? expired : live, ordinal);
    }
  }

  if (policy === "skip") return { expired, discarded: live, queue: [], coalesced: [] };
  if (policy === "coalesce") return { expired, discarded: [], queue: [], coalesced: live };
  const queue: number[] = [], discarded: OrdinalRange[] = [];
  for (let index = live.length - 1; index >= 0; index--) {
    const { first, last } = live[index]!;
    const retained = Math.min(last - first + 1, MAX_ROUTINE_CATCH_UP - queue.length);
    for (let ordinal = last; ordinal > last - retained; ordinal--) queue.push(ordinal);
    discarded.push(...range(first, last - retained));
  }
  return { expired, discarded: discarded.reverse(), queue: queue.reverse(), coalesced: [] };
}
