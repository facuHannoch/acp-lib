import type { Reminder, ReminderSchedule } from "../../contracts/reminders.ts";
import type { RoutineReminder } from "../../capabilities/reminders/routine-advance.ts";
import { prepareRoutineSchedule } from "../../capabilities/reminders/routine-schedule.ts";
import { routineExpiry } from "../../capabilities/reminders/routine-expiry.ts";

export function isRoutine(row: Reminder): row is RoutineReminder {
  return row.missedRuns !== undefined;
}

export function prepareRoutineRow(schedule: ReminderSchedule, acceptedAt: string, now: number,
  grace: number | null | undefined, fence?: number) {
  if (schedule.at !== undefined) return { kind: "invalid_schedule" } as const;
  const prepared = prepareRoutineSchedule(schedule, acceptedAt, now, fence);
  if (prepared.kind !== "valid") return prepared;
  const next = prepared.calendar.at(0)!;
  try {
    const expiry = routineExpiry(prepared.calendar, next, grace);
    return { kind: "valid", fields: { schedule: prepared.schedule, timezoneVersion: prepared.timezoneVersion,
      remainingCount: schedule.count, acceptedAt, nextRunAt: new Date(next).toISOString(),
      expiresAfter: expiry.expiresAfter, expiresAt: expiry.expiresAt === null ? null : new Date(expiry.expiresAt).toISOString() } } as const;
  } catch (error) {
    if (error instanceof RangeError) return { kind: "invalid_schedule" } as const;
    throw error;
  }
}
