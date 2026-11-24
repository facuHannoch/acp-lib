import type { HarnessClient } from "../../native-harness/src/client.ts";
import type { Reminder, ReminderChange } from "../../persistence/reminders.ts";
import { defaultReminderLimits, type ReminderLimits } from "./limits.ts";
import { ReminderError } from "./schedule.ts";

export interface WireReminder {
  id: string;
  channel: string;
  createdBy: "agent" | "host";
  creatorId?: string;
  policyNames: string[];
  schedule: { at: string };
  text: string;
  state: "active" | "paused" | "blocked" | "done" | "cancelled" | "expired";
  nextRunAt: string | null;
  acceptedAt: string;
  expiresAfter: number | null;
  expiresAt: string | null;
  lastRunAt?: string;
  lastOccurrenceId?: string;
  noticeId?: string;
  blockedReason?: string;
}

export type WireReminderEvent =
  | { kind: "reminder_changed"; reminder: WireReminder }
  | { kind: "reminder_fired"; reminderId: string; occurrenceId: string; scheduledAt: string; firedAt: string; noticeId: string }
  | { kind: "reminder_cancelled"; reminderId: string; by: "host" | "agent" | "channel_retired" }
  | { kind: "reminder_expired"; reminderId: string; occurrenceId: string; scheduledAt: string; expiredAt: string };

export type WireReceipt = {
  reminderId: string;
  changeId: number;
  outcome: "applied" | "blocked";
  reason?: string;
  reminder?: WireReminder;
  alreadyQueued?: boolean;
};

export interface ReminderPage { reminders: WireReminder[]; next?: string }
export interface ReminderOpenResult {
  reminderChanges?: WireReceipt[];
  reminders?: WireReminder[];
  remindersNext?: string;
  nextDueAt?: string | null;
  reminderRevision?: number;
}

export function reminderRpc<T>(client: HarnessClient, method: string, params: object, signal?: AbortSignal): Promise<T> {
  return client.request(method as never, params as never, signal) as Promise<T>;
}

export function negotiatedLimits(value: unknown): ReminderLimits {
  const source = (value ?? {}) as Record<string, unknown>;
  const read = (name: string, fallback: number) =>
    typeof source[name] === "number" && Number.isSafeInteger(source[name]) && source[name] >= 0 ? source[name] : fallback;
  return {
    oneShotLeadMs: read("minLeadMs", defaultReminderLimits.oneShotLeadMs),
    repeatIntervalMs: read("minIntervalMs", defaultReminderLimits.repeatIntervalMs),
    perChannel: read("maxActiveRoutinesPerChannel", 0),
    minGraceMs: read("minExpiryGraceMs", defaultReminderLimits.minGraceMs),
    maxGraceMs: read("maxExpiryGraceMs", defaultReminderLimits.maxGraceMs),
    expiryMultiplier: read("expiryMultiplier", defaultReminderLimits.expiryMultiplier),
  };
}

