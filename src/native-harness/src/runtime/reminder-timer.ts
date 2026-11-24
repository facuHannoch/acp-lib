import type { ReminderClock } from "../contracts/reminders.ts";

export const wallReminderClock: ReminderClock = {
  now: Date.now,
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** Keep one live wake. Timer callbacks only ask the owner to check current eligibility. */
export function createReminderTimer(clock: ReminderClock, wake: () => void) {
  let cancel: (() => void) | undefined;
  let generation = 0;
  let stopped = false;

  function clear() {
    generation++;
    cancel?.();
    cancel = undefined;
  }

  return {
    arm(nextDueAt: string | null) {
      clear();
      if (stopped || nextDueAt === null) return;
      const current = generation;
      const due = Date.parse(nextDueAt);
      const rearm = () => {
        const delay = Math.max(0, Math.min(60_000, due - clock.now()));
        cancel = clock.setTimer(() => {
          if (current !== generation) return;
          cancel = undefined;
          if (clock.now() < due) rearm();
          else wake();
        }, delay);
      };
      rearm();
    },
    stop() { stopped = true; clear(); },
  };
}
