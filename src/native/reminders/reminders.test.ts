import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createMemoryReminderPersistence } from "../../persistence/reminders.ts";
import { createSqliteReminderPersistence } from "../../persistence/sqlite-reminders.ts";
import { migrateSqliteAgentSchema } from "../../persistence/sqlite-schema.ts";
import { normalizeReminderSchedule, resolveReminderExpiry } from "./schedule.ts";
import { ReminderService, reminderRequest } from "./service.ts";

function setup() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  migrateSqliteAgentSchema(database);
  const run = async <T>(work: () => T) => work();
  const repository = createSqliteReminderPersistence(database, run, run);
  let now = 1_000_000;
  const service = new ReminderService({ repository, now: () => now });
  const channel = service.conversation("channel", true, () => {});
  return { database, repository, channel, advance: () => { now += 10_000; } };
}

test("exact lead survives a possibly sent create and retry", async () => {
  const { database, repository, channel, advance } = setup();
  try {
    const item = await channel.create({ text: "deploy", schedule: { in: 120_000 } });
    const first = (await repository.markMaybeSent(item.id, 1))!;
    expect(first.acceptedAt).toBe(1_000_000);
    expect(await repository.wake()).toEqual({ reported: null, effectiveAt: 1_120_000 });
    advance();
    await channel.update(item.id, { text: "check deploy" });
    const replay = (await repository.markMaybeSent(item.id, 1))!;
    expect(JSON.stringify(reminderRequest(replay))).toBe(JSON.stringify(reminderRequest(first)));
    const second = (await repository.markMaybeSent(item.id, 2))!;
    expect(second.op).toBe("update");
    await repository.acknowledge(item.id, 1, { confirmed: first.reminder });
    expect((await repository.list())[0]?.changes.map(({ state }) => state)).toEqual(["applied", "maybe_sent"]);
    await repository.acknowledge(item.id, 2, { confirmed: second.reminder });
    expect((await repository.list())[0]?.changes).toEqual([]);
    await channel.pause(item.id);
    expect((await repository.list())[0]?.changes[0]?.changeId).toBe(3);
  } finally {
    database.close();
  }
});

test("suspension removes local validation wakes and resuming restores them", async () => {
  const { database, repository, channel } = setup();
  try {
    const item = await channel.create({ text: "cron", schedule: { cron: "0 * * * *", timezone: "UTC" } });
    const [row] = await repository.list();
    expect(item.expiry).toEqual({ kind: "harness_default" });
    expect(reminderRequest(row!.changes[0]!).payload).not.toHaveProperty("expiresAfter");
    await repository.setConversationSuspended("channel", true);
    expect((await repository.wake()).effectiveAt).toBeNull();
    await repository.setConversationSuspended("channel", false);
    expect((await repository.wake()).effectiveAt).toBe(1_120_000);
    await repository.deleteConversation("channel");
    expect((await repository.wake()).effectiveAt).toBeNull();
    expect(await channel.list()).toEqual([]);
  } finally {
    database.close();
  }
});

test("only a new session replaces the deadline fence", async () => {
  const { database, repository } = setup();
  try {
    const deadline = { sessionId: "one", revision: 10, nextDueAt: 42 };
    expect(await repository.updateDeadline(deadline)).toBe("accepted");
    expect(await repository.updateDeadline({ ...deadline, revision: 9 })).toBe("stale");
    expect(await repository.updateDeadline({ ...deadline, nextDueAt: 43 })).toBe("mismatch");
    expect((await repository.wake()).effectiveAt).toBe(42);
    const replacement = { sessionId: "two", revision: 1, nextDueAt: null };
    expect(await repository.updateDeadline(replacement)).toBe("stale");
    expect(await repository.updateDeadline(replacement, true)).toBe("accepted");
    expect(await repository.updateDeadline(deadline)).toBe("stale");
    expect((await repository.wake()).effectiveAt).toBeNull();
  } finally {
    database.close();
  }
});

test("SQLite upgrades schema 21 in place", () => {
  using database = new Database(":memory:");
  migrateSqliteAgentSchema(database);
  for (const table of ["reminder_changes", "reminder_cache", "reminder_journals", "reminder_suspensions", "reminder_wake_index"]) {
    database.exec("DROP TABLE " + table);
  }
  database.exec("UPDATE schema_migrations SET version = 21, applied_at = 'baseline'");
  migrateSqliteAgentSchema(database);
  expect(database.query("SELECT version, applied_at FROM schema_migrations WHERE version = 21").get())
    .toEqual({ version: 21, applied_at: "baseline" });
  expect(database.query("SELECT * FROM schema_migrations WHERE version = 22").get()).not.toBeNull();
  expect(database.query("SELECT * FROM reminder_changes").all()).toEqual([]);
});

test("lead, repeat and grace boundaries", () => {
  expect(() => normalizeReminderSchedule({ in: 119_999 }, 0)).toThrow();
  expect(normalizeReminderSchedule({ in: 120_000 }, 0)).toEqual({ at: 120_000 });
  expect(() => normalizeReminderSchedule({ every: 599_999 }, 0)).toThrow();
  expect(normalizeReminderSchedule({ every: 600_000 }, 0)).toEqual({ every: 600_000, startAt: 600_000 });
  expect(resolveReminderExpiry({ at: 120_000 }, { kind: "default" }, 0)).toEqual({
    kind: "absolute", at: 420_000, graceMs: 300_000,
  });
  expect(resolveReminderExpiry({ at: 86_400_000 }, { kind: "default" }, 0)).toEqual({
    kind: "absolute", at: 172_800_000, graceMs: 86_400_000,
  });
});

