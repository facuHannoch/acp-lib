/** Decision 0032, approved wire pin c8facc2. */
export type RoutineEnd = { count: number; until?: never } | { until: string; count?: never }
  | { count?: never; until?: never };
export type IntervalRoutineSchedule = { every: number; startAt?: string; at?: never; cron?: never } & RoutineEnd;
export type CalendarRoutineSchedule = { cron: string; timezone: string; at?: never; every?: never } & RoutineEnd;
export type RoutineSchedule = IntervalRoutineSchedule | CalendarRoutineSchedule;
export interface RoutineDeliveryOptions {
  missedRuns?: "coalesce" | "skip" | "each";
  overlap?: "skip" | "queue";
}
export interface RoutineTimezoneMigration {
  fromVersion: string;
  targetVersion: string;
  cause: "invalid_schedule" | "proof_budget";
}
export type ReminderSchedule = OneOffSchedule | RoutineSchedule;

/** Decision 0031. All persisted instants are canonical millisecond UTC ISO strings. */
export interface OneOffSchedule { at: string }
export type AgentReminderSchedule = OneOffSchedule | { in: string };
export type ReminderState = "active" | "paused" | "blocked" | "done" | "cancelled" | "expired";
export type ReminderBlockReason = "invalid_policy" | "channel_missing" | "channel_retired"
  | "invalid_schedule" | "limit_exceeded" | "conflict" | "not_found" | "stale" | "invalid_state" | "unattended_guard_required";

interface ReminderFields {
  id: string;
  channel: string;
  createdBy: "agent" | "host";
  creatorId?: string;
  policyNames: string[];
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

/** Returned interval routines always carry their resolved startAt. */
export type OneOffReminder = ReminderFields & { schedule: OneOffSchedule; missedRuns?: never; overlap?: never;
  remainingCount?: never; timezoneVersion?: never; timezoneMigration?: never };
export type Reminder = OneOffReminder | (ReminderFields & Required<RoutineDeliveryOptions> & { remainingCount?: number } & (
    | { schedule: IntervalRoutineSchedule & { startAt: string }; timezoneVersion?: never; timezoneMigration?: never }
    | { schedule: CalendarRoutineSchedule; timezoneVersion: string; timezoneMigration?: RoutineTimezoneMigration }
  ));

type ReminderEdit = RoutineDeliveryOptions & {
  text?: string;
  state?: "active" | "paused";
  expiresAfter?: number | null;
} & ({ schedule: ReminderSchedule; acceptedAt: string } | { schedule?: never; acceptedAt?: never });

type ChangeIdentity = { reminderId: string; changeId: number };

/** Versioned host commands. Agent mutations derive their ownership from the turn. */
export type ReminderChange = ChangeIdentity & (
  | { op: "create"; payload: RoutineDeliveryOptions & { channel: string; schedule: ReminderSchedule; text: string;
      acceptedAt: string; policyNames?: string[]; expiresAfter?: number | null } }
  | { op: "update"; payload: ReminderEdit }
  | { op: "cancel"; payload: Record<string, never> }
);

/** Internal 0031 parser and storage view until recurrence is enabled. */
export type OneOffReminderChange = (ChangeIdentity & (
  | { op: "create"; payload: Omit<Extract<ReminderChange, { op: "create" }>["payload"], "schedule"> & { schedule: OneOffSchedule } }
  | { op: "update"; payload: Omit<ReminderEdit, "schedule" | "acceptedAt"> &
      ({ schedule: OneOffSchedule; acceptedAt: string } | { schedule?: never; acceptedAt?: never }) }
  | { op: "cancel"; payload: Record<string, never> }
));
export type OneOffReminderChangeResult = Exclude<ReminderChangeResult, { outcome: "applied" }>
  | (ChangeIdentity & { outcome: "applied"; reminder: OneOffReminder; alreadyQueued?: boolean });

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
  maxRoutineCatchUp?: number;
  minExpiryGraceMs: number;
  maxExpiryGraceMs: number;
  expiryMultiplier: number;
}

export type ReminderSessionEvent = { type: "reminders_due"; nextDueAt: string | null; revision: number };
export type ReminderChannelEvent =
  | { type: "routine_disposition"; reminderId: string; firstScheduledAt: string; lastScheduledAt: string; count: number;
      reason: "missed" | "catch_up_limit" | "overlap" | "expired" | "coalesced" }
  | ({ type: "routine_migration_blocked"; reminderId: string } & RoutineTimezoneMigration)
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

/** Portable reminder state in logical archive 6. High water is derived from retained receipts. */
export interface ReminderArchiveState {
  dispositions?: Array<Extract<ReminderChannelEvent, { type: "routine_disposition" | "routine_migration_blocked" }>>;
  guard?: { limit: number; counters: Array<{ channel: string; spent: number }> };
  rows: Array<{ sequence: number; reminder: Reminder; processedThrough?: number; episodeCutoff?: number; coalescedPending?: number; original?: string; defaultedExpiry: boolean }>;
  receipts: Array<{ fingerprint: string; result: ReminderChangeResult }>;
  listingRevision: number;
  wake: ReminderWake;
}
