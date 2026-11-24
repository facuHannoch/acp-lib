import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageResult } from "../src/contracts/storage.ts";
import type { ReminderChange } from "../src/client.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";

function take<T>(result: StorageResult<T>) {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const identity = { sessionId: "s", compatibilityKey: "test" };
const now = Date.parse("2026-10-31T12:00:00.000Z");
const config = { version: 1 as const, system: "test", model: { protocol: "scripted" as const, script: "test" },
  defaultPolicy: "allow", policies: { allow: { fallback: "allow" as const, tools: {} } }, limits: { unattendedTurns: 2 } };

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: archived calendars retain identities and migrate old timezone data`, () => {
  const home = mkdtempSync(join(tmpdir(), "routine-archive-"));
  const adapter = (file: string) => kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(home, file));
  const source = adapter("source");
  const store = take(source.open({ mode: "create", identity, config }));
  try {
    take(store.createChannel({ channelId: "alice" }));
    const input: ReminderChange = { op: "create", reminderId: "fold", changeId: 1, payload: {
      channel: "alice", text: "test", acceptedAt: new Date(now).toISOString(),
      schedule: { cron: "30 1 * * *", timezone: "US/Eastern", count: 2 },
    } };
    const result = take(store.changeReminder(input, now));
    expect(result).toMatchObject({ outcome: "applied", reminder: { schedule: { timezone: "America/New_York" },
      nextRunAt: "2026-11-01T05:30:00.000Z", remainingCount: 2 } });
    const invalid = take(store.changeReminder({ op: "update", reminderId: "fold", changeId: 2, payload: {
      schedule: { at: "2026-11-02T12:00:00.000Z" }, acceptedAt: new Date(now).toISOString(),
    } }, now));
    expect(invalid).toMatchObject({ outcome: "blocked", reason: "invalid_schedule" });
    expect(take(store.changeReminder({ op: "update", reminderId: "fold", changeId: 3, payload: {
      schedule: { every: 600_000 }, acceptedAt: new Date(now).toISOString(),
    } }, now))).toMatchObject({ outcome: "blocked", reason: "invalid_schedule" });
    expect(take(store.changeReminder({ ...input, reminderId: "one", payload: { ...input.payload, overlap: "queue",
      schedule: { at: "2026-11-02T12:00:00.000Z" } } }, now))).toMatchObject({ outcome: "blocked", reason: "invalid_schedule" });

    const archive = take(store.exportArchive());
    const row = archive.reminderState!.rows[0]!.reminder;
    expect(row.timezoneVersion).toMatch(/^\d{4}[a-z]+$/);
    const old = structuredClone(archive);
    old.reminderState!.rows[0]!.reminder.timezoneVersion = "2025a";
    const blockedCopy = adapter("blocked");
    let clockReads = 0;
    const proofClock = spyOn(performance, "now").mockImplementation(() => ++clockReads < 30 ? 0 : 250);
    try { take(blockedCopy.importArchive(old)); } finally { proofClock.mockRestore(); }
    const blocked = take(blockedCopy.open({ mode: "open", identity, config }));
    try {
      expect(take(blocked.readReminder("fold"))).toMatchObject({ state: "blocked", remainingCount: 2, nextRunAt: null,
        timezoneVersion: "2025a", timezoneMigration: { cause: "proof_budget", targetVersion: row.timezoneVersion } });
      expect(take(blocked.reminderWake()).nextDueAt).toBeNull();
      expect(take(blocked.fireDueReminders(now))).toEqual([]);
      expect(take(blocked.exportArchive()).reminderState?.dispositions).toHaveLength(1);
    } finally { blocked.close(); }
    const copy = adapter("copy");
    take(copy.importArchive(old));
    const reopened = take(copy.open({ mode: "open", identity, config }));
    try {
      expect(take(reopened.readReminder("fold"))?.timezoneVersion).toBe(row.timezoneVersion);
      const due = Date.parse("2026-11-01T05:30:00.000Z");
      const events = take(reopened.fireDueReminders(due));
      expect(events.find(({ event }) => event.type === "reminder_fired")?.event).toMatchObject({
        noticeId: "reminder-notice:fold:2026-11-01T05:30:00.000Z",
      });
      expect(take(reopened.readReminder("fold"))).toMatchObject({ nextRunAt: "2026-11-02T06:30:00.000Z", remainingCount: 1 });
      expect(take(reopened.fireDueReminders(due + 3600_000))).toEqual([]);
    } finally { reopened.close(); }
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

test("exhausted channel contributes no wake while another channel fires; participant reset restores elapsed work", () => {
  const adapter = createMemoryStorageAdapter();
  const options = { identity, config: { ...config, limits: { unattendedTurns: 1 } } };
  let session = take(adapter.open({ ...options, mode: "create" }));
  take(session.createChannel({ channelId: "a" }));
  take(session.createChannel({ channelId: "b" }));
  for (const [channel, offset] of [["a", 600_000], ["b", 1_200_000]] as const) {
    const change: ReminderChange = { op: "create", reminderId: channel, changeId: 1, payload: { channel, text: channel,
      acceptedAt: new Date(now).toISOString(), schedule: { every: offset, count: 1 }, expiresAfter: null } };
    expect(take(session.changeReminder(change, now)).outcome).toBe("applied");
  }
  take(session.acceptItem({ kind: "external_notice", channelId: "a", senderId: "host", inheritedPolicyNames: [], itemId: "spend", text: "spent" }));
  const charged = take(session.beginTurn("a"))!;
  take(session.finishTurn(charged.turn.turnId, { status: "interrupted", reason: "test" }));
  take(session.close());
  session = take(adapter.open({ ...options, mode: "open" }));
  try {
    expect(take(session.reminderWake()).nextDueAt).toBe(new Date(now + 1_200_000).toISOString());
    expect(take(session.fireDueReminders(now + 1_200_000)).filter(({ event }) => event.type === "reminder_fired")).toMatchObject([{ channel: "b" }]);
    expect(take(session.reminderWake()).nextDueAt).toBeNull();
    take(session.acceptItem({ kind: "participant_message", channelId: "a", senderId: "person", itemId: "reset", text: "reset" }));
    expect(take(session.reminderWake()).nextDueAt).toBe(new Date(now + 600_000).toISOString());
    const reset = take(session.beginTurn("a"))!;
    expect(take(session.fireDueReminders(now + 1_200_000)).filter(({ event }) => event.type === "reminder_fired")).toMatchObject([{
      channel: "a", event: { noticeId: `reminder-notice:a:${new Date(now + 600_000).toISOString()}` },
    }]);
    expect(reset.items.map(item => item.itemId)).toEqual(["reset"]);
  } finally { session.close(); }
});

test("an existing receipt conflict does not activate routine format", () => {
  const adapter = createMemoryStorageAdapter();
  const store = take(adapter.open({ mode: "create", identity }));
  try {
    take(store.createChannel({ channelId: "a" }));
    const payload = { channel: "a", text: "one-off", acceptedAt: new Date(now).toISOString() };
    const one = { op: "create", reminderId: "r", changeId: 1 } as const;
    take(store.changeReminder({ ...one, payload: { ...payload, schedule: { at: new Date(now + 600_000).toISOString() } } }, now));
    expect(take(store.readSession()).formatVersion).toBe(7);
    expect(take(store.changeReminder({ ...one, payload: { ...payload, schedule: { every: 600_000 } } }, now)))
      .toMatchObject({ outcome: "blocked", reason: "conflict" });
    expect(take(store.readSession()).formatVersion).toBe(7);
  } finally { store.close(); }
});
