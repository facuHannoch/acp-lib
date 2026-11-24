import type { HarnessClient, Reminder as HarnessReminder, ReminderChange, ReminderChangeResult, ReminderList } from "../../native-harness/src/client.ts";
import type { MissedRuns, RoutineOverlap, RoutineSchedule } from "./routine-schedule.ts";

type Create = Extract<ReminderChange, { op: "create" }>;
type Update = Extract<ReminderChange, { op: "update" }>;
type RoutinePolicy = { missedRuns?: MissedRuns; overlap?: RoutineOverlap };
export type RoutineChange =
  | (Omit<Create, "payload"> & {
    payload: Omit<Create["payload"], "schedule"> & { schedule: RoutineSchedule<string> } & RoutinePolicy;
  })
  | (Omit<Update, "payload"> & {
    payload: Pick<Update["payload"], "text" | "state" | "expiresAfter"> & RoutinePolicy &
      ({ schedule: RoutineSchedule<string>; acceptedAt: string } | { schedule?: never; acceptedAt?: never });
  });

export type ReminderWireChange = ReminderChange | RoutineChange;

export type TimezoneMigration = {
  fromVersion: string;
  targetVersion: string;
  cause: "invalid_schedule" | "proof_budget";
};

export type RoutineRow = Omit<HarnessReminder, "schedule"> & {
  schedule: RoutineSchedule<string, { readonly startAt: string }>;
  remainingCount?: number;
  missedRuns: MissedRuns;
  overlap: RoutineOverlap;
  timezoneVersion?: string;
  timezoneMigration?: TimezoneMigration;
};
export type ReminderWireRow = HarnessReminder | RoutineRow;
export type ReminderWireResult = (Omit<Extract<ReminderChangeResult, { outcome: "applied" }>, "reminder"> & { reminder: ReminderWireRow })
  | (Omit<Extract<ReminderChangeResult, { outcome: "blocked" }>, "reason"> & {
    reason: Extract<ReminderChangeResult, { outcome: "blocked" }>["reason"] | "unattended_guard_required";
  });

type OpenParams = Parameters<HarnessClient["openSession"]>[0];
type CreateParams = Parameters<HarnessClient["createSession"]>[0];
type Open = Awaited<ReturnType<HarnessClient["openSession"]>>;
export type RoutineGuard = { maxConsecutiveTurns: number };
export type RoutineConfig = NonNullable<OpenParams["config"]> & { limits?: { unattendedTurns?: number } };
export type ReminderWireOpen = Omit<Open, "reminders" | "reminderChanges"> & {
  reminders?: ReminderWireRow[];
  reminderChanges?: ReminderWireResult[];
  unattendedTurnGuard?: RoutineGuard | null;
};
export type ReminderWireList = Omit<ReminderList, "reminders"> & { reminders: ReminderWireRow[] };

type RoutineTransport = {
  openSession(params: Omit<OpenParams, "reminderChanges"> & { reminderChanges?: ReminderWireChange[] }): Promise<ReminderWireOpen>;
  createSession(params: Omit<CreateParams, "reminderChanges"> & { reminderChanges?: ReminderWireChange[] }): Promise<ReminderWireOpen>;
  changeReminder(params: ReminderWireChange): Promise<ReminderWireResult>;
  getReminder(params: Parameters<HarnessClient["getReminder"]>[0]): Promise<{ reminder: ReminderWireRow }>;
  listReminders(params: Parameters<HarnessClient["listReminders"]>[0]): Promise<ReminderWireList>;
};

/** 0032 adds payloads to existing typed methods. Keep the temporary contract
 * bridge here until the approved runtime exports the extended types. */
export function routineTransport(client: HarnessClient): RoutineTransport {
  return client as unknown as RoutineTransport;
}


export type RoutineDispositionReason = "missed" | "catch_up_limit" | "overlap" | "expired" | "coalesced";
export type RoutineChannelEvent =
  | { type: "routine_disposition"; reminderId: string; firstScheduledAt: string; lastScheduledAt: string; count: number; reason: RoutineDispositionReason }
  | ({ type: "routine_migration_blocked"; reminderId: string } & TimezoneMigration);
