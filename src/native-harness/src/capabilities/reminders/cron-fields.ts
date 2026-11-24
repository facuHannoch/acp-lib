const dayMinutes = 24 * 60;

interface CalendarDay {
  day: number;
  month: number;
  weekday: number;
}

export interface CronFields {
  minutesOfDay: readonly number[];
  matchesDay(day: CalendarDay): boolean;
}

function expand(field: string, min: number, max: number): number[] | undefined {
  const values = new Set<number>();
  for (const expression of field.split(",")) {
    const match = /^(\*|([0-9]{1,2})(?:-([0-9]{1,2}))?)(?:\/([0-9]{1,2}))?$/.exec(expression);
    if (!match) return;
    const wildcard = match[1] === "*";
    const start = wildcard ? min : Number(match[2]);
    const end = wildcard ? max : Number(match[3] ?? match[2]);
    const step = Number(match[4] ?? 1);
    if (start < min || end > max || end < start || step < 1 || (match[4] && !wildcard && !match[3])) return;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values].sort((left, right) => left - right);
}

export function parseRoutineCron(expression: string): CronFields | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return;
  const minutes = expand(fields[0]!, 0, 59), hours = expand(fields[1]!, 0, 23);
  const days = expand(fields[2]!, 1, 31), months = expand(fields[3]!, 1, 12);
  const weekdays = expand(fields[4]!, 0, 6);
  if (!minutes || !hours || !days || !months || !weekdays) return;
  const minutesOfDay = hours.flatMap(hour => minutes.map(minute => hour * 60 + minute));
  const wrapsAt = minutesOfDay[0]! + dayMinutes;
  const spaced = minutesOfDay.every((minute, index) => (minutesOfDay[index + 1] ?? wrapsAt) - minute >= 10);
  if (!spaced) return;
  return {
    minutesOfDay,
    matchesDay: ({ day, month, weekday }) => days.includes(day) && months.includes(month) && weekdays.includes(weekday),
  };
}
