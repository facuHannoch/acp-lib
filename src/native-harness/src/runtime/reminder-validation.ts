import type { ReminderSchedule, RoutineDeliveryOptions } from "../contracts/reminders.ts";
import { reminderInstant } from "../util/reminder-schedule.ts";
import type { ReminderChange, ReminderListParams } from "../contracts/reminders.ts";
import { SESSION_INPUT_MAX_BYTES } from "../contracts/input-limits.ts";

export class ReminderShapeError extends Error {}

const bad = (field: string): never => { throw new ReminderShapeError(`Invalid reminder ${field}`); };

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("object");
  return value as Record<string, unknown>;
};

function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) bad(key);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > SESSION_INPUT_MAX_BYTES) return bad(field);
  return value;
}

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return bad(field);
  return value as number;
}

function instant(value: unknown, field: string) {
  const raw = text(value, field), ms = reminderInstant(raw);
  return ms === undefined ? raw : new Date(ms).toISOString();
}

function schedule(value: unknown): ReminderSchedule {
  const input = record(value);
  if ("at" in input) {
    keys(input, ["at"]);
    return { at: instant(input.at, "schedule.at") };
  }
  if (input.count !== undefined && input.until !== undefined) return bad("schedule end");
  const end = input.count !== undefined ? { count: positive(input.count, "schedule.count") }
    : input.until !== undefined ? { until: instant(input.until, "schedule.until") } : {};
  if ("every" in input) {
    keys(input, ["every", "startAt", "count", "until"]);
    return { ...end, every: positive(input.every, "schedule.every"),
      ...(input.startAt === undefined ? {} : { startAt: instant(input.startAt, "schedule.startAt") }) };
  }
  keys(input, ["cron", "timezone", "count", "until"]);
  return { ...end, cron: text(input.cron, "schedule.cron"), timezone: text(input.timezone, "schedule.timezone") };
}

function delivery(payload: Record<string, unknown>): RoutineDeliveryOptions {
  const { missedRuns, overlap } = payload;
  if (missedRuns !== undefined && missedRuns !== "coalesce" && missedRuns !== "skip" && missedRuns !== "each") return bad("missedRuns");
  if (overlap !== undefined && overlap !== "skip" && overlap !== "queue") return bad("overlap");
  return { ...(missedRuns === undefined ? {} : { missedRuns }), ...(overlap === undefined ? {} : { overlap }) };
}

function grace(value: unknown) {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return bad("expiresAfter");
  return value;
}

function policyNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return bad("policyNames");
  return [...new Set(value.map(name => text(name, "policyNames")))].sort();
}

/** Validate both batch shape and individual live requests before any mutation. */
export function parseReminderChange(value: unknown): ReminderChange {
  const input = record(value);
  keys(input, ["reminderId", "changeId", "op", "payload"]);
  const id = { reminderId: text(input.reminderId, "reminderId"), changeId: positive(input.changeId, "changeId") };
  const payload = record(input.payload);
  switch (input.op) {
    case "create": {
      keys(payload, ["channel", "schedule", "text", "acceptedAt", "policyNames", "expiresAfter", "missedRuns", "overlap"]);
      const expiresAfter = grace(payload.expiresAfter);
      return { ...id, op: "create", payload: {
        ...delivery(payload), channel: text(payload.channel, "channel"), schedule: schedule(payload.schedule),
        text: text(payload.text, "text"), acceptedAt: instant(payload.acceptedAt, "acceptedAt"),
        policyNames: policyNames(payload.policyNames), ...(expiresAfter === undefined ? {} : { expiresAfter }),
      } };
    }
    case "update": {
      keys(payload, ["schedule", "acceptedAt", "text", "state", "expiresAfter", "missedRuns", "overlap"]);
      if (!Object.keys(payload).length || (payload.schedule === undefined) !== (payload.acceptedAt === undefined)) return bad("edit");
      const state = payload.state;
      if (state !== undefined && state !== "active" && state !== "paused") return bad("state");
      const expiresAfter = grace(payload.expiresAfter);
      const edit: Omit<Extract<ReminderChange, { op: "update" }>["payload"], "schedule" | "acceptedAt"> = {
        ...delivery(payload),
        ...(payload.text === undefined ? {} : { text: text(payload.text, "text") }),
        ...(state === undefined ? {} : { state }),
        ...(expiresAfter === undefined ? {} : { expiresAfter }),
      };
      return { ...id, op: "update", payload: payload.schedule === undefined ? edit
        : { ...edit, schedule: schedule(payload.schedule), acceptedAt: instant(payload.acceptedAt, "acceptedAt") } };
    }
    case "cancel":
      keys(payload, []);
      return { ...id, op: "cancel", payload: {} };
    default: return bad("operation");
  }
}

export function parseReminderBatch(value: unknown): ReminderChange[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return bad("batch");
  return value.map(parseReminderChange);
}

export function parseReminderList(value: unknown): ReminderListParams {
  const input = record(value);
  keys(input, ["channel", "after", "limit"]);
  const limit = input.limit === undefined ? 50 : positive(input.limit, "limit");
  if (limit > 100) return bad("limit");
  return {
    limit,
    ...(input.channel === undefined ? {} : { channel: text(input.channel, "channel") }),
    ...(input.after === undefined ? {} : { after: text(input.after, "after") }),
  };
}
