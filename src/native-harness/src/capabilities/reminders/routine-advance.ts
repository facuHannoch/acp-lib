import type { OneOffReminder, Reminder, ReminderChannelEvent } from "../../contracts/reminders.ts";
import type { RoutineCalendar } from "../../contracts/routines.ts";
import { routineExpiry } from "./routine-expiry.ts";
import { routineOccurrenceIdentity, type RoutineStep } from "./routine-occurrence.ts";

export type RoutineReminder = Exclude<Reminder, OneOffReminder>;

export interface RoutineAdvance {
  reminder: RoutineReminder;
  disposition?: Extract<ReminderChannelEvent, { type: "routine_disposition" }>;
  notice?: ReturnType<typeof routineOccurrenceIdentity> & { text: string };
}

/** Compute one committed cursor step. The owner must write the row and accept
 * the optional notice atomically, and publish only the returned dispositions. */
export function advanceRoutine(
  row: RoutineReminder, calendar: RoutineCalendar, step: RoutineStep, now: number,
  grace: number | null | undefined, overlapping: boolean,
): RoutineAdvance {
  const first = calendar.at(step.first), last = calendar.at(step.last);
  const count = step.last - step.first + 1;
  if (first === undefined || last === undefined || count < 1 || (row.remainingCount !== undefined && row.remainingCount < count))
    throw new RangeError("Invalid routine step");
  const remainingCount = row.remainingCount === undefined ? undefined : row.remainingCount - count;
  const next = remainingCount === 0 ? undefined : calendar.at(step.last + 1);
  const identity = routineOccurrenceIdentity(row.id, last);
  const candidate = step.kind === "enqueue";
  const expiry = candidate ? routineExpiry(calendar, last, grace).expiresAt : null;
  const reason = !candidate ? step.kind : expiry !== null && expiry <= now ? "expired"
    : row.overlap === "skip" && overlapping ? "overlap" : step.represented > 1 ? "coalesced" : undefined;
  const queued = candidate && (reason === undefined || reason === "coalesced");
  const nextExpiry = next === undefined ? { expiresAfter: null, expiresAt: null } : routineExpiry(calendar, next, grace);
  const reminder: RoutineReminder = { ...row, remainingCount,
    state: next === undefined ? "done" : "active", nextRunAt: next === undefined ? null : new Date(next).toISOString(),
    expiresAfter: nextExpiry.expiresAfter, expiresAt: nextExpiry.expiresAt === null ? null : new Date(nextExpiry.expiresAt).toISOString(),
    lastOccurrenceId: identity.occurrenceId,
    ...(queued ? { noticeId: identity.noticeId, lastRunAt: new Date(now).toISOString() } : {}),
  };
  return {
    reminder,
    ...(reason === undefined ? {} : { disposition: { type: "routine_disposition", reminderId: row.id,
      firstScheduledAt: new Date(first).toISOString(), lastScheduledAt: identity.scheduledAt, count, reason } }),
    ...(queued ? { notice: { ...identity, text: step.represented > 1
      ? `${row.text}\n\nMissed occurrences: ${step.represented}. Last scheduled: ${identity.scheduledAt}.`
      : row.text } } : {}),
  };
}
