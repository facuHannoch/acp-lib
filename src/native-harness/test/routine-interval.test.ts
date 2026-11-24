import { routineBacklog } from "../src/capabilities/reminders/routine-backlog.ts";
import { expect, test } from "bun:test";
import { intervalCalendar } from "../src/capabilities/reminders/interval.ts";

const anchor = Date.parse("2026-11-24T00:00:00Z"), every = 600_000;

test("interval calendar enforces spacing, initial lead and exclusive end forms", () => {
  expect(intervalCalendar({ every: every - 1 }, anchor)).toBeUndefined();
  expect(intervalCalendar({ every, startAt: new Date(anchor + every - 1).toISOString() }, anchor)).toBeUndefined();
  expect(intervalCalendar({ every, count: 0 }, anchor)).toBeUndefined();
  expect(intervalCalendar({ every, until: new Date(anchor).toISOString() }, anchor)).toBeUndefined();
});

test("interval rank seeks over long outages, with an inclusive end", () => {
  const last = anchor + 500_000 * every;
  const calendar = intervalCalendar({ every, until: new Date(last).toISOString() }, anchor)!;
  expect(calendar.rank(last - 1)).toBe(499_999);
  expect(calendar.rank(last)).toBe(500_000);
  expect(calendar.rank(last + every)).toBe(500_000);
  expect(calendar.at(499_999)).toBe(last);
  expect(calendar.at(500_000)).toBeUndefined();
  expect(calendar.nextCalendarMatch(last)).toBe(last + every);
});

test("an explicit first instant starts the calendar and count does not affect grace spacing", () => {
  const first = anchor + every + 100;
  const calendar = intervalCalendar({ every, startAt: new Date(first).toISOString(), count: 1 }, anchor)!;
  expect(calendar.rank(first - 1)).toBe(0);
  expect(calendar.at(0)).toBe(first);
  expect(calendar.at(1)).toBeUndefined();
  expect(calendar.nextCalendarMatch(first)).toBe(first + every);
});

test("catch-up selects at most ten live occurrences from an unlimited backlog", () => {
  const calendar = intervalCalendar({ every }, anchor)!;
  const now = anchor + 500_001 * every;
  expect(routineBacklog(calendar, 0, now, null, "each")).toEqual({
    expired: [], discarded: [{ first: 0, last: 499_989 }], coalesced: [],
    queue: Array.from({ length: 10 }, (_, index) => 499_990 + index),
  });
  expect(routineBacklog(calendar, 0, now, null, "coalesce").coalesced).toEqual([{ first: 0, last: 499_999 }]);
});

test("expiry equality is discarded before missed-run policy selects a notice", () => {
  const calendar = intervalCalendar({ every }, anchor)!;
  const now = anchor + 500_000 * every;
  expect(routineBacklog(calendar, 0, now, undefined, "coalesce")).toEqual({
    expired: [{ first: 0, last: 499_997 }], discarded: [], queue: [],
    coalesced: [{ first: 499_998, last: 499_998 }],
  });
});
