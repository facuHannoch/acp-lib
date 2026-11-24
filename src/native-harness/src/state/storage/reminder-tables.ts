import type { Reminder, ReminderArchiveState, ReminderWake } from "../../contracts/reminders.ts";
import type { ReminderReceipt } from "./reminder-change.ts";

export interface ReminderRow {
  sequence: number;
  reminder: Reminder;
  original?: string;
  defaultedExpiry: boolean;
  processedThrough?: number;
  episodeCutoff?: number; coalescedPending?: number;
}

export interface ReminderTables {
  activate(): void;
  recordDisposition(event: NonNullable<ReminderArchiveState["dispositions"]>[number]): void;
  activeRoutines(channel: string): number;
  guardLimit(): number | undefined;
  bindGuard(limit: number): void;
  guardSpent(channel: string): number;
  setGuardSpent(channel: string, spent: number): void;
  archive(): ReminderArchiveState;
  restore(state: ReminderArchiveState): void;
  get(id: string): ReminderRow | undefined;
  put(row: ReminderRow): void;
  originalCreate(id: string): ReminderReceipt | undefined;
  receipt(id: string, changeId: number): ReminderReceipt | undefined;
  highWater(id: string): number;
  saveReceipt(receipt: ReminderReceipt): void;
  list(channel: string | undefined, after: number, limit: number): ReminderRow[];
  blocked(channel: string | undefined, after: number, limit: number): ReminderRow[];
  eligible(through: string | null, limit: number, heldChannels?: readonly string[]): ReminderRow[];
  listingRevision(): number;
  wake(): ReminderWake;
  setWake(wake: ReminderWake): void;
}
