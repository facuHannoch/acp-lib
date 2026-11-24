import { defaultReminderLimits, type ReminderLimits } from "./limits.ts";

export type ReminderSchedule =
  | { readonly at: number }
  | { readonly every: number; readonly startAt: number }
  | { readonly cron: string; readonly timezone: string };

export type ReminderScheduleInput =
  | { readonly at: number }
  | { readonly in: number }
  | { readonly every: number; readonly startAt?: number }
  | { readonly cron: string; readonly timezone: string };

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

export type ReminderErrorCode =
  | "stale" | "invalid_state" | "routines_unavailable" | "reminders_unavailable" | "reminders_unsupported" | "invalid_schedule"
  | "invalid_input" | "invalid_policy" | "unauthorized" | "limit_exceeded"
  | "channel_missing" | "channel_retired" | "conflict" | "not_found";

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
  if ("cron" in input) {
    if (!input.cron.trim() || !input.timezone.trim()) {
      throw new ReminderError("invalid_schedule", "Cron requires an expression and timezone");
    }
    return { cron: input.cron, timezone: input.timezone };
  }
  if ("every" in input) {
    const startAt = input.startAt ?? acceptedAt + input.every;
    if (!Number.isSafeInteger(input.every) || input.every < limits.repeatIntervalMs || !Number.isSafeInteger(startAt)
      || startAt - acceptedAt < limits.oneShotLeadMs) {
      throw new ReminderError("invalid_schedule", "Invalid reminder interval or start time");
    }
    return { every: input.every, startAt };
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
  if (policy.kind === "unlimited") return null;
  if ("cron" in schedule) {
    return policy.kind === "duration" ? policy : { kind: "harness_default" };
  }
  const dueAt = "at" in schedule ? schedule.at : schedule.startAt;
  const lead = "every" in schedule ? schedule.every : dueAt - acceptedAt;
  const graceMs = policy.kind === "duration"
    ? policy.milliseconds
    : Math.max(limits.minGraceMs, Math.min(limits.maxGraceMs, limits.expiryMultiplier * lead));
  const at = dueAt + graceMs;
  if (!Number.isSafeInteger(at)) throw new ReminderError("invalid_input", "Invalid reminder expiry instant");
  return { kind: "absolute", at, graceMs };
}
