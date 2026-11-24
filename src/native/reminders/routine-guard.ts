import type { ReminderChange } from "../../persistence/reminders.ts";
import { HarnessIncompatibleError } from "../errors.ts";
import type { ReminderWireOpen, RoutineConfig } from "./routine-wire.ts";
import { isRoutineSchedule } from "./routine-schedule.ts";
import { ReminderError } from "./schedule.ts";

export function activatesRoutine(change: Pick<ReminderChange, "op" | "fields" | "reminder">): boolean {
  return isRoutineSchedule(change.reminder.schedule) && (
    change.op === "create" || (change.op === "update" &&
      (change.fields?.includes("schedule") === true ||
        (change.fields?.includes("status") === true && change.reminder.status === "active")))
  );
}

export class RoutineAdmission {
  supported = false;
  private effective?: number;
  private bound?: number;

  initialize(routines: unknown, unattendedTurnGuard: unknown, reminders: boolean): void {
    this.supported = reminders && routines === true && unattendedTurnGuard === true;
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
