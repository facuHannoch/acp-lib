import type { IntervalRoutineSchedule, RoutineCalendar } from "../../contracts/routines.ts";
import { reminderInstant, REMINDER_LIMITS } from "../../util/reminder-schedule.ts";

const lastInstant = Date.parse("9999-12-31T23:59:59.999Z");

export function intervalCalendar(schedule: IntervalRoutineSchedule, anchor: number): RoutineCalendar | undefined {
  const { every, count, until, startAt } = schedule;
  if (!Number.isSafeInteger(anchor) || !Number.isSafeInteger(every) || every < REMINDER_LIMITS.minIntervalMs) return;
  if (count !== undefined && (until !== undefined || !Number.isSafeInteger(count) || count < 1)) return;
  const first = startAt === undefined ? anchor + every : reminderInstant(startAt);
  const last = until === undefined ? lastInstant : reminderInstant(until);
  if (first === undefined || last === undefined || first > last || first - anchor < REMINDER_LIMITS.minIntervalMs) return;
  const size = Math.min(count ?? Infinity, Math.floor((last - first) / every) + 1);
  return {
    at(ordinal) {
      return Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < size ? first + ordinal * every : undefined;
    },
    rank(through) {
      return Math.max(0, Math.min(size, Math.floor((through - first) / every) + 1));
    },
    nextCalendarMatch(instant) {
      const next = first + (Math.floor((instant - first) / every) + 1) * every;
      return next <= lastInstant ? next : undefined;
    },
  };
}
