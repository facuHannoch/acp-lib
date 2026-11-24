import { isRoutine } from "./routine-row.ts";
import type { Reminder, ReminderArchiveState } from "../../contracts/reminders.ts";
import type { StorageSnapshot } from "../../contracts/storage.ts";
import { normalizeReminderSchedule, reminderInstant } from "../../util/reminder-schedule.ts";
import { Fail, initialIntakeHasParticipant } from "./engine.ts";

const bad = (): never => { throw new Fail("invalid_archive", "Invalid archived reminder state"); };
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const iso = (value: unknown): boolean => typeof value === "string" &&
  reminderInstant(value) !== undefined && new Date(Date.parse(value)).toISOString() === value;

export function validateReminderArchive(state: ReminderArchiveState | undefined, snapshot: StorageSnapshot): void {
  if (!state || !Array.isArray(state.rows) || !Array.isArray(state.receipts) || !integer(state.listingRevision) ||
    (state.guard !== undefined && !Array.isArray(state.guard.counters)) || !state.wake || !integer(state.wake.reminderRevision) ||
    (state.wake.nextDueAt !== null && !iso(state.wake.nextDueAt))) return bad();
  const channels = new Map(snapshot.channels.map(channel => [channel.channelId, channel.lifecycle]));
  const items = new Map(snapshot.items.map(item => [item.itemId, item]));
  const ids = new Set<string>(), receipts = new Set<string>();
  const validRow = (row: Reminder): boolean => {
    if (!row || !text(row.id) || !channels.has(row.channel) || !text(row.text) ||
      (row.createdBy !== "host" && row.createdBy !== "agent") || !Array.isArray(row.policyNames) ||
      !row.policyNames.every(text) || new Set(row.policyNames).size !== row.policyNames.length ||
      !row.schedule || !iso(row.acceptedAt) ||
      !["active", "paused", "blocked", "done", "cancelled", "expired"].includes(row.state)) return false;
    if (isRoutine(row)) {
      if (snapshot.session.formatVersion < 8 || !state.guard ||
          !["coalesce", "skip", "each"].includes(row.missedRuns) || !["skip", "queue"].includes(row.overlap) ||
          (row.remainingCount !== undefined && !integer(row.remainingCount)) ||
          (row.state === "active" ? !iso(row.nextRunAt) : row.nextRunAt !== null)) return false;
      if ("every" in row.schedule && row.schedule.every !== undefined)
        return integer(row.schedule.every) && row.schedule.every >= 600_000 && iso(row.schedule.startAt);
      return "cron" in row.schedule && text(row.schedule.cron) && text(row.schedule.timezone) &&
        typeof row.timezoneVersion === "string" && /^\d{4}[a-z]+$/.test(row.timezoneVersion);
    }
    if (!iso(row.schedule.at)) return false;
    const schedule = normalizeReminderSchedule(row.schedule.at!, row.acceptedAt, row.expiresAfter, Date.parse(row.acceptedAt));
    return !!schedule && row.expiresAfter === schedule.expiresAfter && row.expiresAt === schedule.expiresAt &&
      row.nextRunAt === (row.state === "active" ? row.schedule.at : null);
  };
  let sequence = 0, nextDueAt: string | null = null;
  for (const entry of state.rows) {
    if (!entry || !integer(entry.sequence) || entry.sequence <= sequence || entry.sequence > snapshot.revision ||
      typeof entry.defaultedExpiry !== "boolean" || !validRow(entry.reminder) || ids.has(entry.reminder.id) || (entry.original !== undefined && !text(entry.original))) return bad();
    const row = entry.reminder;
    if (entry.defaultedExpiry && !isRoutine(row)) {
      const defaulted = normalizeReminderSchedule(row.schedule.at!, row.acceptedAt, undefined, Date.parse(row.acceptedAt));
      if (defaulted?.expiresAfter !== row.expiresAfter) return bad();
    }
    sequence = entry.sequence;
    ids.add(row.id);
    if (isRoutine(row)) {
      if (entry.processedThrough !== undefined && !Number.isSafeInteger(entry.processedThrough)) return bad();
      if (entry.episodeCutoff !== undefined && !Number.isSafeInteger(entry.episodeCutoff)) return bad();
      if (entry.coalescedPending !== undefined && !integer(entry.coalescedPending)) return bad();
      if (row.noticeId !== undefined) {
        const notice = items.get(row.noticeId);
        if (notice?.kind !== "external_notice" || notice.channelId !== row.channel ||
            notice.externalSource !== `reminder:${row.id}` || !iso(row.lastRunAt)) return bad();
      }
    } else if (row.state === "done") {
      const notice = items.get(row.noticeId ?? "");
      if (row.noticeId !== `reminder-notice:${row.id}:${row.schedule.at}` ||
        row.lastOccurrenceId !== `reminder:${row.id}:${row.schedule.at}` || !iso(row.lastRunAt) ||
        notice?.kind !== "external_notice" || notice.channelId !== row.channel || notice.text !== row.text ||
        notice.externalSource !== `reminder:${row.id}`) return bad();
    } else if (row.noticeId !== undefined || row.lastRunAt !== undefined) return bad();
    const isHeld = isRoutine(row) && !!state.guard && (state.guard.counters.find(counter => counter.channel === row.channel)?.spent ?? 0) >= state.guard.limit
      && !hasRunnableParticipant(snapshot, row.channel);
    if (!isHeld && snapshot.session.lifecycle === "running" && channels.get(row.channel) === "open" && row.nextRunAt !== null &&
      (nextDueAt === null || row.nextRunAt < nextDueAt)) nextDueAt = row.nextRunAt;
  }
  if ((!state.rows.length && !state.receipts.length && !state.guard) || state.listingRevision < state.rows.length ||
    state.wake.nextDueAt !== nextDueAt || (nextDueAt !== null && !state.wake.reminderRevision)) return bad();
  if (state.dispositions !== undefined) {
    if (snapshot.session.formatVersion < 8 || !Array.isArray(state.dispositions)) return bad();
    for (const entry of state.dispositions) {
      if (!entry || !ids.has(entry.reminderId)) return bad();
      if (entry.type === "routine_disposition") {
        if (!integer(entry.count) || !entry.count || !iso(entry.firstScheduledAt) || !iso(entry.lastScheduledAt) ||
            entry.lastScheduledAt < entry.firstScheduledAt || !["missed", "catch_up_limit", "overlap", "expired", "coalesced"].includes(entry.reason)) return bad();
      } else if (entry.type !== "routine_migration_blocked" || !text(entry.fromVersion) || !text(entry.targetVersion) ||
          !["invalid_schedule", "proof_budget"].includes(entry.cause)) return bad();
    }
  }
  for (const receipt of state.receipts) {
    const result = receipt?.result;
    if (!result || !text(receipt.fingerprint) || !text(result.reminderId) || !integer(result.changeId) || !result.changeId) return bad();
    const key = JSON.stringify([result.reminderId, result.changeId]);
    if (receipts.has(key)) return bad();
    receipts.add(key);
    if (result.outcome === "applied") {
      if (!validRow(result.reminder) || result.reminder.id !== result.reminderId || !ids.has(result.reminderId)) return bad();
    } else if (result.outcome !== "blocked" || !["invalid_policy", "channel_missing", "channel_retired", "invalid_schedule",
      "limit_exceeded", "unattended_guard_required", "conflict", "not_found", "stale", "invalid_state"].includes(result.reason)) return bad();
  }
}


function hasRunnableParticipant(snapshot: StorageSnapshot, channel: string): boolean {
  const items = snapshot.items.filter(item => item.channelId === channel && item.milestone === "received")
    .sort((left, right) => left.acceptedSeq - right.acceptedSeq);
  return initialIntakeHasParticipant(items);
}
