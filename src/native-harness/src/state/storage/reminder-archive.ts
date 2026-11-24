import type { Reminder, ReminderArchiveState } from "../../contracts/reminders.ts";
import type { StorageSnapshot } from "../../contracts/storage.ts";
import { normalizeReminderSchedule, reminderInstant } from "../../util/reminder-schedule.ts";
import { Fail } from "./engine.ts";

const bad = (): never => { throw new Fail("invalid_archive", "Invalid archived reminder state"); };
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const iso = (value: unknown): boolean => typeof value === "string" &&
  reminderInstant(value) !== undefined && new Date(Date.parse(value)).toISOString() === value;

export function validateReminderArchive(state: ReminderArchiveState | undefined, snapshot: StorageSnapshot): void {
  if (!state || !Array.isArray(state.rows) || !Array.isArray(state.receipts) || !integer(state.listingRevision) ||
    !state.wake || !integer(state.wake.reminderRevision) ||
    (state.wake.nextDueAt !== null && !iso(state.wake.nextDueAt))) return bad();
  const channels = new Map(snapshot.channels.map(channel => [channel.channelId, channel.lifecycle]));
  const items = new Map(snapshot.items.map(item => [item.itemId, item]));
  const ids = new Set<string>(), receipts = new Set<string>();
  const validRow = (row: Reminder): boolean => {
    if (!row || !text(row.id) || !channels.has(row.channel) || !text(row.text) ||
      (row.createdBy !== "host" && row.createdBy !== "agent") || !Array.isArray(row.policyNames) ||
      !row.policyNames.every(text) || new Set(row.policyNames).size !== row.policyNames.length ||
      !row.schedule || !iso(row.schedule.at) || !iso(row.acceptedAt) ||
      !["active", "paused", "blocked", "done", "cancelled", "expired"].includes(row.state)) return false;
    const schedule = normalizeReminderSchedule(row.schedule.at, row.acceptedAt, row.expiresAfter, Date.parse(row.acceptedAt));
    return !!schedule && row.expiresAfter === schedule.expiresAfter && row.expiresAt === schedule.expiresAt &&
      row.nextRunAt === (row.state === "active" ? row.schedule.at : null);
  };
  let sequence = 0, nextDueAt: string | null = null;
  for (const entry of state.rows) {
    if (!entry || !integer(entry.sequence) || entry.sequence <= sequence || entry.sequence > snapshot.revision ||
      typeof entry.defaultedExpiry !== "boolean" || !validRow(entry.reminder) || ids.has(entry.reminder.id) || (entry.original !== undefined && !text(entry.original))) return bad();
    const row = entry.reminder;
    if (entry.defaultedExpiry) {
      const defaulted = normalizeReminderSchedule(row.schedule.at, row.acceptedAt, undefined, Date.parse(row.acceptedAt));
      if (defaulted?.expiresAfter !== row.expiresAfter) return bad();
    }
    sequence = entry.sequence;
    ids.add(row.id);
    if (row.state === "done") {
      const notice = items.get(row.noticeId ?? "");
      if (row.noticeId !== `reminder-notice:${row.id}:${row.schedule.at}` ||
        row.lastOccurrenceId !== `reminder:${row.id}:${row.schedule.at}` || !iso(row.lastRunAt) ||
        notice?.kind !== "external_notice" || notice.channelId !== row.channel || notice.text !== row.text ||
        notice.externalSource !== `reminder:${row.id}`) return bad();
    } else if (row.noticeId !== undefined || row.lastRunAt !== undefined) return bad();
    if (snapshot.session.lifecycle === "running" && channels.get(row.channel) === "open" && row.nextRunAt !== null &&
      (nextDueAt === null || row.nextRunAt < nextDueAt)) nextDueAt = row.nextRunAt;
  }
  if ((!state.rows.length && !state.receipts.length && !state.guard) || state.listingRevision < state.rows.length ||
    state.wake.nextDueAt !== nextDueAt || (nextDueAt !== null && !state.wake.reminderRevision)) return bad();
  for (const receipt of state.receipts) {
    const result = receipt?.result;
    if (!result || !text(receipt.fingerprint) || !text(result.reminderId) || !integer(result.changeId) || !result.changeId) return bad();
    const key = JSON.stringify([result.reminderId, result.changeId]);
    if (receipts.has(key)) return bad();
    receipts.add(key);
    if (result.outcome === "applied") {
      if (!validRow(result.reminder) || result.reminder.id !== result.reminderId || !ids.has(result.reminderId)) return bad();
    } else if (result.outcome !== "blocked" || !["invalid_policy", "channel_missing", "channel_retired", "invalid_schedule",
      "limit_exceeded", "conflict", "not_found", "stale", "invalid_state"].includes(result.reason)) return bad();
  }
}
