export type RoutineBound<Instant> =
  | { readonly count: number; readonly until?: never }
  | { readonly until: Instant; readonly count?: never }
  | { readonly count?: never; readonly until?: never };

export type RoutineSchedule<Instant, Start = { readonly startAt?: Instant }> = RoutineBound<Instant> & (
  | ({ readonly every: number } & Start)
  | { readonly cron: string; readonly timezone: string }
);

export type MissedRuns = "coalesce" | "skip" | "each";
export type RoutineOverlap = "skip" | "queue";

export function isRoutineSchedule(schedule: unknown): schedule is RoutineSchedule<number> {
  return !!schedule && typeof schedule === "object" && ("every" in schedule || "cron" in schedule);
}

const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;

export function isRoutineCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  return fields.length === bounds.length && fields.every((field, i) => {
    const [min, max] = bounds[i]!;
    return field.split(",").every(part => {
      const item = /^(\*|([0-9]+)(?:-([0-9]+))?)(?:\/([0-9]+))?$/.exec(part);
      if (!item) return false;
      const [, base, start, end, step] = item;
      if (step !== undefined && ((base !== "*" && end === undefined) || !Number.isSafeInteger(+step) || +step <= 0)) return false;
      return base === "*" || (+start! >= min && +start! <= max && (end === undefined || (+end >= +start! && +end <= max)));
    });
  });
}

export function validInstant(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
}
