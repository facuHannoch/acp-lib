import type { ReminderTimer } from "../../../src/native/reminders/supervisor.ts";

export class ReminderClock implements ReminderTimer {
  time = 0;
  readonly pending = new Map<number, { delay: number; task: () => void }>();
  private id = 0;
  now = () => this.time;
  set(delay: number, task: () => void): () => void {
    const id = ++this.id;
    this.pending.set(id, { delay, task });
    return () => { this.pending.delete(id); };
  }
  get delays() { return [...this.pending.values()].map(({ delay }) => delay); }
  tickAt(time: number): void {
    this.time = time;
    for (const [id, { task }] of [...this.pending]) {
      this.pending.delete(id);
      task();
    }
  }
}
