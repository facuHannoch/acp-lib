import type { ReminderChange } from "../../persistence/reminders.ts";
import { HarnessIncompatibleError } from "../errors.ts";
import type { ReminderWireOpen, RoutineConfig } from "./routine-wire.ts";
import { isRoutineSchedule } from "./routine-schedule.ts";
import { ReminderError } from "./schedule.ts";

/**
 * Executable startup stages the first column and holds the second.
 *
 * Schedule | Startup                                  | Post-open live
 * One-off  | All changes                              | Overflow
 * Routine  | Cancel, pause, text, grace, missed/overlap | Create, resume, replacement
 *
 * Every change after a held entry for the same ID follows it live. A cancel
 * can erase an entirely unsent create locally. Old-calendar work can run
 * before a replacement, and a new routine can be due before its follow-up pause.
 */
export function activatesRoutine(change: Pick<ReminderChange, "op" | "fields" | "reminder">): boolean {
  return isRoutineSchedule(change.reminder.schedule) && (
    change.op === "create" || (change.op === "update" &&
      (change.fields?.includes("schedule") === true ||
        (change.fields?.includes("status") === true && change.reminder.status === "active")))
  );
}

export class RoutineAdmission {
  advertised = false;
  supported = false;
  private effective?: number;
  private bound?: number;

  initialize(routines: unknown, unattendedTurnGuard: unknown, reminders: boolean): void {
    this.advertised = reminders && routines === true;
    this.supported = this.advertised && unattendedTurnGuard === true;
    this.effective = undefined;
    if (!this.supported) this.bound = undefined;
  }

  get available(): boolean { return this.supported && this.effective !== undefined; }

  unavailable(): string | undefined {
    if (!this.supported) return "The harness must advertise routines and unattendedTurnGuard";
    if (this.effective === undefined) return "An executable open must confirm an enabled unattended-turn guard";
  }

  resetBinding(): void { this.bound = undefined; }

  configForOpen(config: RoutineConfig | undefined): RoutineConfig | undefined {
    const value = config?.limits?.unattendedTurns;
    if (value === undefined) return config;
    if (!Number.isSafeInteger(value) || value <= 0) throw new ReminderError("invalid_config", "unattendedTurns must be a positive safe integer");
    if (!this.supported) throw new HarnessIncompatibleError("The native harness must support routines and unattendedTurnGuard to configure unattendedTurns");
    if (this.bound !== value) return config;
    const { unattendedTurns: _bound, ...limits } = config!.limits!;
    const { limits: _previous, ...rest } = config!;
    return Object.keys(limits).length ? { ...rest, limits } : rest;
  }

  opened(opened: ReminderWireOpen): void {
    const value = opened.unattendedTurnGuard?.maxConsecutiveTurns;
    this.effective = this.supported && typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
    this.bound = this.effective;
  }
}
