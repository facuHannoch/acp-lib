import { reminderInstant } from "../util/reminder-schedule.ts";
import type { OneOffReminderChange, ReminderListParams } from "../contracts/reminders.ts";
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

function schedule(value: unknown) {
  const input = record(value);
  keys(input, ["at"]);
  return { at: instant(input.at, "schedule.at") };
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
export function parseReminderChange(value: unknown): OneOffReminderChange {
  const input = record(value);
  keys(input, ["reminderId", "changeId", "op", "payload"]);
  const id = { reminderId: text(input.reminderId, "reminderId"), changeId: positive(input.changeId, "changeId") };
  const payload = record(input.payload);
  switch (input.op) {
    case "create": {
      keys(payload, ["channel", "schedule", "text", "acceptedAt", "policyNames", "expiresAfter"]);
      const expiresAfter = grace(payload.expiresAfter);
      return { ...id, op: "create", payload: {
        channel: text(payload.channel, "channel"), schedule: schedule(payload.schedule),
        text: text(payload.text, "text"), acceptedAt: instant(payload.acceptedAt, "acceptedAt"),
        policyNames: policyNames(payload.policyNames), ...(expiresAfter === undefined ? {} : { expiresAfter }),
      } };
    }
    case "update": {
      keys(payload, ["schedule", "acceptedAt", "text", "state", "expiresAfter"]);
      if (!Object.keys(payload).length || (payload.schedule === undefined) !== (payload.acceptedAt === undefined)) return bad("edit");
      const state = payload.state;
      if (state !== undefined && state !== "active" && state !== "paused") return bad("state");
      const expiresAfter = grace(payload.expiresAfter);
      const edit: { text?: string; state?: "active" | "paused"; expiresAfter?: number | null } = {
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

export function parseReminderBatch(value: unknown): OneOffReminderChange[] {
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
