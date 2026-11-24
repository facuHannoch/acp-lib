import { isRoutine, prepareRoutineRow } from "./routine-row.ts";
import type { Reminder, ReminderBlockReason, ReminderChange, ReminderChangeResult } from "../../contracts/reminders.ts";
import { normalizeReminderSchedule } from "../../util/reminder-schedule.ts";

export interface ReminderReceipt {
  fingerprint: string;
  result: ReminderChangeResult;
}

interface ReminderChanges {
  receipt(reminderId: string, changeId: number): ReminderReceipt | undefined;
  highWater(reminderId: string): number;
  originalCreate(reminderId: string): ReminderReceipt | undefined;
  defaultedExpiry(reminderId: string): boolean;
  get(reminderId: string): Reminder | undefined;
  put(reminder: Reminder, defaultedExpiry?: boolean, original?: string): void;
  saveReceipt(receipt: ReminderReceipt): void;
  channelStatus(channel: string): "open" | "suspended" | "suspending" | "retired" | undefined;
  guardEnabled(): boolean;
  activeRoutines(channel: string): number;
  processedThrough(id: string): number | undefined;
  proofExhausted(): never;
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
    if (reminderId.startsWith("agent-reminder:")) return persist(block("conflict"));
    const original = store.originalCreate(reminderId);
    if (original) {
      if (original.fingerprint !== fingerprint) return persist(block("conflict"));
      return persist(row ? accept(row) : { ...original.result, ...id });
    }
    if (row) return persist(block("conflict"));
    const fields = change.payload;
    const oneOff = fields.schedule.at === undefined ? undefined : normalizeReminderSchedule(fields.schedule.at, fields.acceptedAt, fields.expiresAfter, now);
    if (fields.schedule.at !== undefined && (!oneOff || fields.missedRuns !== undefined || fields.overlap !== undefined))
      return persist(block("invalid_schedule"));
    const channel = store.channelStatus(fields.channel);
    if (!channel || channel === "retired") return persist(block(channel === "retired" ? "channel_retired" : "channel_missing"));
    const policyNames = [...new Set(fields.policyNames ?? [])].sort();
    if (!store.validPolicies(policyNames)) return persist(block("invalid_policy"));
    if (fields.schedule.at === undefined) {
      if (!store.guardEnabled()) return persist(block("unattended_guard_required"));
      if (store.activeRoutines(fields.channel) >= 20) return persist(block("limit_exceeded"));
      const prepared = prepareRoutineRow(fields.schedule, fields.acceptedAt, now, fields.expiresAfter);
      if (prepared.kind === "proof_budget") return store.proofExhausted();
      if (prepared.kind !== "valid") return persist(block("invalid_schedule"));
      const reminder = { ...prepared.fields, id: reminderId, channel: fields.channel, createdBy: "host",
        policyNames, text: fields.text, state: "active", missedRuns: fields.missedRuns ?? "coalesce", overlap: fields.overlap ?? "skip" } as const;
      store.put(reminder as Reminder, fields.expiresAfter === undefined, fingerprint);
      return persist(accept(reminder as Reminder));
    }
    const schedule = oneOff!;
    const reminder: Reminder = { ...schedule, id: reminderId, channel: fields.channel, createdBy: "host",
      policyNames, text: fields.text, state: "active", nextRunAt: schedule.schedule.at };
    store.put(reminder, fields.expiresAfter === undefined, fingerprint);
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
  const defaulted = fields.expiresAfter === undefined && store.defaultedExpiry(reminderId);
  const grace = fields.expiresAfter !== undefined ? fields.expiresAfter : defaulted ? undefined : row.expiresAfter;
  if (isRoutine(row)) {
    if (fields.schedule?.at !== undefined) return persist(block("invalid_schedule"));
    const state = fields.state ?? (row.state === "blocked" ? "active" : row.state);
    if (state === "active" && row.state !== "active" && store.activeRoutines(row.channel) >= 20)
      return persist(block("limit_exceeded"));
    if (row.timezoneMigration && !fields.schedule && state === "active") return persist(block("invalid_schedule"));
    if (!fields.schedule && fields.expiresAfter === undefined && (row.state === "active" || state !== "active")) {
      const reminder = { ...row, state, text: fields.text ?? row.text, missedRuns: fields.missedRuns ?? row.missedRuns,
        overlap: fields.overlap ?? row.overlap, nextRunAt: state === "active" ? row.nextRunAt : null };
      store.put(reminder);
      return persist(accept(reminder));
    }
    const acceptedAt = fields.acceptedAt ?? row.acceptedAt;
    const schedule = fields.schedule ?? (row.remainingCount === undefined ? row.schedule
      : { ...row.schedule, count: row.remainingCount, until: undefined });
    const prepared = prepareRoutineRow(schedule, acceptedAt, fields.acceptedAt === undefined ? Math.max(now, Date.parse(row.acceptedAt)) : now, grace, store.processedThrough(row.id));
    if (prepared.kind === "proof_budget") return store.proofExhausted();
    if (prepared.kind !== "valid") return persist(block("invalid_schedule"));
    const reminder = { ...row, ...prepared.fields, ...(fields.schedule ? { timezoneMigration: undefined } : { schedule: row.schedule, remainingCount: row.remainingCount }),
      text: fields.text ?? row.text, missedRuns: fields.missedRuns ?? row.missedRuns, overlap: fields.overlap ?? row.overlap,
      blockedReason: undefined, state, nextRunAt: state === "active" ? prepared.fields.nextRunAt : null } as Reminder;
    store.put(reminder, defaulted);
    return persist(accept(reminder));
  }
  if ((fields.schedule && fields.schedule.at === undefined) || fields.missedRuns !== undefined || fields.overlap !== undefined)
    return persist(block("invalid_schedule"));
  const schedule = fields.schedule !== undefined || fields.expiresAfter !== undefined
    ? normalizeReminderSchedule(fields.schedule?.at ?? row.schedule.at, fields.acceptedAt ?? row.acceptedAt, grace, fields.acceptedAt === undefined ? Math.max(now, Date.parse(row.acceptedAt)) : now)
    : row;
  if (!schedule) return persist(block("invalid_schedule"));
  const state = fields.state ?? (row.state === "blocked" ? "active" : row.state);
  const reminder: Reminder = {
    ...row, schedule: schedule.schedule, acceptedAt: schedule.acceptedAt, expiresAfter: schedule.expiresAfter,
    expiresAt: schedule.expiresAt, text: fields.text ?? row.text, state,
    nextRunAt: state === "active" ? schedule.schedule.at : null,
  };
  delete reminder.blockedReason;
  store.put(reminder, defaulted);
  return persist(accept(reminder));
}
