import type { Reminder, ReminderBlockReason, ReminderChange, ReminderChangeResult } from "../../contracts/reminders.ts";
import { normalizeReminderSchedule } from "../../util/reminder-schedule.ts";

export interface ReminderReceipt {
  fingerprint: string;
  result: ReminderChangeResult;
}

interface ReminderChanges {
  receipt(reminderId: string, changeId: number): ReminderReceipt | undefined;
  highWater(reminderId: string): number;
  original(reminderId: string): string | undefined;
  get(reminderId: string): Reminder | undefined;
  put(reminder: Reminder, original?: string): void;
  saveReceipt(receipt: ReminderReceipt): void;
  channelStatus(channel: string): "open" | "suspended" | "suspending" | "retired" | undefined;
  validPolicies(names: readonly string[]): boolean;
}

const terminal = (row: Reminder) => row.state === "done" || row.state === "cancelled" || row.state === "expired";

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, input) => input && typeof input === "object" && !Array.isArray(input)
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, input[key]]))
    : input);
}

/** The caller owns the transaction, including first-write activation and wake reconciliation. */
export function applyReminderChange(store: ReminderChanges, change: ReminderChange, now: number): ReminderChangeResult {
  const { reminderId, changeId, op, payload } = change;
  const id = { reminderId, changeId };
  const block = (reason: ReminderBlockReason): ReminderChangeResult => ({ ...id, outcome: "blocked", reason });
  const accept = (reminder: Reminder, alreadyQueued?: boolean): ReminderChangeResult => ({
    ...id, outcome: "applied", reminder, ...(alreadyQueued === undefined ? {} : { alreadyQueued }),
  });
  const fingerprint = serialize([op, payload]);
  const prior = store.receipt(reminderId, changeId);
  if (prior) return prior.fingerprint === fingerprint ? prior.result : block("conflict");
  if (changeId <= store.highWater(reminderId)) return block("stale");
  const persist = (result: ReminderChangeResult) => {
    store.saveReceipt({ fingerprint, result });
    return result;
  };
  const row = store.get(reminderId);
  if (change.op === "create") {
    if (row) return persist(store.original(reminderId) === fingerprint ? accept(row) : block("conflict"));
    const fields = change.payload;
    const schedule = normalizeReminderSchedule(fields.schedule.at, fields.acceptedAt, fields.expiresAfter, now);
    if (!schedule) return persist(block("invalid_schedule"));
    const channel = store.channelStatus(fields.channel);
    if (!channel || channel === "retired") return persist(block(channel === "retired" ? "channel_retired" : "channel_missing"));
    const policyNames = [...new Set(fields.policyNames ?? [])].sort();
    if (!store.validPolicies(policyNames)) return persist(block("invalid_policy"));
    const reminder: Reminder = { ...schedule, id: reminderId, channel: fields.channel, createdBy: "host",
      policyNames, text: fields.text, state: "active", nextRunAt: schedule.schedule.at };
    store.put(reminder, fingerprint);
    return persist(accept(reminder));
  }
  if (!row) return persist(block("not_found"));
  if (op === "cancel") {
    const reminder: Reminder = terminal(row) ? row : { ...row, state: "cancelled", nextRunAt: null };
    if (reminder !== row) store.put(reminder);
    return persist(accept(reminder, row.noticeId !== undefined));
  }
  if (terminal(row)) return persist(block("invalid_state"));
  const fields = change.payload;
  const channel = store.channelStatus(row.channel);
  if (!channel || channel === "retired") return persist(block(channel === "retired" ? "channel_retired" : "channel_missing"));
  if (!store.validPolicies(row.policyNames)) return persist(block("invalid_policy"));
  const schedule = fields.schedule !== undefined || fields.expiresAfter !== undefined
    ? normalizeReminderSchedule(fields.schedule?.at ?? row.schedule.at, fields.acceptedAt ?? row.acceptedAt, fields.expiresAfter, now)
    : row;
  if (!schedule) return persist(block("invalid_schedule"));
  const state = fields.state ?? (row.state === "blocked" ? "active" : row.state);
  const reminder: Reminder = {
    ...row, schedule: schedule.schedule, acceptedAt: schedule.acceptedAt, expiresAfter: schedule.expiresAfter,
    expiresAt: schedule.expiresAt, text: fields.text ?? row.text, state,
    nextRunAt: state === "active" ? schedule.schedule.at : null,
  };
  delete reminder.blockedReason;
  store.put(reminder);
  return persist(accept(reminder));
}
