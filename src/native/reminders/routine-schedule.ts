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

export function hasRoutineCronShape(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  return fields.length === 5 && fields.every(field => /^[\d*,\/-]+$/.test(field));
}

export function validInstant(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
}
