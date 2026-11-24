import type { NativeHostState } from "../host.ts";
import type { ReminderWakeIndex } from "../../persistence/reminders.ts";

export interface ReminderTimer {
  now(): number;
  set(delayMs: number, task: () => void): () => void;
}

export const wallReminderTimer: ReminderTimer = {
  now: Date.now,
  set(delay, task) {
    const timer = setTimeout(task, delay);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

interface WakeSource {
  state(): NativeHostState;
  index(): Promise<ReminderWakeIndex>;
  subscribe(listener: () => void): () => void;
  start(now: number): Promise<void>;
  error(error: unknown): void;
}

/** One owner may arm one cold wake. The harness owns scheduling while running. */
export class ReminderWakeSupervisor {
  private release?: () => void;
  private unsubscribe?: () => void;
  private generation = 0;
  private closed = false;
  private waking = false;
  private armed?: { target: number; cancel: () => void };

  constructor(private readonly source: WakeSource, private readonly clock: ReminderTimer = wallReminderTimer) {
    this.unsubscribe = source.subscribe(() => this.refresh());
    this.refresh();
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.release?.();
    this.disarm();
  }

  subscribeHost(subscribe: (listener: () => void) => () => void): void {
    this.release = subscribe(() => this.refresh());
  }

  refresh(): void {
    const generation = ++this.generation;
    if (!this.eligible()) { this.disarm(); return; }
    void this.source.index().then(({ effectiveAt }) => {
      if (generation !== this.generation || !this.eligible()) return;
      if (effectiveAt !== null && this.armed?.target === effectiveAt) return;
      this.disarm();
      if (effectiveAt === null) return;
      const delay = Math.min(60_000, Math.max(1_000, effectiveAt - this.clock.now()));
      this.armed = { target: effectiveAt, cancel: this.clock.set(delay, () => void this.wake(effectiveAt)) };
    }).catch(error => { if (!this.closed) this.source.error(error); });
  }

  private eligible(): boolean {
    const state = this.source.state();
    return !this.closed && !this.waking && (state === "stopped" || state === "starting");
  }

  private disarm(): void {
    this.armed?.cancel();
    this.armed = undefined;
  }

  private async wake(target: number): Promise<void> {
    if (this.armed?.target !== target) return;
    this.disarm();
    if (!this.eligible()) return;
    if (this.clock.now() < target) { this.refresh(); return; }
    this.waking = true;
    try {
      const { effectiveAt } = await this.source.index();
      if (this.closed || effectiveAt === null || effectiveAt > this.clock.now() || this.source.state() === "running") return;
      await this.source.start(this.clock.now());
    } catch (error) {
      if (!this.closed) this.source.error(error);
    } finally {
      this.waking = false;
      this.refresh();
    }
  }
}
