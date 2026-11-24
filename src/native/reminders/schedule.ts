import { isRoutineCron, isRoutineSchedule, validInstant, type RoutineBound, type RoutineSchedule } from "./routine-schedule.ts";
import type { KnownReminderBlockReason } from "./wire.ts";
import { defaultReminderLimits, type ReminderLimits } from "./limits.ts";

export type ReminderSchedule =
  | { readonly at: number }
  | RoutineSchedule<number, { readonly startAt: number }>;

export type ReminderScheduleInput =
  | { readonly at: number }
  | { readonly in: number }
  | RoutineSchedule<number>;

export type ReminderExpiryPolicy =
  | { readonly kind: "unknown" }
  | { readonly kind: "default" }
  | { readonly kind: "duration"; readonly milliseconds: number }
  | { readonly kind: "unlimited" };

export type ReminderExpiry =
  | { readonly kind: "absolute"; readonly at: number; readonly graceMs: number }
  | { readonly kind: "harness_default" }
  | { readonly kind: "duration"; readonly milliseconds: number }
  | null;

export type ReminderErrorCode = KnownReminderBlockReason
  | "routines_unavailable" | "reminders_unavailable" | "reminders_unsupported"
  | "invalid_input" | "unauthorized";

export class ReminderError extends Error {
  constructor(readonly code: ReminderErrorCode, message: string) {
    super(message);
    this.name = "ReminderError";
  }
}

export function normalizeReminderSchedule(
  input: ReminderScheduleInput,
  acceptedAt: number,
  limits: ReminderLimits = defaultReminderLimits,
): ReminderSchedule {
  if (isRoutineSchedule(input)) {
    const { count, until } = input;
    if (count !== undefined && (until !== undefined || !Number.isSafeInteger(count) || count <= 0)) {
      throw new ReminderError("invalid_schedule", "Expected a positive safe count or an inclusive until, not both");
    }
    if (until !== undefined && (!validInstant(until) || until - acceptedAt < limits.repeatIntervalMs)) {
      throw new ReminderError("invalid_schedule", "Until must include at least one eligible occurrence");
    }
    const bound: RoutineBound<number> = count !== undefined ? { count } : until !== undefined ? { until } : {};
    if ("cron" in input) {
      if (typeof input.cron !== "string" || !isRoutineCron(input.cron) || typeof input.timezone !== "string" || !input.timezone.trim()) {
        throw new ReminderError("invalid_schedule", "Expected a five-field numeric cron expression and timezone");
      }
      return { cron: input.cron, timezone: input.timezone, ...bound };
    }
    const startAt = input.startAt ?? acceptedAt + input.every;
    if (!Number.isSafeInteger(input.every) || input.every < limits.repeatIntervalMs || !validInstant(startAt)
      || startAt - acceptedAt < limits.repeatIntervalMs || (until !== undefined && until < startAt)) {
      throw new ReminderError("invalid_schedule", "Invalid routine interval, start time or bound");
    }
    return { every: input.every, startAt, ...bound };
  }
  const at = "in" in input ? acceptedAt + input.in : input.at;
  if (!Number.isSafeInteger(at) || at - acceptedAt < limits.oneShotLeadMs) {
    throw new ReminderError("invalid_schedule", "Reminder does not meet the minimum lead time");
  }
  return { at };
}

export function reminderExpiryPolicy(expiresAfter: number | null | undefined, limits = defaultReminderLimits): ReminderExpiryPolicy {
  if (expiresAfter === undefined) return { kind: "default" };
  if (expiresAfter === null) return { kind: "unlimited" };
  if (!Number.isSafeInteger(expiresAfter) || expiresAfter < limits.minGraceMs || expiresAfter > limits.maxGraceMs) {
    throw new ReminderError("invalid_input", "Invalid reminder expiry duration");
  }
  return { kind: "duration", milliseconds: expiresAfter };
}

export function resolveReminderExpiry(
  schedule: ReminderSchedule,
  policy: ReminderExpiryPolicy,
  acceptedAt: number,
  limits: ReminderLimits = defaultReminderLimits,
): ReminderExpiry {
  if (isRoutineSchedule(schedule) || policy.kind === "unknown") return { kind: "harness_default" };
  if (policy.kind === "unlimited") return null;
  const dueAt = schedule.at;
  const lead = dueAt - acceptedAt;
  const graceMs = policy.kind === "duration"
    ? policy.milliseconds
    : Math.max(limits.minGraceMs, Math.min(limits.maxGraceMs, limits.expiryMultiplier * lead));
  const at = dueAt + graceMs;
  if (!Number.isSafeInteger(at)) throw new ReminderError("invalid_input", "Invalid reminder expiry instant");
  return { kind: "absolute", at, graceMs };
}
