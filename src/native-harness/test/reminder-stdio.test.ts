import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelEvent } from "../src/contracts/events.ts";
import type { ReminderChange } from "../src/contracts/reminders.ts";
import { spawnHarness } from "./helpers/stdio.ts";

test("stdio: offline reminder fires once during startup and replay returns the frozen receipt", async () => {
  const home = mkdtempSync(join(tmpdir(), "reminder-cold-"));
  const now = Date.parse("2026-11-24T12:00:00.000Z");
  const due = new Date(now + 120_000).toISOString();
  const script = new URL("./fixtures/echo-scenario.jsonl", import.meta.url).pathname;
  const change: ReminderChange = { reminderId: "one", changeId: 1, op: "create", payload: {
    channel: "alice", schedule: { at: due }, text: "Check the result", acceptedAt: new Date(now).toISOString(),
  } };
  try {
    const first = spawnHarness({ home, reminderTime: now });
    try {
      const initialized = await first.client.initialize();
      expect(initialized.description.capabilities.reminders).toBe(true);
      expect(initialized.description.reminderLimits?.minLeadMs).toBe(120_000);
      await first.client.createSession({ sessionId: "s", participants: [], channels: {},
        channelChanges: [{ changeId: "create-alice", channel: "alice" }],
        config: { version: 1, system: "test", model: { protocol: "scripted", script }, defaultPolicy: "allow", policies: { allow: { fallback: "allow", tools: {} } } },
      });
      expect(await first.client.stopIfIdle()).toEqual({ stopped: true });
    } finally { await first.close(); }
    const second = spawnHarness({ home, reminderTime: now + 120_000 });
    try {
      const events: ChannelEvent[] = [];
      second.client.onChannelEvent(event => events.push(event));
      await second.client.initialize();
      const opened = await second.client.openSession({ sessionId: "s", reminderChanges: [change] });
      expect(opened.reminders?.[0]).toMatchObject({ id: "one", state: "done", noticeId: `reminder-notice:one:${due}` });
      expect(opened.reminderChanges?.[0]).toMatchObject({ outcome: "applied", reminder: { state: "active", nextRunAt: due } });
      expect(opened.nextDueAt).toBeNull();
      expect(await second.client.changeReminder(change)).toEqual(opened.reminderChanges![0]!);
      const deadline = performance.now() + 3000;
      while (!events.some(event => event.event.type === "turn_ended") && performance.now() < deadline) await Bun.sleep(5);
      expect(events.filter(event => event.event.type === "reminder_fired")).toHaveLength(1);
      expect(events.filter(event => event.event.type === "turn_ended")).toHaveLength(1);
      const item = await second.client.reconcileChannel({ channel: "alice", itemIds: [`reminder-notice:one:${due}`] });
      expect(item.items).toHaveLength(1);
      expect(item.items[0]?.turnId).toBe("1");
    } finally { await second.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 15000);

for (const point of ["changeReminder", "fireDueReminders"]) {
  test(`stdio: SIGKILL after ${point} preserves exactly one reminder notice on reopen`, async () => {
    const home = mkdtempSync(join(tmpdir(), "reminder-crash-"));
    const now = Date.parse("2026-11-24T12:00:00.000Z"), wakeTime = now + 120_000;
    const at = new Date(wakeTime).toISOString();
    const script = new URL("./fixtures/echo-scenario.jsonl", import.meta.url).pathname;
    const change: ReminderChange = { reminderId: "crash", changeId: 1, op: "create", payload: {
      channel: "alice", schedule: { at }, text: "Crash reminder", acceptedAt: new Date(now).toISOString(),
    } };
    try {
      const first = spawnHarness({ home, reminderTime: now });
      try {
        await first.client.initialize();
        await first.client.createSession({ sessionId: "s", participants: [], channels: {},
          channelChanges: [{ channel: "alice", changeId: "create" }],
          config: { version: 1, system: "test", model: { protocol: "scripted", script }, defaultPolicy: "allow", policies: { allow: { fallback: "allow", tools: {} } } },
        });
      } finally { await first.close(); }
      const crashed = spawnHarness({ home, reminderTime: wakeTime, fault: `${point}:1` });
      try {
        await crashed.client.initialize();
        await expect(crashed.client.openSession({ sessionId: "s", reminderChanges: [change] })).rejects.toMatchObject({ code: "transport_closed" });
        expect(await crashed.child.exited).toBe(137);
      } finally { crashed.client.close(); crashed.child.kill(); await crashed.child.exited; }
      const recovered = spawnHarness({ home, reminderTime: wakeTime });
      try {
        await recovered.client.initialize();
        const opened = await recovered.client.openSession({ sessionId: "s", reminderChanges: [change] });
        const id = `reminder-notice:crash:${at}`;
        expect(opened.reminders?.[0]).toMatchObject({ state: "done", noticeId: id });
        expect(opened.reminderChanges?.[0]).toMatchObject({ outcome: "applied", reminder: { state: "active" } });
        const read = await recovered.client.reconcileChannel({ channel: "alice", itemIds: [id] });
        expect(read.items.map(item => item.id)).toEqual([id]);
      } finally { await recovered.close(); }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 15000);
}

test("stdio: checked reminder tool schedules for its own channel and fences idle stop", async () => {
  const home = mkdtempSync(join(tmpdir(), "reminder-tool-"));
  const now = Date.parse("2026-11-24T12:00:00.000Z");
  const script = join(home, "reminder.jsonl");
  const records = [
    { type: "scenario", version: 1, name: "reminder-tool" },
    { type: "model", content: null, calls: [
      { id: "invalid", name: "schedule_reminder", arguments: { schedule: { in: "5m" }, text: "wrong", channel: "other" } },
      { id: "schedule", name: "schedule_reminder", arguments: { schedule: { in: "5m" }, text: "Check the result" } },
    ] },
    { type: "model", content: "Scheduled." },
    { type: "model", content: "Checked." },
  ];
  try {
    await Bun.write(script, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const first = spawnHarness({ home, reminderTime: now });
    try {
      const events: ChannelEvent[] = [];
      first.client.onChannelEvent(event => events.push(event));
      await first.client.initialize({ protocolVersion: 1, host: { name: "test", version: "0" }, callbacks: [],
        approval: true, subscription: { text: "final", tools: "full" } });
      await first.client.createSession({ sessionId: "s", participants: [], channels: {},
        config: { version: 1, system: "test", model: { protocol: "scripted", script }, defaultPolicy: "ask",
          policies: { ask: { fallback: "ask", tools: {} } } } });
      await first.client.push({ channel: "alice", item: { id: "seed", kind: "user_message", sender: "Rin",
        content: [{ type: "text", text: "Remind me" }] } });
      const findApproval = () => events.map(event => event.event).find(event => event.type === "approval_requested");
      const deadline = performance.now() + 3000;
      while (!findApproval() && performance.now() < deadline) await Bun.sleep(5);
      const approval = findApproval();
      if (!approval || approval.type !== "approval_requested") throw new Error("Expected schedule approval");
      expect(approval.toolCallId).toBe("schedule");
      expect(await first.client.stopIfIdle()).toEqual({ stopped: false, reason: "busy" });
      await first.client.respondApproval(approval.requestId, "allow_once");
      while (!events.some(event => event.event.type === "turn_ended") && performance.now() < deadline) await Bun.sleep(5);
      expect(events.filter(event => event.event.type === "approval_requested")).toHaveLength(1);
      expect(events.filter(event => event.event.type === "tool_call" && event.event.status === "started")).toHaveLength(1);
      expect((await first.client.listReminders()).reminders).toMatchObject([{ text: "Check the result", channel: "alice",
        createdBy: "agent", creatorId: "Rin", policyNames: ["ask"], state: "active" }]);
      expect(await first.client.stopIfIdle({ ifIdle: true, unlessDueWithinMs: 300_000 })).toEqual({ stopped: false, reason: "next_due_soon" });
      expect(await first.client.stopIfIdle({ ifIdle: true, unlessDueWithinMs: 299_999 })).toEqual({ stopped: true });
    } finally { await first.close(); }
    const second = spawnHarness({ home, reminderTime: now + 300_000 });
    try {
      await second.client.initialize();
      const opened = await second.client.openSession({ sessionId: "s" });
      expect(opened.reminders?.[0]).toMatchObject({ state: "done" });
      const notice = opened.reminders?.[0]?.noticeId;
      expect(notice).toBeDefined();
      expect((await second.client.reconcileChannel({ channel: "alice", itemIds: [notice!] })).items).toHaveLength(1);
    } finally { await second.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 15000);
