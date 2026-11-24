import { advanceRoutine, type RoutineReminder } from "../src/capabilities/reminders/routine-advance.ts";
import { expect, test } from "bun:test";
import { intervalCalendar } from "../src/capabilities/reminders/interval.ts";
import { expireRoutineRange, planRoutineEpisode, routineOccurrenceIdentity } from "../src/capabilities/reminders/routine-occurrence.ts";

test("episode separates a current-minute occurrence from a large missed coalesce range", () => {
  const anchor = Date.parse("2026-11-24T00:00:00Z"), every = 600_000;
  const calendar = intervalCalendar({ every }, anchor)!;
  const steps = planRoutineEpisode(calendar, 0, anchor + every * 500_001, null, "coalesce");
  expect(steps).toEqual([
    { kind: "enqueue", first: 0, last: 499_999, represented: 500_000 },
    { kind: "enqueue", first: 500_000, last: 500_000, represented: 1 },
  ]);
  expect(routineOccurrenceIdentity("a", calendar.at(steps[1]!.last)!)).not.toEqual(
    routineOccurrenceIdentity("a", calendar.at(steps[0]!.last)!));
});

test("one compact expiry event consumes a range without declaring terminal state", () => {
  const anchor = Date.parse("2026-11-24T00:00:00Z"), every = 600_000;
  const calendar = intervalCalendar({ every, count: 3 }, anchor)!;
  const first = expireRoutineRange("check", calendar, { first: 0, last: 1 }, 3);
  expect(first).toEqual({
    event: { type: "routine_disposition", reminderId: "check", reason: "expired", count: 2,
      firstScheduledAt: "2026-11-24T00:10:00.000Z", lastScheduledAt: "2026-11-24T00:20:00.000Z" },
    remainingCount: 1, nextRunAt: "2026-11-24T00:30:00.000Z",
  });
  const final = expireRoutineRange("check", calendar, { first: 2, last: 2 }, first.remainingCount);
  expect(final).toMatchObject({ event: { type: "routine_disposition", reason: "expired", count: 1 },
    remainingCount: 0, nextRunAt: null });
  expect(final.event).not.toHaveProperty("state");
});

test("a final counted expiry advances the row and emits only a range disposition", () => {
  const anchor = Date.parse("2026-11-24T00:00:00Z"), every = 600_000;
  const calendar = intervalCalendar({ every, count: 2 }, anchor)!;
  const row: RoutineReminder = {
    id: "check", channel: "a", createdBy: "host", policyNames: [], text: "check",
    schedule: { every, startAt: new Date(anchor + every).toISOString(), count: 2 },
    acceptedAt: new Date(anchor).toISOString(), state: "active",
    missedRuns: "coalesce", overlap: "skip", remainingCount: 2,
    nextRunAt: new Date(anchor + every).toISOString(), expiresAt: null, expiresAfter: null,
  };
  const result = advanceRoutine(row, calendar, { first: 0, last: 1, kind: "expired" }, anchor + every * 10, undefined, false);
  expect(result.disposition).toMatchObject({ type: "routine_disposition", reason: "expired", count: 2 });
  expect(result.notice).toBeUndefined();
  expect(result.reminder).toMatchObject({ state: "done", remainingCount: 0, nextRunAt: null, expiresAt: null });
});
