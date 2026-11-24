import type { ConditionalStopResult } from "../../native-harness/src/client.ts";
import type { NativeHostState } from "../host.ts";
import type { ReminderTimer } from "./supervisor.ts";
import { wallReminderTimer } from "./supervisor.ts";

export function idleMilliseconds(value: number | undefined, name: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(name + " must be a nonnegative safe integer in milliseconds");
  }
  return value;
}

interface IdleHost {
  state(): NativeHostState;
  window(): Promise<number | undefined>;
  stop(window: number, stillIdle: () => boolean): Promise<ConditionalStopResult>;
  error(error: unknown): void;
}

export class ReminderIdleSupervisor {
  private cancel?: () => void;
  private epoch = 0;
  private closed = false;
  private failures = 0;
  private lastActivity: number;

  constructor(
    private readonly host: IdleHost,
    private readonly idleMs: number,
    private readonly clock: ReminderTimer = wallReminderTimer,
  ) { this.lastActivity = clock.now(); }

  activity(): void {
    this.epoch++;
    this.lastActivity = this.clock.now();
    this.failures = 0;
    this.arm(this.idleMs);
  }

  close(): void {
    this.closed = true;
    this.cancel?.();
  }

  private arm(delay: number): void {
    this.cancel?.();
    if (!this.closed && this.host.state() === "running") {
      this.cancel = this.clock.set(Math.min(60_000, Math.max(1_000, delay)), () => void this.check());
    }
  }

  private async check(): Promise<void> {
    if (this.closed || this.host.state() !== "running") return;
    const remaining = this.lastActivity + this.idleMs - this.clock.now();
    if (remaining > 0) { this.arm(remaining); return; }
    const epoch = this.epoch;
    const stillIdle = () => !this.closed && epoch === this.epoch && this.host.state() === "running";
    try {
      const window = await this.host.window();
      if (!stillIdle()) return;
      if (window !== undefined && (await this.host.stop(window, stillIdle)).stopped) return;
    } catch (error) {
      if (!this.closed) this.host.error(error);
    }
    if (stillIdle()) {
      this.failures++;
      this.arm(Math.max(this.idleMs, 1000 * 2 ** Math.min(this.failures, 6)));
    }
  }
}
