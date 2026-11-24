import { expect, test } from "bun:test";
import { intervalCalendar } from "../src/capabilities/reminders/interval.ts";
import { planRoutineEpisode, routineOccurrenceIdentity } from "../src/capabilities/reminders/routine-occurrence.ts";

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
