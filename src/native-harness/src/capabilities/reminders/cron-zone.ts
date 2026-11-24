import type { RoutineCalendar } from "../../contracts/routines.ts";
import type { cronCivilCalendar } from "./cron-calendar.ts";

export interface ZoneTransition { at: number; offset: number }
type CivilCalendar = NonNullable<ReturnType<typeof cronCivilCalendar>>;

/** Build one UTC range index from ordered concrete transitions. The bindings
 * layer must supply the versioned zone rules for the whole supported span. */
export function zonedCalendar(
  civil: CivilCalendar, start: number, end: number, initialOffset: number, transitions: readonly ZoneTransition[],
): RoutineCalendar | undefined {
  const segments: { offset: number; first: number; before: number; end: number; after: number }[] = [];
  let cursor = start, offset = initialOffset, total = 0, localFence = -Infinity;
  let previous: number | undefined;
  for (const transition of [...transitions, { at: end + 1, offset }]) {
    const stop = transition.at;
    if (stop <= cursor || stop > end + 1) return;
    const first = civil.rank(Math.max(cursor + offset - 1, localFence));
    const after = civil.rank(stop + offset - 1);
    if (after > first) {
      const firstUtc = civil.at(first) - offset;
      if (previous !== undefined && firstUtc - previous < 600_000) return;
      previous = civil.at(after - 1) - offset;
      segments.push({ offset, first, before: total, end: stop - 1, after: total + after - first });
      total += after - first;
    }
    localFence = Math.max(localFence, stop + offset - 1);
    cursor = stop;
    offset = transition.offset;
  }
  function find(predicate: (segment: typeof segments[number]) => boolean) {
    let lo = 0, hi = segments.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (predicate(segments[mid]!)) hi = mid;
      else lo = mid + 1;
    }
    return segments[lo];
  }
  function at(ordinal: number) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= total) return;
    const segment = find(segment => segment.after > ordinal)!;
    return civil.at(segment.first + ordinal - segment.before) - segment.offset;
  }
  function rank(through: number) {
    const segment = find(segment => segment.end >= through);
    if (!segment) return total;
    return segment.before + Math.max(0, civil.rank(through + segment.offset) - segment.first);
  }
  return { at, rank, nextCalendarMatch: through => at(rank(through)) };
}
