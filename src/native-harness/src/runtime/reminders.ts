import type { ReminderChannelEvent, ReminderChange, ReminderClock, ReminderSessionEvent } from "../contracts/reminders.ts";
import type { ReminderStorage, StorageResult } from "../contracts/storage.ts";
import { createReminderTimer } from "./reminder-timer.ts";

export function createReminderRuntime(
  storage: ReminderStorage,
  clock: ReminderClock,
  executable: () => boolean,
  publish: (channel: string, event: ReminderChannelEvent, revision: number) => void,
  publishWake: (event: ReminderSessionEvent) => void,
  wakeChannel: (channel: string) => void,
) {
  let running = false, closed = false, wakeRevision = -1;
  let armed: string | null = null;
  const timer = createReminderTimer(clock, () => {
    armed = null;
    if (running && executable()) process();
  });
  const value = <T>(result: StorageResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
  };
  function refresh() {
    if (closed || !running) return;
    const wake = value(storage.reminderWake());
    if (wake.reminderRevision !== wakeRevision) {
      wakeRevision = wake.reminderRevision;
      publishWake({ type: "reminders_due", nextDueAt: wake.nextDueAt, revision: wake.reminderRevision });
    }
    const deadline = wake.nextDueAt !== null && executable() ? wake.nextDueAt : null;
    if (armed !== deadline) { armed = deadline; timer.arm(deadline); }
  }
  function process() {
    if (closed || !executable()) return;
    const committed = storage.fireDueReminders(clock.now());
    if (!committed.ok) throw new Error(committed.error.message);
    for (const { channel, event } of committed.value) {
      publish(channel, event, committed.revision);
      if (event.type === "reminder_fired") wakeChannel(channel);
    }
    refresh();
  }
  return {
    start() {
      if (running || closed) return;
      running = true;
      refresh();
    },
    stop() { closed = true; running = false; timer.stop(); },
    refresh, process,
    change(change: ReminderChange) {
      const prior = value(storage.readReminder(change.reminderId));
      const result = storage.changeReminder(change, clock.now());
      if (result.ok && result.value.outcome === "applied") {
        const current = value(storage.readReminder(change.reminderId));
        if (current && JSON.stringify(current) !== JSON.stringify(prior)) {
          publish(current.channel, current.state === "cancelled"
            ? { type: "reminder_cancelled", reminderId: current.id, by: "host" }
            : { type: "reminder_changed", reminder: current }, result.revision);
        }
      }
      refresh();
      return result;
    },
  };
}
