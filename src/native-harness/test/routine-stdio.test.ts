import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChannelEvent, ReminderChange } from "../src/client.ts";
import { spawnHarness } from "./helpers/stdio.ts";

const minutes = 60_000;
const anchor = Date.parse("2026-11-24T12:00:00Z");
const stamp = (instant: number) => new Date(instant).toISOString();

for (const outcome of ["fire", "expire", "crash"] as const) test(`stdio: counted routines ${outcome} across SQLite reopen`, async () => {
  const home = mkdtempSync(join(tmpdir(), "routine-stdio-"));
  const script = join(home, "routine.jsonl");
  writeFileSync(script, [{ type: "scenario", version: 1, name: "routine" },
    { type: "model", content: "first" }, { type: "model", content: "second" }].map(row => JSON.stringify(row)).join("\n") + "\n");
  const change: ReminderChange = { op: "create", reminderId: "routine", changeId: 1, payload: {
    channel: "a", text: "check", acceptedAt: stamp(anchor), schedule: { every: 10 * minutes, count: 2 },
  } };
  try {
    const initial = spawnHarness({ home, reminderTime: anchor });
    try {
      await initial.client.initialize();
      const opened = await initial.client.createSession({ sessionId: "s", participants: [], channels: {},
        channelChanges: [{ channel: "a", changeId: "create" }], reminderChanges: [change],
        config: { version: 1, system: "routine", model: { protocol: "scripted", script },
          limits: { unattendedTurns: 3 }, defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } } },
      });
      expect(opened.reminders?.[0]).toMatchObject({ remainingCount: 2, nextRunAt: stamp(anchor + 10 * minutes) });
    } finally { await initial.close(); }
    const offsets = outcome !== "expire" ? [10, 20] : [60];
    if (outcome === "crash") {
      const crashed = spawnHarness({ home, reminderTime: anchor + 10 * minutes, fault: "fireDueReminders:1" });
      try {
        await crashed.client.initialize();
        await expect(crashed.client.openSession({ sessionId: "s" })).rejects.toMatchObject({ code: "transport_closed" });
        expect(await crashed.child.exited).toBe(137);
      } finally { crashed.client.close(); crashed.child.kill(); await crashed.child.exited; }
    }
    for (const offset of offsets) {
      const events: ChannelEvent[] = [];
      const child = spawnHarness({ home, reminderTime: anchor + offset * minutes });
      child.client.onChannelEvent(event => events.push(event));
      try {
        await child.client.initialize();
        const opened = await child.client.openSession({ sessionId: "s", reminderChanges: [change] });
        expect(opened.reminderChanges?.[0]).toMatchObject({ outcome: "applied", reminder: { remainingCount: 2 } });
        const deadline = performance.now() + 2000;
        const done = () => events.some(({ event }) => event.type === (outcome !== "expire" ? "turn_ended" : "routine_disposition"));
        while (!done() && performance.now() < deadline) await Bun.sleep(5);
        expect(done()).toBe(true);
        if (outcome !== "expire") {
          const fired = events.flatMap(({ event }) => event.type === "reminder_fired" ? [event] : []);
          const noticeId = `reminder-notice:routine:${stamp(anchor + offset * minutes)}`;
          expect(fired.map(event => event.noticeId)).toEqual(outcome === "crash" && offset === 10 ? [] : [noticeId]);
          expect((await child.client.reconcileChannel({ channel: "a", itemIds: [noticeId] })).items).toHaveLength(1);
        } else {
          expect(events.filter(({ event }) => event.type === "reminder_expired")).toEqual([]);
          expect(events.filter(({ event }) => event.type === "routine_disposition").map(({ event }) => event)).toEqual([{
            type: "routine_disposition", reminderId: "routine", reason: "expired", count: 2,
            firstScheduledAt: stamp(anchor + 10 * minutes), lastScheduledAt: stamp(anchor + 20 * minutes),
          }]);
        }
        const row = (await child.client.getReminder({ id: "routine" })).reminder;
        expect(row).toMatchObject(offset === 10
          ? { state: "active", remainingCount: 1, nextRunAt: stamp(anchor + 20 * minutes) }
          : { state: "done", remainingCount: 0, nextRunAt: null });
      } finally { await child.close(); }
    }
  } finally { rmSync(home, { force: true, recursive: true }); }
}, 15000);

test("startup pause fences due work and live pause preserves a notice already committed", async () => {
  const home = mkdtempSync(join(tmpdir(), "routine-pause-"));
  const script = join(home, "routine.jsonl");
  writeFileSync(script, [{ type: "scenario", version: 1, name: "routine" },
    { type: "model", content: "awake" }].map(row => JSON.stringify(row)).join("\n") + "\n");
  const create = (reminderId: string): ReminderChange => ({ op: "create", reminderId, changeId: 1, payload: {
    channel: "a", text: "check", acceptedAt: stamp(anchor), schedule: { every: 10 * minutes, count: 2 },
  } });
  try {
    const child = spawnHarness({ home, reminderTime: anchor });
    try {
      await child.client.initialize();
      await child.client.createSession({ sessionId: "s", participants: [], channels: {},
        channelChanges: [{ channel: "a", changeId: "create" }], reminderChanges: [create("held")],
        config: { version: 1, system: "routine", model: { protocol: "scripted", script },
          limits: { unattendedTurns: 3 }, defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } } },
      });
    } finally { await child.close(); }
    const due = anchor + 10 * minutes;
    const child2 = spawnHarness({ home, reminderTime: due });
    try {
      const fired: string[] = [];
      child2.client.onChannelEvent(({ event }) => { if (event.type === "reminder_fired") fired.push(event.reminderId); });
      await child2.client.initialize();
      const opened = await child2.client.openSession({ sessionId: "s", reminderChanges: [
        { op: "update", reminderId: "held", changeId: 2, payload: { state: "paused" } },
      ] });
      expect(opened.reminders?.[0]).toMatchObject({ state: "paused", remainingCount: 2, nextRunAt: null });
      await child2.client.changeReminder(create("live"));
      const deadline = performance.now() + 2000;
      while (!fired.length && performance.now() < deadline) await Bun.sleep(5);
      expect(fired).toEqual(["live"]);
      await child2.client.changeReminder({ op: "update", reminderId: "live", changeId: 2, payload: { state: "paused" } });
      const row = (await child2.client.getReminder({ id: "live" })).reminder;
      expect(row).toMatchObject({ state: "paused", remainingCount: 1, noticeId: `reminder-notice:live:${stamp(due)}` });
      const linked = await child2.client.reconcileChannel({ channel: "a", itemIds: [row.noticeId!] });
      expect(linked.items).toHaveLength(1);
    } finally { await child2.close(); }
  } finally { rmSync(home, { force: true, recursive: true }); }
}, 15000);
