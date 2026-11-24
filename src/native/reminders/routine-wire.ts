import type { Reminder } from "../../native-harness/src/client.ts";

export type {
  Reminder as ReminderWireRow, ReminderChange as ReminderWireChange,
  ReminderChangeResult as ReminderWireResult, ReminderList as ReminderWireList,
  OpenResult as ReminderWireOpen, ProtocolConfig as RoutineConfig,
  RoutineTimezoneMigration as TimezoneMigration,
} from "../../native-harness/src/client.ts";

export type RoutineRow = Extract<Reminder, { missedRuns: string }>;
