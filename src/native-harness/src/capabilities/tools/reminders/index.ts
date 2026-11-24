import type { ToolDefinition } from "../../../contracts/loop.ts";
import type { AgentReminderSchedule, RoutineSchedule, RoutineDeliveryOptions } from "../../../contracts/reminders.ts";
import { SESSION_INPUT_MAX_BYTES } from "../../../contracts/input-limits.ts";
import { REMINDER_LIMITS, reminderInstant } from "../../../util/reminder-schedule.ts";
import type { ReminderStorage } from "../../../contracts/storage.ts";
import type { ReminderChannelEvent } from "../../../contracts/reminders.ts";

const names = ["schedule_reminder", "list_reminders", "cancel_reminder"] as const;
export const isReminderTool = (name: string) => names.some(candidate => candidate === name);
const string = { type: "string" };
const grace = { type: ["integer", "null"] };
export const reminderDefinitions: ToolDefinition[] = [
  { name: "schedule_reminder", description: "Schedule a one-off reminder in the current channel. Use UTC at or a relative duration such as 5m.",
    parameters: { type: "object", properties: { schedule: { type: "object", properties: { at: string, in: string }, additionalProperties: false }, text: string, expiresAfter: grace },
      required: ["schedule", "text"], additionalProperties: false } },
  { name: "list_reminders", description: "List reminders in the current channel.", parameters: {
    type: "object", properties: { after: string, limit: { type: "integer" } }, additionalProperties: false } },
  { name: "cancel_reminder", description: "Cancel a reminder in the current channel.", parameters: {
    type: "object", properties: { id: string }, required: ["id"], additionalProperties: false } },
];

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const allowed = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim() && Buffer.byteLength(value) <= SESSION_INPUT_MAX_BYTES;

export const guardedReminderDefinitions: ToolDefinition[] = reminderDefinitions.map(tool => tool.name !== "schedule_reminder" ? tool : {
  ...tool, description: "Schedule a reminder or routine in the current channel. Cron uses five numeric fields and requires both day fields to match.",
  parameters: { type: "object", properties: { text: string, expiresAfter: grace, missedRuns: { enum: ["coalesce", "skip", "each"] },
    overlap: { enum: ["skip", "queue"] }, schedule: { type: "object", properties: { at: string, in: string,
      every: { type: "integer" }, startAt: string, cron: string, timezone: string, count: { type: "integer" }, until: string },
      additionalProperties: false } }, required: ["schedule", "text"], additionalProperties: false },
});

export type ReminderAction =
  | { kind: "schedule"; schedule: AgentReminderSchedule | RoutineSchedule; text: string; expiresAfter?: number | null; delivery?: RoutineDeliveryOptions }
  | { kind: "list"; after?: string; limit?: number }
  | { kind: "cancel"; id: string };

export function reminderAction(tool: string, input: unknown): ReminderAction | undefined {
  if (!object(input)) return;
  if (tool === "cancel_reminder") {
    if (allowed(input, ["id"]) && text(input.id)) return { kind: "cancel", id: input.id };
    return;
  }
  if (tool === "list_reminders") {
    if (!allowed(input, ["after", "limit"])) return;
    const { after, limit } = input;
    if (after !== undefined && !text(after)) return;
    if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)) return;
    return { kind: "list", ...(after === undefined ? {} : { after }), ...(limit === undefined ? {} : { limit }) };
  }
  if (!allowed(input, ["schedule", "text", "expiresAfter", "missedRuns", "overlap"]) || !text(input.text)) return;
  const { schedule, expiresAfter } = input;
  if (expiresAfter !== undefined && expiresAfter !== null && (typeof expiresAfter !== "number" || !Number.isSafeInteger(expiresAfter)
      || expiresAfter < REMINDER_LIMITS.minExpiryGraceMs || expiresAfter > REMINDER_LIMITS.maxExpiryGraceMs)) return;
  if (!object(schedule)) return;
  const payload = { kind: "schedule" as const, text: input.text, ...(expiresAfter === undefined ? {} : { expiresAfter }) };
  const { missedRuns, overlap } = input;
  if (missedRuns !== undefined && missedRuns !== "coalesce" && missedRuns !== "skip" && missedRuns !== "each") return;
  if (overlap !== undefined && overlap !== "skip" && overlap !== "queue") return;
  const { count, until } = schedule;
  if (count !== undefined && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || until !== undefined)) return;
  if (until !== undefined && !text(until)) return;
  const end = count !== undefined ? { count } : until !== undefined ? { until } : {};
  const delivery: RoutineDeliveryOptions = { missedRuns, overlap };
  if (typeof schedule.every === "number" && Number.isSafeInteger(schedule.every)
      && allowed(schedule, ["every", "startAt", "count", "until"]) && (schedule.startAt === undefined || text(schedule.startAt)))
    return { ...payload, delivery, schedule: { ...end, every: schedule.every, startAt: schedule.startAt } };
  if (text(schedule.cron) && text(schedule.timezone) && allowed(schedule, ["cron", "timezone", "count", "until"]))
    return { ...payload, delivery, schedule: { ...end, cron: schedule.cron, timezone: schedule.timezone } };
  if (Object.keys(schedule).length !== 1 || missedRuns !== undefined || overlap !== undefined) return;
  if (text(schedule.at) && reminderInstant(schedule.at) !== undefined) return { ...payload, schedule: { at: schedule.at } };
  if (text(schedule.in) && /^[1-9]\d*[mhd]$/.test(schedule.in)) return { ...payload, schedule: { in: schedule.in } };
}


export function executeReminderTool(
  storage: ReminderStorage, action: ReminderAction, channel: string, turnId: number, invocationId: string,
  policies: readonly string[], now: number, publish: (event: ReminderChannelEvent, revision: number) => void,
): string {
  if (action.kind === "list") {
    const result = storage.listReminders({ channel, after: action.after, limit: action.limit });
    return JSON.stringify(result.ok ? result.value : { error: result.error.code });
  }
  if (action.kind === "cancel") {
    const result = storage.cancelAgentReminder(turnId, action.id);
    if (!result.ok) return JSON.stringify({ error: result.error.code });
    const { changed, ...value } = result.value;
    if (changed) publish({ type: "reminder_cancelled", reminderId: value.id, by: "agent" }, result.revision);
    return JSON.stringify(value);
  }
  const result = storage.scheduleAgentReminder(turnId, invocationId, action.schedule, action.text, policies, action.expiresAfter, now, action.delivery);
  if (!result.ok) return JSON.stringify({ error: result.error.code });
  const { reminder, created } = result.value;
  if (created) publish({ type: "reminder_changed", reminder }, result.revision);
  return JSON.stringify({ id: reminder.id, nextRunAt: reminder.nextRunAt });
}
