import type { RoutineCalendar, RoutineSchedule } from "../../contracts/routines.ts";
import { reminderInstant, REMINDER_LIMITS } from "../../util/reminder-schedule.ts";
import { proveRoutineCron } from "./cron-proof.ts";
import { resolveRoutineZone } from "./iana-zones.ts";
import { intervalCalendar } from "./interval.ts";

const invalid = { kind: "invalid_schedule" } as const;

function limitCalendar(calendar: RoutineCalendar, first: number, count: number | undefined, until: number | undefined): RoutineCalendar | undefined {
  const end = until === undefined ? Infinity : calendar.rank(until);
  const size = Math.min(end - first, count ?? Infinity);
  if (size <= 0 || calendar.at(first) === undefined) return;
  return {
    at: ordinal => Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < size ? calendar.at(first + ordinal) : undefined,
    rank: through => Math.max(0, Math.min(size, calendar.rank(through) - first)),
    nextCalendarMatch: instant => calendar.nextCalendarMatch(instant),
  };
}

export function prepareRoutineSchedule(schedule: RoutineSchedule, acceptedAt: string, now: number, processedThrough?: number) {
  const anchor = reminderInstant(acceptedAt);
  if (anchor === undefined || anchor > now + 30_000) return invalid;
  if (schedule.count !== undefined && (schedule.until !== undefined || !Number.isSafeInteger(schedule.count) || schedule.count < 1)) return invalid;
  const until = schedule.until === undefined ? undefined : reminderInstant(schedule.until);
  if (schedule.until !== undefined && until === undefined) return invalid;

  if ("every" in schedule) {
    const calendar = intervalCalendar(schedule, anchor, processedThrough);
    if (!calendar) return invalid;
    const start = schedule.startAt === undefined ? anchor + schedule.every : reminderInstant(schedule.startAt)!;
    return { kind: "valid", calendar, schedule: { ...schedule, startAt: new Date(start).toISOString() } } as const;
  }
  const zone = resolveRoutineZone(schedule.timezone);
  if (!zone) return invalid;
  const proof = proveRoutineCron(schedule.cron, zone);
  if (proof.kind !== "valid") return proof;
  const { calendar } = proof;
  const first = calendar.at(calendar.rank(anchor));
  if (first === undefined || first - anchor < REMINDER_LIMITS.minIntervalMs) return invalid;
  const bounded = limitCalendar(calendar, calendar.rank(Math.max(anchor, processedThrough ?? anchor)), schedule.count, until);
  return bounded
    ? { kind: "valid", calendar: bounded, schedule: { ...schedule, timezone: zone.timezone }, timezoneVersion: zone.timezoneVersion } as const
    : invalid;
}
