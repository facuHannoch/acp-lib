import { createSession } from "../src/index.ts";
import { expect, test } from "bun:test";
import { createReminderTimer } from "../src/runtime/reminder-timer.ts";
import { normalizeReminderSchedule, resolveAgentReminder } from "../src/util/reminder-schedule.ts";

test("reminder timer chunks long waits and rechecks early, backward and forward wakes", () => {
  let now = 1000, wakeCount = 0;
  let pending: { callback: () => void; delay: number } | undefined;
  const timer = createReminderTimer({
    now: () => now,
    setTimer(callback, delay) {
      expect(pending).toBeUndefined();
      const scheduled = { callback, delay };
      pending = scheduled;
      return () => { if (pending === scheduled) pending = undefined; };
    },
  }, () => { wakeCount++; });
  const fire = () => { const current = pending!; pending = undefined; current.callback(); };
  const due = now + 30 * 86_400_000;
  timer.arm(new Date(due).toISOString());
  expect(pending?.delay).toBe(60_000);
  fire();
  expect(wakeCount).toBe(0);
  now = 0;
  fire();
  expect(wakeCount).toBe(0);
  expect(pending?.delay).toBe(60_000);
  now = due;
  fire();
  expect(wakeCount).toBe(1);
  timer.arm(new Date(due + 1).toISOString());
  const replaced = pending!.callback;
  timer.stop();
  replaced();
  expect(wakeCount).toBe(1);
});

test("offline lead and expiry are derived from the original acceptance anchor", () => {
  const anchor = Date.parse("2026-11-24T12:00:00Z");
  const due = "2026-11-24T12:02:00Z", accepted = "2026-11-24T12:00:00Z";
  expect(normalizeReminderSchedule(due, accepted, undefined, anchor + 600_000)).toEqual({
    schedule: { at: "2026-11-24T12:02:00.000Z" }, acceptedAt: "2026-11-24T12:00:00.000Z",
    expiresAfter: 300_000, expiresAt: "2026-11-24T12:07:00.000Z",
  });
  expect(normalizeReminderSchedule(due, accepted, null, anchor)?.expiresAt).toBeNull();
  expect(normalizeReminderSchedule(due, accepted, undefined, anchor - 30_001)).toBeUndefined();
  expect(normalizeReminderSchedule("2026-11-24T12:01:59Z", accepted, undefined, anchor)).toBeUndefined();
  expect(normalizeReminderSchedule("2026-11-31T12:02:00Z", accepted, undefined, anchor)).toBeUndefined();
  expect(resolveAgentReminder({ in: "2m" }, anchor)).toBe("2026-11-24T12:02:00.000Z");
  expect(resolveAgentReminder({ in: "0m" }, anchor)).toBeUndefined();
});

test("conditional stop refuses runnable work before the scheduler starts", () => {
  const session = createSession({ systemPrompt: "test", configureTurn: () => {
    throw new Error("The scheduler has not started");
  } });
  expect(session.agent.send({ channelId: "alice", participantId: "Rin", text: "Waiting" }).accepted).toBe(true);
  expect(session.reminders!.conditionalStop(0)).toEqual({ stopped: false, reason: "busy" });
  expect(session.status().execution).toBe("working");
  session.stop("test complete");
});
