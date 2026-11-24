import type { InitializeResult, ProtocolConfig, Reminder, ReminderLimits } from "../../native-harness/src/client.ts";

export type {
  Reminder as ReminderWireRow, ReminderChange as ReminderWireChange,
  ReminderChangeResult as ReminderWireResult, ReminderList as ReminderWireList,
  OpenResult as ReminderWireOpen, ProtocolConfig as RoutineConfig,
  RoutineTimezoneMigration as TimezoneMigration,
} from "../../native-harness/src/client.ts";

export type RoutineRow = Extract<Reminder, { missedRuns: string }>;

export type AdvertisedReminderLimits = Partial<ReminderLimits>;
export interface ReminderNegotiation {
  capabilities?: Partial<Record<Extract<keyof InitializeResult["description"]["capabilities"],
    "reminders" | "routines" | "unattendedTurnGuard">, boolean>>;
  reminderLimits?: AdvertisedReminderLimits;
}

export type RoutineConfigInput = Omit<ProtocolConfig, "limits"> & {
  limits?: { unattendedTurns: number | "unlimited" };
};
