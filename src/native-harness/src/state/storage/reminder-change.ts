import type { OneOffReminder, ReminderBlockReason, OneOffReminderChange, OneOffReminderChangeResult } from "../../contracts/reminders.ts";
import { normalizeReminderSchedule } from "../../util/reminder-schedule.ts";

export interface ReminderReceipt {
  fingerprint: string;
  result: OneOffReminderChangeResult;
}

interface ReminderChanges {
  receipt(reminderId: string, changeId: number): ReminderReceipt | undefined;
  highWater(reminderId: string): number;
  originalCreate(reminderId: string): ReminderReceipt | undefined;
  defaultedExpiry(reminderId: string): boolean;
  get(reminderId: string): OneOffReminder | undefined;
  put(reminder: OneOffReminder, defaultedExpiry?: boolean, original?: string): void;
  saveReceipt(receipt: ReminderReceipt): void;
  channelStatus(channel: string): "open" | "suspended" | "suspending" | "retired" | undefined;
  validPolicies(names: readonly string[]): boolean;
}

const terminal = (row: OneOffReminder) => row.state === "done" || row.state === "cancelled" || row.state === "expired";

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, input) => input && typeof input === "object" && !Array.isArray(input)
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, input[key]]))
    : input);
}

/** The caller owns the transaction, including first-write activation and wake reconciliation. */
export function applyReminderChange(store: ReminderChanges, change: OneOffReminderChange, now: number): OneOffReminderChangeResult {
  const { reminderId, changeId, op, payload } = change;
  const id = { reminderId, changeId };
  const block = (reason: ReminderBlockReason): OneOffReminderChangeResult => ({ ...id, outcome: "blocked", reason });
  const accept = (reminder: OneOffReminder, alreadyQueued?: boolean): OneOffReminderChangeResult => ({
    ...id, outcome: "applied", reminder, ...(alreadyQueued === undefined ? {} : { alreadyQueued }),
  });
  const fingerprint = serialize([op, payload]);
  const prior = store.receipt(reminderId, changeId);
  if (prior) return prior.fingerprint === fingerprint ? prior.result : block("conflict");
  if (changeId <= store.highWater(reminderId)) return block("stale");
  const persist = (result: OneOffReminderChangeResult) => {
    store.saveReceipt({ fingerprint, result });
    return result;
  };
  const row = store.get(reminderId);
  if (change.op === "create") {
    if (reminderId.startsWith("agent-reminder:")) return persist(block("conflict"));
    const original = store.originalCreate(reminderId);
    if (original) {
      if (original.fingerprint !== fingerprint) return persist(block("conflict"));
      return persist(row ? accept(row) : { ...original.result, ...id });
    }
    if (row) return persist(block("conflict"));
    const fields = change.payload;
    const schedule = normalizeReminderSchedule(fields.schedule.at, fields.acceptedAt, fields.expiresAfter, now);
    if (!schedule) return persist(block("invalid_schedule"));
    const channel = store.channelStatus(fields.channel);
    if (!channel || channel === "retired") return persist(block(channel === "retired" ? "channel_retired" : "channel_missing"));
    const policyNames = [...new Set(fields.policyNames ?? [])].sort();
    if (!store.validPolicies(policyNames)) return persist(block("invalid_policy"));
    const reminder: OneOffReminder = { ...schedule, id: reminderId, channel: fields.channel, createdBy: "host",
      policyNames, text: fields.text, state: "active", nextRunAt: schedule.schedule.at };
    store.put(reminder, fields.expiresAfter === undefined, fingerprint);
    return persist(accept(reminder));
  }
  if (!row) return persist(block("not_found"));
  if (op === "cancel") {
    const reminder: OneOffReminder = terminal(row) ? row : { ...row, state: "cancelled", nextRunAt: null };
    if (reminder !== row) store.put(reminder);
    return persist(accept(reminder, row.noticeId !== undefined));
  }
  if (terminal(row)) return persist(block("invalid_state"));
  const fields = change.payload;
  const channel = store.channelStatus(row.channel);
  if (!channel || channel === "retired") return persist(block(channel === "retired" ? "channel_retired" : "channel_missing"));
  if (!store.validPolicies(row.policyNames)) return persist(block("invalid_policy"));
  const defaulted = fields.expiresAfter === undefined && store.defaultedExpiry(reminderId);
  const grace = fields.expiresAfter !== undefined ? fields.expiresAfter : defaulted ? undefined : row.expiresAfter;
  const schedule = fields.schedule !== undefined || fields.expiresAfter !== undefined
    ? normalizeReminderSchedule(fields.schedule?.at ?? row.schedule.at, fields.acceptedAt ?? row.acceptedAt, grace, fields.acceptedAt === undefined ? Math.max(now, Date.parse(row.acceptedAt)) : now)
    : row;
  if (!schedule) return persist(block("invalid_schedule"));
  const state = fields.state ?? (row.state === "blocked" ? "active" : row.state);
  const reminder: OneOffReminder = {
    ...row, schedule: schedule.schedule, acceptedAt: schedule.acceptedAt, expiresAfter: schedule.expiresAfter,
    expiresAt: schedule.expiresAt, text: fields.text ?? row.text, state,
    nextRunAt: state === "active" ? schedule.schedule.at : null,
  };
  delete reminder.blockedReason;
  store.put(reminder, defaulted);
  return persist(accept(reminder));
}
