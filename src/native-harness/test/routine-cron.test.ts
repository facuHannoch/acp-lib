import { prepareRoutineSchedule } from "../src/capabilities/reminders/routine-schedule.ts";
import { resolveRoutineZone } from "../src/capabilities/reminders/iana-zones.ts";
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

test("bundled IANA names normalize aliases and prove a calendar across the recurring tail", () => {
  const zone = resolveRoutineZone("US/Eastern");
  expect(zone?.timezone).toBe("America/New_York");
  expect(zone?.timezoneVersion).toMatch(/^\d{4}[a-z]+$/);
  expect(resolveRoutineZone("localtime")).toBeUndefined();
  const proof = proveRoutineCron("30 1,2 * * *", zone!);
  expect(proof.kind).toBe("valid");
  if (proof.kind !== "valid") return;
  const fold = Date.UTC(2026, 10, 1, 5, 30);
  expect(proof.calendar.at(proof.calendar.rank(fold) - 1)).toBe(fold);
  expect(proof.calendar.nextCalendarMatch(fold)).toBe(Date.UTC(2026, 10, 1, 7, 30));
  const future = Date.UTC(2826, 10, 1, 5, 30);
  expect(proof.calendar.at(proof.calendar.rank(future) - 1)).toBe(future);
});

test("bundled calendar admission preserves the fence and inclusive until", () => {
  const anchor = "2026-03-08T00:00:00.000Z";
  const until = "2026-03-09T06:30:00.000Z";
  const first = Date.parse("2026-03-09T06:30:00.000Z");
  const schedule = { cron: "30 2 * * *", timezone: "US/Eastern", until };
  const result = prepareRoutineSchedule(schedule, anchor, Date.parse(anchor));
  expect(result.kind).toBe("valid");
  if (result.kind !== "valid") return;
  expect(result.schedule).toMatchObject({ timezone: "America/New_York" });
  expect(result.calendar.at(0)).toBe(first);
  expect(result.calendar.at(1)).toBeUndefined();
  expect(prepareRoutineSchedule(schedule, anchor, Date.parse(anchor), first).kind).toBe("invalid_schedule");
});
