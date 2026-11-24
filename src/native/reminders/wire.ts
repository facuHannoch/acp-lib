import type {
  ChannelEvent, HarnessClient, Reminder as HarnessReminder, ReminderChange as WireChange,
  ReminderChangeResult, ReminderSessionEvent,
} from "../../native-harness/src/client.ts";
import type { Reminder, ReminderChange } from "../../persistence/reminders.ts";
import { defaultReminderLimits, type ReminderLimits } from "./limits.ts";
import { ReminderError } from "./schedule.ts";

type HarnessReminderEvent = Extract<ChannelEvent["event"], { type: `reminder_${string}` }>;
type WithKind<Event extends { type: string }> = Event extends unknown
  ? Omit<Event, "type"> & { kind: Event["type"] }
  : never;

export type WireReminderEvent = WithKind<HarnessReminderEvent>;
// Keep future block reasons representable in the library's public event.
export type ConsumerReminderEvent = Exclude<WireReminderEvent, { kind: "reminder_changed" }> | (
  Omit<Extract<WireReminderEvent, { kind: "reminder_changed" }>, "reminder"> & {
    reminder: Omit<HarnessReminder, "blockedReason"> & { blockedReason?: string };
  }
);
export type KnownReminderBlockReason = Extract<ReminderChangeResult, { outcome: "blocked" }>["reason"];
export type HarnessOpenResult = Awaited<ReturnType<HarnessClient["openSession"]>>;
export type HarnessDescription = Awaited<ReturnType<HarnessClient["initialize"]>>["description"];

export function negotiatedLimits(value: Partial<NonNullable<HarnessDescription["reminderLimits"]>> | undefined): ReminderLimits {
  const read = (name: keyof NonNullable<HarnessDescription["reminderLimits"]>, fallback: number) => {
    const limit = value?.[name];
    return typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0 ? limit : fallback;
  };
  return {
    oneShotLeadMs: read("minLeadMs", defaultReminderLimits.oneShotLeadMs),
    repeatIntervalMs: read("minIntervalMs", defaultReminderLimits.repeatIntervalMs),
    perChannel: read("maxActiveRoutinesPerChannel", 0),
    minGraceMs: read("minExpiryGraceMs", defaultReminderLimits.minGraceMs),
    maxGraceMs: read("maxExpiryGraceMs", defaultReminderLimits.maxGraceMs),
    expiryMultiplier: read("expiryMultiplier", defaultReminderLimits.expiryMultiplier),
  };
}

export function reminderRequest(change: ReminderChange, limits = defaultReminderLimits): WireChange {
  const { id, conversationId, text, schedule, expiryPolicy, status, policyNames, scheduleAcceptedAt } = change.reminder;
  const includes = (field: NonNullable<ReminderChange["fields"]>[number]) =>
    change.op === "create" || (change.op === "update" && change.fields?.includes(field) === true);
  if (typeof id !== "string" || !id.trim() || !Number.isSafeInteger(change.changeId) || change.changeId < 1) throw new Error("Invalid reminder identity");
  const identity = { reminderId: id, changeId: change.changeId };
  if (change.op === "cancel") return { ...identity, op: "cancel", payload: {} } satisfies WireChange;
  if (!("at" in schedule)) throw new ReminderError("routines_unavailable", "Routine reminders are unavailable");
  const anchor = scheduleAcceptedAt ?? change.acceptedAt;
  if (includes("schedule") && (!Number.isSafeInteger(anchor) || !Number.isSafeInteger(schedule.at)
    || schedule.at - anchor < limits.oneShotLeadMs)) throw new Error("Invalid reminder schedule anchor");
  if (includes("text") && (typeof text !== "string" || !text.trim())) throw new Error("Invalid reminder text");
  if (change.op === "create" && (typeof conversationId !== "string" || !conversationId.trim() || (policyNames !== undefined && (
    !Array.isArray(policyNames) ||
    new Set(policyNames).size !== policyNames.length || policyNames.some(name => typeof name !== "string" || !name.trim())
  )))) throw new Error("Invalid reminder destination or policies");
  if (change.op === "update" && includes("status") && status !== "active" && status !== "paused") throw new Error("Invalid reminder state");
  if (includes("expiry") && !["default", "duration", "unlimited", "unknown"].includes(expiryPolicy?.kind)) throw new Error("Invalid reminder expiry policy");
  const expiresAfter = expiryPolicy.kind === "duration" ? expiryPolicy.milliseconds : expiryPolicy.kind === "unlimited" ? null : undefined;
  if (includes("expiry") && typeof expiresAfter === "number" &&
    (!Number.isSafeInteger(expiresAfter) || expiresAfter < limits.minGraceMs || expiresAfter > limits.maxGraceMs)) {
    throw new Error("Invalid reminder grace");
  }
  const schedulePatch = () => ({ schedule: { at: new Date(schedule.at).toISOString() }, acceptedAt: new Date(anchor).toISOString() });
  const grace = includes("expiry") && expiresAfter !== undefined ? { expiresAfter } : {};
  if (change.op === "create") {
    return { ...identity, op: "create", payload: {
      channel: conversationId, text, ...schedulePatch(), ...grace,
      ...(policyNames === undefined ? {} : { policyNames: [...policyNames] }),
    } } satisfies WireChange;
  }
  const patch = {
    ...(includes("text") ? { text } : {}),
    ...(includes("status") && (status === "active" || status === "paused") ? { state: status } : {}),
    ...grace,
  };
  if (includes("schedule")) return { ...identity, op: "update", payload: { ...patch, ...schedulePatch() } } satisfies WireChange;
  if (Object.keys(patch).length === 0) throw new Error("Empty reminder update");
  return { ...identity, op: "update", payload: patch } satisfies WireChange;
}

export type { WireChange };

export function fromWireReminder(row: HarnessReminder, prior?: Reminder): Reminder {
  const { id, channel, text, state, policyNames, createdBy, creatorId, lastRunAt, lastOccurrenceId, noticeId, blockedReason } = row;
  return {
    id, conversationId: channel, text, policyNames, createdBy, creatorId, lastOccurrenceId, noticeId, blockedReason,
    status: state === "done" ? "completed" : state,
    schedule: { at: Date.parse(row.schedule.at) },
    scheduleAcceptedAt: Date.parse(row.acceptedAt),
    expiryPolicy: prior?.expiryPolicy ?? { kind: "unknown" },
    expiry: row.expiresAt === null ? null : { kind: "absolute", at: Date.parse(row.expiresAt), graceMs: row.expiresAfter! },
    nextRunAt: row.nextRunAt == null ? null : Date.parse(row.nextRunAt),
    ...(lastRunAt === undefined ? {} : { lastRunAt: Date.parse(lastRunAt) }),
  };
}

export type ReminderNotification =
  | { deadline: Omit<ReminderSessionEvent, "type"> }
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
  const fieldsByType: Record<string, readonly string[]> = {
    reminder_fired: ["reminderId", "occurrenceId", "scheduledAt", "firedAt", "noticeId"],
    reminder_cancelled: ["reminderId", "by"],
    reminder_expired: ["reminderId", "occurrenceId", "scheduledAt", "expiredAt"],
  };
  if (type === "reminder_changed") {
    const row = (fields as { reminder?: HarnessReminder }).reminder;
    if (!row || typeof row.id !== "string" || row.channel !== params.channel || typeof row.schedule?.at !== "string") return;
  } else if (fieldsByType[type]!.some(key => typeof (fields as Record<string, unknown>)[key] !== "string")) return;
  return { channel: params.channel, event: { ...fields, kind: type } as WireReminderEvent };
}
