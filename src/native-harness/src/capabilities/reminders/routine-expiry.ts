import type { RoutineCalendar } from "../../contracts/routines.ts";
import { REMINDER_LIMITS } from "../../util/reminder-schedule.ts";

/** End constraints do not affect expiry. The index supplies the next match
 * on the underlying calendar, even when this occurrence is the last run. */
export function routineExpiry(calendar: RoutineCalendar, instant: number, grace?: number | null) {
  if (grace === null) return { expiresAfter: null, expiresAt: null };
  const { minExpiryGraceMs, maxExpiryGraceMs, expiryMultiplier } = REMINDER_LIMITS;
  if (grace !== undefined && (!Number.isSafeInteger(grace) || grace < minExpiryGraceMs || grace > maxExpiryGraceMs))
    throw new RangeError("Invalid routine expiry grace");
  const next = calendar.nextCalendarMatch(instant);
  if (grace === undefined && next === undefined) throw new RangeError("The calendar cannot determine the next match");
  const expiresAfter = grace ?? Math.max(minExpiryGraceMs, Math.min(maxExpiryGraceMs, (next! - instant) * expiryMultiplier));
  return { expiresAfter, expiresAt: instant + expiresAfter };
}
