/** Decision 0032. Interval durations are integer milliseconds. */
export type RoutineEnd = { count: number; until?: never } | { until: string; count?: never }
  | { until?: never; count?: never };
export type IntervalRoutineSchedule = { every: number; startAt?: string } & RoutineEnd;
export type CalendarRoutineSchedule = { cron: string; timezone: string } & RoutineEnd;
export type RoutineSchedule = IntervalRoutineSchedule | CalendarRoutineSchedule;

export interface RoutineDeliveryOptions {
  missedRuns?: "coalesce" | "skip" | "each";
  overlap?: "skip" | "queue";
}

/** Rank and selection over concrete UTC instants, after applying the
 * schedule's anchor and end. An ordinal is zero-based. A rank is inclusive. */
export interface RoutineCalendar {
  at(ordinal: number): number | undefined;
  rank(through: number): number;
  /** Successor from the same schedule, ignoring count and until. */
  nextCalendarMatch(instant: number): number | undefined;
}
