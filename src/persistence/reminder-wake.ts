export interface ReminderDeadline {
  readonly sessionId: string;
  readonly revision: number;
  readonly nextDueAt: number | null;
}

export type ReminderDeadlineDecision = "accepted" | "unchanged" | "stale" | "mismatch";

/** Both executable opens and events use this fence. A reconnect retains the session ID. */
export function compareReminderDeadline(
  current: ReminderDeadline | null,
  incoming: ReminderDeadline,
  replaceSession = false,
): ReminderDeadlineDecision {
  if (current === null) return "accepted";
  if (current.sessionId !== incoming.sessionId) return replaceSession ? "accepted" : "stale";
  if (incoming.revision > current.revision) return "accepted";
  if (incoming.revision < current.revision) return "stale";
  return current.nextDueAt === incoming.nextDueAt ? "unchanged" : "mismatch";
}

export interface ReminderWakeCandidate {
  readonly op: "create" | "update" | "cancel";
  readonly state: "pending" | "maybe_sent" | "applied" | "blocked";
  readonly acceptedAt: number;
  readonly dueAt: number | null;
  readonly paused: boolean;
  readonly suspended: boolean;
  readonly retiring: boolean;
}

/** Deadlines request validation or replay without changing the stored schedule. */
export function deriveReminderWake(
  reported: ReminderDeadline | null,
  candidates: Iterable<ReminderWakeCandidate>,
  validationDelayMs: number,
): number | null {
  let earliest = reported?.nextDueAt ?? null;
  for (const candidate of candidates) {
    if (candidate.op === "cancel" || candidate.paused || candidate.suspended || candidate.retiring) continue;
    if (candidate.state !== "pending" && candidate.state !== "maybe_sent") continue;
    const validationAt = candidate.acceptedAt + validationDelayMs;
    if (!Number.isFinite(candidate.acceptedAt) || !Number.isFinite(validationAt) || (candidate.dueAt !== null && !Number.isFinite(candidate.dueAt))) continue;
    // R8 must rate-limit an unresolved wake in the past through its restart budget.
    const wake = Math.min(validationAt, candidate.dueAt ?? validationAt);
    earliest = earliest === null ? wake : Math.min(earliest, wake);
  }
  return earliest;
}
