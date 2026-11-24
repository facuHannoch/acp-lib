import type { CronFields } from "./cron-fields.ts";

const dayMs = 86_400_000;
const minuteMs = 60_000;
const cycleDays = 146_097;
const cycleStart = Date.UTC(2000, 0, 1);

function upperBound(values: readonly number[], target: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (values[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index a Gregorian cycle once and use it for range arithmetic. Local civil
 * ordinals are signed around 2000-01-01 and do not apply zone transitions. */
export function cronCivilCalendar(fields: CronFields) {
  const days: number[] = [];
  const date = new Date(cycleStart);
  for (let offset = 0; offset < cycleDays; offset++) {
    date.setTime(cycleStart + offset * dayMs);
    if (fields.matchesDay({ day: date.getUTCDate(), month: date.getUTCMonth() + 1, weekday: date.getUTCDay() })) days.push(offset);
  }
  if (!days.length) return;
  const minutes = fields.minutesOfDay;
  const cycleSize = days.length * minutes.length;
  return {
    /** Number of civil matches through the instant, relative to the cycle origin. */
    rank(through: number): number {
      const elapsed = through - cycleStart;
      const day = Math.floor(elapsed / dayMs);
      const cycle = Math.floor(day / cycleDays);
      const offset = day - cycle * cycleDays;
      const before = upperBound(days, offset - 1);
      return cycle * cycleSize + before * minutes.length + (days[before] === offset
        ? upperBound(minutes, (elapsed - day * dayMs) / minuteMs)
        : 0);
    },
    at(ordinal: number): number {
      const cycle = Math.floor(ordinal / cycleSize);
      const offset = ordinal - cycle * cycleSize;
      const day = cycle * cycleDays + days[Math.floor(offset / minutes.length)]!;
      return cycleStart + day * dayMs + minutes[offset % minutes.length]! * minuteMs;
    },
  };
}
