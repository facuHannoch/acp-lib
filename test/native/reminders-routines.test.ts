import { expect, test } from "bun:test";
import { createAgentConversationId, createAgentSessionId } from "../../src/agent-ids.ts";
import { ReminderService } from "../../src/native/reminders/service.ts";
import { normalizeReminderSchedule } from "../../src/native/reminders/schedule.ts";
import { fromWireReminder, reminderRequest } from "../../src/native/reminders/wire.ts";
import { SqliteAgentPersistence } from "../../src/persistence/sqlite-backend.ts";

const anchor = 1_000_000;
const iso = (value: number) => new Date(value).toISOString();

test("routine normalization checks the shared minimum, exclusive bounds and numeric cron grammar", () => {
  for (const schedule of [
    { every: 599_999 }, { every: 600_000, startAt: anchor + 599_999 },
    { every: 600_000, count: 1, until: anchor + 600_000 },
    { every: 600_000, count: 0 }, { every: 600_000, count: Number.MAX_SAFE_INTEGER + 1 },
    { every: 600_000, until: Number.NaN }, { every: 600_000, until: anchor + 599_999 },
    { cron: "@daily", timezone: "UTC" }, { cron: "0 0 * * MON", timezone: "UTC" },
    { cron: "0 0 * * * *", timezone: "UTC" }, { cron: "0/10 * * * *", timezone: "UTC" },
    { cron: "*/0 * * * *", timezone: "UTC" }, { cron: "0 0 * * 7", timezone: "UTC" },
  ]) expect(() => normalizeReminderSchedule(schedule as Parameters<typeof normalizeReminderSchedule>[0], anchor))
    .toThrow(expect.objectContaining({ code: "invalid_schedule" }));
  expect(normalizeReminderSchedule({ every: 600_000, until: anchor + 600_000 }, anchor))
    .toEqual({ every: 600_000, startAt: anchor + 600_000, until: anchor + 600_000 });
  expect(normalizeReminderSchedule({ cron: "0,20-40/10 0-23 * * 0,6", timezone: "Peer/Validates", count: 2 }, anchor))
    .toEqual({ cron: "0,20-40/10 0-23 * * 0,6", timezone: "Peer/Validates", count: 2 });
});

test("routine encoding freezes replacement anchors and uses sparse non-schedule edits", async () => {
  const agentSessionId = createAgentSessionId();
  const channel = createAgentConversationId();
  const persistence = await SqliteAgentPersistence.open({ path: ":memory:", agentSessionId });
  try {
    await persistence.conversations.create({ agentSessionId, agentConversationId: channel, controllerKind: "native" });
    let now = anchor;
    const service = new ReminderService({ persistence, now: () => now, routineUnavailable: () => undefined });
    const reminders = service.conversation(channel, true, () => {});
    const created = await reminders.create({ text: "routine", schedule: { every: 600_000, count: 3 } });
    const change = () => persistence.reminders.list().then(rows => rows[0]!.changes.at(-1)!);
    expect(created.expiry).toEqual({ kind: "harness_default" });
    expect(reminderRequest(await change()).payload).toEqual({
      channel, text: "routine", acceptedAt: iso(anchor), schedule: { every: 600_000, startAt: iso(anchor + 600_000), count: 3 },
      missedRuns: "coalesce", overlap: "skip",
    });
    await persistence.reminders.markMaybeSent(created.id, 1);
    await reminders.update(created.id, { missedRuns: "each", overlap: "queue", expiresAfter: null });
    expect(reminderRequest(await change()).payload).toEqual({ missedRuns: "each", overlap: "queue", expiresAfter: null });
    await persistence.reminders.markMaybeSent(created.id, 2);
    now += 1000;
    const replacement = now;
    await reminders.update(created.id, { schedule: { every: 900_000, count: 2 } });
    now += 1000;
    await reminders.update(created.id, { text: "edited" });
    expect(reminderRequest(await change()).payload).toEqual({
      text: "edited", acceptedAt: iso(replacement), schedule: { every: 900_000, startAt: iso(replacement + 900_000), count: 2 },
    });
    await expect(reminders.update(created.id, { schedule: { cron: "0 * * * *", timezone: "UTC" } }))
      .rejects.toMatchObject({ code: "invalid_schedule" });
  } finally { await persistence.close(); }
});

test("routine rows decode canonical schedule, migration, count and next-occurrence grace", () => {
  const row = {
    id: "routine", channel: "c", createdBy: "host", policyNames: [], text: "row", state: "active",
    acceptedAt: iso(anchor), nextRunAt: iso(anchor + 600_000),
    schedule: { cron: "0 * * * *", timezone: "Etc/UTC", count: 4 },
    timezoneVersion: "2026a", remainingCount: 2, missedRuns: "each", overlap: "queue",
    expiresAfter: 600_000, expiresAt: iso(anchor + 1_200_000),
  } as const;
  expect(fromWireReminder({ ...row, policyNames: [] })).toMatchObject({
    schedule: row.schedule, missedRuns: "each", overlap: "queue", timezoneVersion: "2026a",
    remainingCount: 2, expiry: { at: anchor + 1_200_000, graceMs: 600_000 },
  });
  expect(fromWireReminder({ ...row, policyNames: [], state: "done", nextRunAt: null, expiresAfter: null, expiresAt: null }))
    .toMatchObject({ status: "completed", nextRunAt: null, expiry: null });
  const migration = { fromVersion: "2026a", targetVersion: "2026b", cause: "proof_budget" } as const;
  expect(fromWireReminder({ ...row, policyNames: [], state: "blocked", blockedReason: "invalid_schedule", timezoneMigration: migration }))
    .toMatchObject({ timezoneMigration: migration });
  expect(fromWireReminder({ ...row, policyNames: [], schedule: { every: 600_000, startAt: iso(anchor + 600_000), until: iso(anchor + 900_000) } }))
    .toMatchObject({ schedule: { every: 600_000, startAt: anchor + 600_000, until: anchor + 900_000 } });
});
