import type { AgentReminderSchedule, ReminderLimits } from "../contracts/reminders.ts";

export const REMINDER_LIMITS: Readonly<ReminderLimits> = Object.freeze({
  minLeadMs: 120_000,
  minIntervalMs: 600_000,
  maxActiveRoutinesPerChannel: 0,
  minExpiryGraceMs: 300_000,
  maxExpiryGraceMs: 86_400_000,
  expiryMultiplier: 2,
});

export function reminderInstant(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return;
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction?: string) => `.${(fraction ?? "").padEnd(3, "0")}Z`);
  return new Date(instant).toISOString() === canonical ? instant : undefined;
}

export function resolveAgentReminder(schedule: AgentReminderSchedule, now: number): string | undefined {
  if ("at" in schedule) return reminderInstant(schedule.at) === undefined ? undefined : schedule.at;
  const duration = /^([1-9]\d*)([mhd])$/.exec(schedule.in);
  if (!duration) return;
  const multiplier = duration[2] === "m" ? 60_000 : duration[2] === "h" ? 3_600_000 : 86_400_000;
  const instant = now + Number(duration[1]) * multiplier;
  if (!Number.isSafeInteger(instant) || instant > 253_402_300_799_999) return;
  return new Date(instant).toISOString();
}

export function normalizeReminderSchedule(at: string, acceptedAt: string, expiresAfter: number | null | undefined, now: number) {
  const due = reminderInstant(at), anchor = reminderInstant(acceptedAt);
  if (due === undefined || anchor === undefined || anchor > now + 30_000 || due - anchor < REMINDER_LIMITS.minLeadMs) return;
  const grace = expiresAfter === undefined
    ? Math.min(REMINDER_LIMITS.maxExpiryGraceMs, Math.max(REMINDER_LIMITS.minExpiryGraceMs, (due - anchor) * REMINDER_LIMITS.expiryMultiplier))
    : expiresAfter;
  if (grace !== null && (!Number.isSafeInteger(grace) || grace < REMINDER_LIMITS.minExpiryGraceMs ||
      grace > REMINDER_LIMITS.maxExpiryGraceMs || due + grace > 253_402_300_799_999)) return;
  return {
    schedule: { at: new Date(due).toISOString() },
    acceptedAt: new Date(anchor).toISOString(),
    expiresAfter: grace,
    expiresAt: grace === null ? null : new Date(due + grace).toISOString(),
  };
}
