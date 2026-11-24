/** Decision 0031. All persisted instants are canonical millisecond UTC ISO strings. */
export interface OneOffSchedule { at: string }
export type AgentReminderSchedule = OneOffSchedule | { in: string };
export type ReminderState = "active" | "paused" | "blocked" | "done" | "cancelled" | "expired";
export type ReminderBlockReason = "invalid_policy" | "channel_missing" | "channel_retired"
  | "invalid_schedule" | "limit_exceeded" | "conflict" | "not_found" | "stale" | "invalid_state";

export interface Reminder {
  id: string;
  channel: string;
  createdBy: "agent" | "host";
  creatorId?: string;
  policyNames: string[];
  schedule: OneOffSchedule;
  text: string;
  state: ReminderState;
  nextRunAt: string | null;
  acceptedAt: string;
  expiresAfter: number | null;
  expiresAt: string | null;
  lastRunAt?: string;
  lastOccurrenceId?: string;
  noticeId?: string;
  blockedReason?: ReminderBlockReason;
}

type ReminderEdit = {
  text?: string;
  state?: "active" | "paused";
  expiresAfter?: number | null;
} & ({ schedule: OneOffSchedule; acceptedAt: string } | { schedule?: never; acceptedAt?: never });

type ChangeIdentity = { reminderId: string; changeId: number };

/** Versioned host commands. Agent mutations derive their ownership from the turn. */
export type ReminderChange = ChangeIdentity & (
  | { op: "create"; payload: { channel: string; schedule: OneOffSchedule; text: string;
      acceptedAt: string; policyNames?: string[]; expiresAfter?: number | null } }
  | { op: "update"; payload: ReminderEdit }
  | { op: "cancel"; payload: Record<string, never> }
);

export type ReminderChangeResult = ChangeIdentity & (
  | { outcome: "applied"; reminder: Reminder; alreadyQueued?: boolean }
  | { outcome: "blocked"; reason: ReminderBlockReason }
);

export interface ReminderListParams { channel?: string; after?: string; limit?: number }
export interface ReminderList { reminders: Reminder[]; next?: string }
export interface ReminderWake { nextDueAt: string | null; reminderRevision: number }
export type ReminderOpen = {
  reminderChanges: ReminderChangeResult[];
  reminders: Reminder[];
  remindersNext?: string;
} & (ReminderWake | { nextDueAt?: never; reminderRevision?: never });

export interface ReminderLimits {
  minLeadMs: number;
  minIntervalMs: number;
  maxActiveRoutinesPerChannel: number;
  minExpiryGraceMs: number;
  maxExpiryGraceMs: number;
  expiryMultiplier: number;
}

export type ReminderSessionEvent = { type: "reminders_due"; nextDueAt: string | null; revision: number };
export type ReminderChannelEvent =
  | { type: "reminder_changed"; reminder: Reminder }
  | { type: "reminder_fired"; reminderId: string; occurrenceId: string; scheduledAt: string; firedAt: string; noticeId: string }
  | { type: "reminder_cancelled"; reminderId: string; by: "host" | "agent" | "channel_retired" }
  | { type: "reminder_expired"; reminderId: string; occurrenceId: string; scheduledAt: string; expiredAt: string };

export interface ConditionalStopParams { ifIdle: true; unlessDueWithinMs?: number }
export type ConditionalStopResult = { stopped: true } | { stopped: false; reason: "busy" | "next_due_soon" };

export interface ReminderMethods {
  "reminder/change": { params: ReminderChange; result: ReminderChangeResult };
  "reminder/get": { params: { id: string }; result: { reminder: Reminder } };
  "reminder/list": { params: ReminderListParams; result: ReminderList };
}

/** Wall time drives eligibility. A timer only requests an eligibility recheck. */
export interface ReminderClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): () => void;
}