export function reminderRequest(change: ReminderChange, limits = defaultReminderLimits) {
  const { id, conversationId, text, schedule, expiryPolicy, status, policyNames, scheduleAcceptedAt } = change.reminder;
  const includes = (field: NonNullable<ReminderChange["fields"]>[number]) =>
    change.op === "create" || (change.op === "update" && change.fields?.includes(field) === true);
  if (!id || !Number.isSafeInteger(change.changeId) || change.changeId < 1) throw new Error("Invalid reminder identity");
  const identity = { reminderId: id, changeId: change.changeId, op: change.op };
  if (change.op === "cancel") return { ...identity, payload: {} };
  if (!("at" in schedule)) throw new ReminderError("routines_unavailable", "Routine reminders are unavailable");
  const anchor = scheduleAcceptedAt ?? change.acceptedAt;
  if (includes("schedule") && (!Number.isSafeInteger(anchor) || !Number.isSafeInteger(schedule.at)
    || schedule.at - anchor < limits.oneShotLeadMs)) throw new Error("Invalid reminder schedule anchor");
  if (includes("text") && (typeof text !== "string" || !text.trim())) throw new Error("Invalid reminder text");
  if (change.op === "create" && (!conversationId || (policyNames && (
    new Set(policyNames).size !== policyNames.length || policyNames.some(name => typeof name !== "string" || !name.trim())
  )))) throw new Error("Invalid reminder destination or policies");
  if (change.op === "update" && includes("status") && status !== "active" && status !== "paused") throw new Error("Invalid reminder state");
  const expiresAfter = expiryPolicy.kind === "duration" ? expiryPolicy.milliseconds : expiryPolicy.kind === "unlimited" ? null : undefined;
  if (includes("expiry") && typeof expiresAfter === "number" &&
    (!Number.isSafeInteger(expiresAfter) || expiresAfter < limits.minGraceMs || expiresAfter > limits.maxGraceMs)) {
    throw new Error("Invalid reminder grace");
  }
  const payload = {
    ...(change.op === "create" ? { channel: conversationId, ...(policyNames === undefined ? {} : { policyNames }) } : {}),
    ...(includes("text") ? { text } : {}),
    ...(includes("schedule") ? { schedule: { at: new Date(schedule.at).toISOString() }, acceptedAt: new Date(anchor).toISOString() } : {}),
    ...(change.op === "update" && includes("status") ? { state: status } : {}),
    ...(includes("expiry") && expiresAfter !== undefined ? { expiresAfter } : {}),
  };
  if (Object.keys(payload).length === 0) throw new Error("Empty reminder update");
  return { ...identity, payload };
}

export type WireChange = ReturnType<typeof reminderRequest>;

export function fromWireReminder(row: WireReminder, prior?: Reminder): Reminder {
  const { id, channel, text, state, policyNames, createdBy, creatorId, lastRunAt, lastOccurrenceId, noticeId, blockedReason } = row;
  return {
    id, conversationId: channel, text, policyNames, createdBy, creatorId, lastOccurrenceId, noticeId, blockedReason,
    status: state === "done" ? "completed" : state,
    schedule: { at: Date.parse(row.schedule.at) },
    scheduleAcceptedAt: Date.parse(row.acceptedAt),
    expiryPolicy: prior?.expiryPolicy ?? (row.expiresAfter === null ? { kind: "unlimited" } : { kind: "duration", milliseconds: row.expiresAfter }),
    expiry: row.expiresAt === null ? null : { kind: "absolute", at: Date.parse(row.expiresAt), graceMs: row.expiresAfter! },
    nextRunAt: row.nextRunAt == null ? null : Date.parse(row.nextRunAt),
    ...(lastRunAt === undefined ? {} : { lastRunAt: Date.parse(lastRunAt) }),
  };
}

export type ReminderNotification =
  | { deadline: { nextDueAt: string | null; revision: number } }
  | { channel: string; event: WireReminderEvent };

export function reminderNotification(value: unknown): ReminderNotification | undefined {
  const frame = value as { jsonrpc?: string; method?: string; params?: Record<string, unknown> } | null;
  if (frame?.jsonrpc !== "2.0" || !frame.params) return;
  const params = frame.params;
  if (frame.method === "session/event" && params.type === "reminders_due") {
    if (!Number.isSafeInteger(params.revision) || (params.nextDueAt !== null &&
      (typeof params.nextDueAt !== "string" || !Number.isFinite(Date.parse(params.nextDueAt))))) {
      throw new Error("Invalid reminders_due event");
    }
    return { deadline: { nextDueAt: params.nextDueAt as string | null, revision: params.revision as number } };
  }
  if (frame.method !== "channel/event" || typeof params.channel !== "string" || !params.event) return;
  const { type, ...fields } = params.event as { type: string };
  if (!["reminder_changed", "reminder_fired", "reminder_cancelled", "reminder_expired"].includes(type)) return;
  return { channel: params.channel, event: { ...fields, kind: type } as WireReminderEvent };
}