test("memory allows live confirmation and rejects offline create", async () => {
  const repository = createMemoryReminderPersistence();
  let running = false;
  const service = new ReminderService({
    repository, running: () => running, now: () => 0,
    live: async () => ({ confirmed: (await repository.list())[0]!.changes[0]!.reminder }),
  });
  const channel = service.conversation("channel", true, () => {});
  const input = { text: "check", schedule: { in: 120_000 } };
  await expect(channel.create(input)).rejects.toMatchObject({ code: "reminders_unavailable" });
  running = true;
  expect((await channel.create(input)).state).toBe("confirmed");
});

test("deleting a conversation with a reminders-only backend removes its wake in the transaction", async () => {
  const { database, repository, channel } = setup();
  try {
    const { deleteConversationWithChannel } = await import("../../agent/native-channel-lifecycle.ts");
    await channel.create({ text: "deploy", schedule: { in: 120_000 } });
    let transaction = false;
    let deleted = false;
    const scope = {
      reminders: repository,
      conversations: {
        get: async () => ({ controllerKind: "native" }),
        delete: async () => {
          expect(transaction).toBe(true);
          expect((await repository.wake()).effectiveAt).toBeNull();
          deleted = true;
        },
      },
    };
    const persistence = {
      ...scope,
      capabilities: { channels: false, reminders: true },
      transaction: async (work: (scoped: typeof scope) => Promise<unknown>) => {
        transaction = true;
        return work(scope);
      },
    };
    await deleteConversationWithChannel(
      { persistence, nativeHarness: null } as never,
      "channel" as never,
      { providerSession: "keep" } as never,
    );
    expect(deleted).toBe(true);
    expect(await repository.list()).toEqual([]);
  } finally {
    database.close();
  }
});

test("never-sent edits coalesce and a cancelled create never reuses a version", async () => {
  const { database, repository, channel } = setup();
  try {
    const item = await channel.create({ text: "first", schedule: { in: 120_000 } });
    await channel.update(item.id, { text: "second" });
    expect((await repository.list())[0]?.changes.map(({ op, changeId }) => [op, changeId])).toEqual([["create", 2]]);
    await channel.cancel(item.id);
    expect(await channel.list()).toEqual([]);
    expect((await repository.list())[0]?.highWater).toBe(3);
    expect((await repository.wake()).effectiveAt).toBeNull();
  } finally {
    database.close();
  }
});

test("schedule edits preserve expiry policy and resume preserves an overdue schedule", async () => {
  const { database, channel, advance } = setup();
  try {
    const item = await channel.create({ text: "check", schedule: { in: 120_000 }, expiresAfter: 60_000 });
    const moved = await channel.update(item.id, { schedule: { in: 130_000 } });
    expect(moved.expiry).toEqual({ kind: "absolute", at: 1_190_000, graceMs: 60_000 });
    for (let step = 0; step < 15; step++) advance();
    await channel.pause(item.id);
    const resumed = await channel.resume(item.id);
    expect(resumed.schedule).toEqual(moved.schedule);
    expect(resumed.expiry).toEqual(moved.expiry);
  } finally {
    database.close();
  }
});

test("blocked entries stay visible and correcting or discarding them preserves the clock", async () => {
  const { database, repository, channel } = setup();
  try {
    const item = await channel.create({ text: "check", schedule: { in: 120_000 } });
    await repository.markMaybeSent(item.id, 1);
    await repository.acknowledge(item.id, 1, { reason: "invalid_policy" });
    expect(await channel.get(item.id)).toMatchObject({ state: "blocked", reason: "invalid_policy" });
    expect((await repository.wake()).effectiveAt).toBeNull();
    await channel.update(item.id, { text: "corrected" });
    expect((await repository.list())[0]?.changes.map(({ state, changeId }) => [state, changeId]))
      .toEqual([["blocked", 1], ["pending", 2]]);
    await channel.discardBlocked(item.id);
    expect((await repository.list())[0]?.highWater).toBe(2);
    expect(await channel.get(item.id)).toMatchObject({ state: "pending", text: "corrected" });
  } finally {
    database.close();
  }
});

test("the cap and authorization are checked before journaling", async () => {
  const { database, repository } = setup();
  try {
    const service = new ReminderService({
      repository,
      now: () => 0,
      authorize: (id) => id !== "denied",
    });
    const input = { text: "check", schedule: { in: 120_000 } };
    await expect(service.conversation("denied", true, () => {}).create(input))
      .rejects.toMatchObject({ code: "unauthorized" });
    await expect(service.conversation("acp", false, () => {}).create(input))
      .rejects.toMatchObject({ code: "reminders_unsupported" });
    const channel = service.conversation("channel", true, () => {});
    for (let i = 0; i < 20; i++) await channel.create(input);
    await expect(channel.create(input)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(await repository.list()).toHaveLength(20);
    const first = await service.list({ limit: 13 });
    const second = await service.list({ after: first.nextCursor!, limit: 13 });
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(20);
    expect(second.nextCursor).toBeNull();
  } finally {
    database.close();
  }
});
