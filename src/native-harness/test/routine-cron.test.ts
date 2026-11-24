import { proveRoutineCron } from "../src/capabilities/reminders/cron-proof.ts";
import { routineExpiry } from "../src/capabilities/reminders/routine-expiry.ts";
import { zonedCalendar } from "../src/capabilities/reminders/cron-zone.ts";
import { cronCivilCalendar } from "../src/capabilities/reminders/cron-calendar.ts";
import { expect, test } from "bun:test";
import { parseRoutineCron } from "../src/capabilities/reminders/cron-fields.ts";

test("routine cron expands the approved five fields and intersects day constraints", () => {
  const cron = parseRoutineCron("0,30 8-10/2 1-10 1,2 1")!;
  expect(cron.minutesOfDay).toEqual([480, 510, 600, 630]);
  expect(cron.matchesDay({ day: 8, month: 2, weekday: 1 })).toBe(true);
  expect(cron.matchesDay({ day: 8, month: 2, weekday: 2 })).toBe(false);
  expect(cron.matchesDay({ day: 15, month: 2, weekday: 1 })).toBe(false);
});

test("routine cron rejects unsafe spacing across midnight and unsupported syntax", () => {
  for (const expression of ["0,55 0,23 * * *", "*/5 * * * *", "0 8 * * 7", "0 8 * JAN *",
    "0 8 * * MON", "@daily", "0 8 * * * *", "0 8 * * */0", "0/5 8 * * *"]) {
    expect(parseRoutineCron(expression)).toBeUndefined();
  }
  expect(parseRoutineCron("0,10,20,30,40,50 * * * *")?.minutesOfDay).toHaveLength(144);
});

test("civil calendar ranks and selects across a full Gregorian cycle", () => {
  const calendar = cronCivilCalendar(parseRoutineCron("0 8 29 2 *")!)!;
  const first = Date.UTC(2000, 1, 29, 8);
  const repeated = Date.UTC(2400, 1, 29, 8);
  expect(calendar.at(-1)).toBe(Date.UTC(1996, 1, 29, 8));
  expect(calendar.rank(first - 1)).toBe(0);
  expect(calendar.at(0)).toBe(first);
  expect(calendar.rank(repeated - 1)).toBe(97);
  expect(calendar.at(97)).toBe(repeated);
  expect(cronCivilCalendar(parseRoutineCron("0 8 31 2 *")!)).toBeUndefined();
});

test("UTC range index skips spring gaps and chooses the earlier fall fold", () => {
  const civil = cronCivilCalendar(parseRoutineCron("30 1,2 * * *")!)!;
  const hour = 3_600_000;
  const zone = zonedCalendar(civil, Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31), -5 * hour, [
    { at: Date.UTC(2026, 2, 8, 7), offset: -4 * hour },
    { at: Date.UTC(2026, 10, 1, 6), offset: -5 * hour },
  ])!;
  const spring = Date.UTC(2026, 2, 8, 6, 30);
  const autumn = Date.UTC(2026, 10, 1, 5, 30);
  expect(zone.at(zone.rank(spring) - 1)).toBe(spring);
  expect(zone.nextCalendarMatch(spring)).toBe(Date.UTC(2026, 2, 9, 5, 30));
  expect(zone.at(zone.rank(autumn) - 1)).toBe(autumn);
  expect(zone.nextCalendarMatch(autumn)).toBe(Date.UTC(2026, 10, 1, 7, 30));
});

test("transition proof rejects a pair closer than ten minutes in UTC", () => {
  const civil = cronCivilCalendar(parseRoutineCron("0,50 1,2 * * *")!)!;
  expect(zonedCalendar(civil, Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 3), 0, [
    { at: Date.UTC(2026, 0, 2, 1, 55), offset: 5 * 60_000 },
  ])).toBeUndefined();
});

test("routine default grace uses the next real match across DST", () => {
  const civil = cronCivilCalendar(parseRoutineCron("0 3 * * *")!)!;
  const hour = 3_600_000;
  const zone = zonedCalendar(civil, Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1), -5 * hour,
    [{ at: Date.UTC(2026, 2, 8, 7), offset: -4 * hour }])!;
  const daily = Date.UTC(2026, 2, 7, 8);
  expect(zone.nextCalendarMatch(daily)).toBe(daily + 23 * hour);
  expect(routineExpiry(zone, daily).expiresAfter).toBe(24 * hour);
  const sparseClock = cronCivilCalendar(parseRoutineCron("0 1,3 * * *")!)!;
  const short = zonedCalendar(sparseClock, Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1), -5 * hour,
    [{ at: Date.UTC(2026, 2, 8, 7), offset: -4 * hour }])!;
  const first = Date.UTC(2026, 2, 8, 6);
  expect(routineExpiry(short, first)).toEqual({ expiresAfter: 2 * hour, expiresAt: first + 2 * hour });
  expect(routineExpiry(short, first, null)).toEqual({ expiresAfter: null, expiresAt: null });
});

test("real calendar proof distinguishes invalid spacing from proof exhaustion", () => {
  const zone = { start: Date.UTC(2000, 0, 1), end: Date.UTC(2400, 0, 1), initialOffset: 0, transitions: [] };
  expect(proveRoutineCron("0 9 * * *", zone).kind).toBe("valid");
  expect(proveRoutineCron("*/5 * * * *", zone).kind).toBe("invalid_schedule");
  let reads = 0;
  expect(proveRoutineCron("0 9 * * *", zone, () => ++reads < 30 ? 0 : 250).kind).toBe("proof_budget");
  expect(reads).toBe(30);
});
