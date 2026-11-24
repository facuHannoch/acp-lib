import type { Reminder, ReminderWake } from "../../contracts/reminders.ts";
import type { ReminderReceipt } from "./reminder-change.ts";

export interface ReminderRow {
  sequence: number;
  reminder: Reminder;
  original?: string;
}

export interface ReminderTables {
  activate(): void;
  get(id: string): ReminderRow | undefined;
  put(row: ReminderRow): void;
  receipt(id: string, changeId: number): ReminderReceipt | undefined;
  highWater(id: string): number;
  saveReceipt(receipt: ReminderReceipt): void;
  list(channel: string | undefined, after: number, limit: number): ReminderRow[];
  eligible(through: string | null, limit: number): ReminderRow[];
  listingRevision(): number;
  wake(): ReminderWake;
  setWake(wake: ReminderWake): void;
}
