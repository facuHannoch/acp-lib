import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentConversationId, createAgentSessionId, type AgentConversationId, type AgentSessionId } from "../../agent-ids.ts";
import { Agent } from "../../agent.ts";
import { AgentConversation } from "../../agent-conversation.ts";
import { protectPendingRetirement } from "../../agent/native-channel-lifecycle.ts";
import { SqliteAgentPersistence } from "../../persistence/sqlite-backend.ts";
import { deriveReminderWake } from "../../persistence/reminder-wake.ts";
import { nativeRig } from "../../../test/native/support.ts";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createMemoryReminderPersistence } from "../../persistence/reminders.ts";
import { createSqliteReminderPersistence } from "../../persistence/sqlite-reminders.ts";
import { migrateSqliteAgentSchema } from "../../persistence/sqlite-schema.ts";
import { normalizeReminderSchedule, reminderExpiryPolicy, resolveReminderExpiry } from "./schedule.ts";
import { ReminderService, reminderRequest, type ReminderEvent } from "./service.ts";

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

test("SQLite upgrades a populated schema 21 database in place", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reminder-v21-"));
  const path = join(directory, "agent.sqlite");
  const agentSessionId = "ags-7f45e629-3a70-4668-93c6-4e88e922c1dd" as AgentSessionId;
  const id = "agc-8a7f0a36-5972-4bb1-b64b-9751a490b61b" as AgentConversationId;
  try {
    // This file was created and populated using the backend from f0eb7d8.
    const fixture = Bun.file(new URL("./fixtures/schema21.sqlite.gz", import.meta.url));
    await Bun.write(path, Bun.gunzipSync(new Uint8Array(await fixture.arrayBuffer())));
    {
      using database = new Database(path);
      expect(database.query("SELECT version FROM schema_migrations").all()).toEqual([{ version: 21 }]);
      expect(database.query("SELECT name FROM sqlite_master WHERE name = 'reminder_changes'").get()).toBeNull();
    }
    const backend = await SqliteAgentPersistence.open({ path, agentSessionId });
    try {
      expect(await backend.conversations.get(id)).toMatchObject({ title: "Existing schema 21 conversation", controllerKind: "native" });
      expect(await backend.reminders.list()).toEqual([]);
      using database = new Database(path);
      expect(database.query("SELECT version FROM schema_migrations ORDER BY version").all())
        .toEqual([{ version: 21 }, { version: 22 }]);
    } finally {
      await backend.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("a maybe-sent change still contributes after recomputing the wake", async () => {
  const { database, repository, channel } = setup();
  try {
    const item = await channel.create({ text: "check", schedule: { in: 180_000 } });
    await repository.markMaybeSent(item.id, 1);
    await repository.updateDeadline({ sessionId: "one", revision: 1, nextDueAt: null });
    expect((await repository.wake()).effectiveAt).toBe(1_120_000);
  } finally {
    database.close();
  }
});

test("a paused change has no validation wake and resume restores it", async () => {
  const { database, repository, channel } = setup();
  try {
    const item = await channel.create({ text: "check", schedule: { in: 180_000 } });
    await channel.pause(item.id);
    expect((await repository.wake()).effectiveAt).toBeNull();
    await channel.resume(item.id);
    expect((await repository.wake()).effectiveAt).toBe(1_120_000);
  } finally {
    database.close();
  }
});

test("validation wakes use the earlier of launch deadline and due time", () => {
  const change = {
    op: "update", state: "pending", acceptedAt: 200_000,
    paused: false, suspended: false, retiring: false,
  } as const;
  expect(deriveReminderWake(null, [{ ...change, dueAt: 210_000 }], 120_000)).toBe(210_000);
  expect(deriveReminderWake(null, [{ ...change, dueAt: 400_000 }], 120_000)).toBe(320_000);
});

test("text edits, pause and resume do not drift default expiry", async () => {
  const { database, channel, advance } = setup();
  try {
    const item = await channel.create({ text: "check", schedule: { in: 600_000 } });
    expect(item.expiry).toEqual({ kind: "absolute", at: 2_800_000, graceMs: 1_200_000 });
    advance();
    expect((await channel.update(item.id, { text: "edited" })).expiry).toEqual(item.expiry);
    advance();
    expect((await channel.pause(item.id)).expiry).toEqual(item.expiry);
    advance();
    expect((await channel.resume(item.id)).expiry).toEqual(item.expiry);
  } finally {
    database.close();
  }
});

test("explicit repeating anchors and expiry lengths enforce acceptance boundaries", () => {
  for (const startAt of [99_999, 100_000, 219_999]) {
    expect(() => normalizeReminderSchedule({ every: 600_000, startAt }, 100_000))
      .toThrow(expect.objectContaining({ code: "invalid_schedule" }));
  }
  expect(normalizeReminderSchedule({ every: 600_000, startAt: 220_000 }, 100_000))
    .toEqual({ every: 600_000, startAt: 220_000 });
  for (const duration of [-1, 0]) {
    expect(() => reminderExpiryPolicy(duration)).toThrow(expect.objectContaining({ code: "invalid_input" }));
  }
  expect(reminderExpiryPolicy(1)).toEqual({ kind: "duration", milliseconds: 1 });
});

test("terminal reminders reject changes and accept a repeat cancel without writing", async () => {
  const { database, repository, channel } = setup();
  try {
    for (const status of ["cancelled", "completed", "expired"] as const) {
      const item = await channel.create({ text: "check", schedule: { in: 180_000 } });
      await repository.markMaybeSent(item.id, 1);
      await repository.acknowledge(item.id, 1, { confirmed: { ...item, status } });
      for (const mutate of [channel.pause, channel.resume, (id: string) => channel.update(id, { text: "edited" })]) {
        await expect(mutate(item.id)).rejects.toMatchObject({ code: "conflict" });
        await expect(mutate("missing")).rejects.toMatchObject({ code: "not_found" });
      }
      const before = await repository.list();
      expect(await channel.cancel(item.id)).toMatchObject({ status, state: "confirmed" });
      expect(await repository.list()).toEqual(before);
    }
  } finally {
    database.close();
  }
});

async function withSqlite(work: (backend: SqliteAgentPersistence, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "reminder-sqlite-"));
  const path = join(directory, "agent.sqlite");
  try {
    const backend = await SqliteAgentPersistence.open({ path, agentSessionId: createAgentSessionId() });
    try {
      await work(backend, path);
    } finally {
      await backend.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("SQLite channel desire sets the suspension fence in its transaction", async () => {
  await withSqlite(async (backend, path) => {
    const service = new ReminderService({ persistence: backend, now: () => 0 });
    await service.conversation("channel", true, () => {}).create({ text: "check", schedule: { in: 180_000 } });
    const channels = protectPendingRetirement(backend, backend.channels);
    using database = new Database(path);
    database.exec(`CREATE TRIGGER reject_suspension BEFORE INSERT ON reminder_suspensions
      BEGIN SELECT RAISE(ABORT, 'suspension rejected'); END`);
    await expect(channels.desire("channel", { lifecycle: "suspended" })).rejects.toThrow("suspension rejected");
    expect(await channels.pendingChange("channel")).toBeUndefined();
    database.exec("DROP TRIGGER reject_suspension");
    await channels.desire("channel", { lifecycle: "suspended" });
    expect((await backend.reminders.wake()).effectiveAt).toBeNull();
    await channels.desire("channel", { lifecycle: "open" });
    expect((await backend.reminders.wake()).effectiveAt).toBe(120_000);
  });
});

test("SQLite channel confirmation sets the suspension fence in its transaction", async () => {
  await withSqlite(async (backend, path) => {
    const service = new ReminderService({ persistence: backend, now: () => 0 });
    await service.conversation("channel", true, () => {}).create({ text: "check", schedule: { in: 180_000 } });
    const channels = protectPendingRetirement(backend, backend.channels);
    const pending = await backend.channels.desire("channel", { lifecycle: "suspended" });
    using database = new Database(path);
    database.exec(`CREATE TRIGGER reject_suspension BEFORE INSERT ON reminder_suspensions
      BEGIN SELECT RAISE(ABORT, 'suspension rejected'); END`);
    await expect(channels.confirmChange("channel", pending.version)).rejects.toThrow("suspension rejected");
    expect(await channels.pendingChange("channel")).toEqual(pending);
    database.exec("DROP TRIGGER reject_suspension");
    expect(await channels.confirmChange("channel", pending.version)).toBe(true);
    expect((await backend.reminders.wake()).effectiveAt).toBeNull();
    const resumed = await backend.channels.desire("channel", { lifecycle: "open" });
    expect(await channels.confirmChange("channel", resumed.version)).toBe(true);
    expect((await backend.reminders.wake()).effectiveAt).toBe(120_000);
  });
});

test("SQLite rolls back reminder deletion and wake changes when conversation deletion fails", async () => {
  await withSqlite(async (backend, path) => {
    const { deleteConversationWithChannel } = await import("../../agent/native-channel-lifecycle.ts");
    const id = createAgentConversationId();
    await backend.conversations.create({
      agentSessionId: backend.identityRecord.agentSessionId, agentConversationId: id, controllerKind: "native",
    });
    const channel = new ReminderService({ persistence: backend, now: () => 0 }).conversation(id, true, () => {});
    const first = await channel.create({ text: "confirmed", schedule: { in: 180_000 } });
    await backend.reminders.markMaybeSent(first.id, 1);
    await backend.reminders.acknowledge(first.id, 1, { confirmed: first });
    await channel.create({ text: "pending", schedule: { in: 180_000 } });
    const before = await backend.reminders.list();
    using database = new Database(path);
    database.exec(`CREATE TRIGGER reject_conversation_delete BEFORE UPDATE OF deleted_at ON conversations
      BEGIN SELECT RAISE(ABORT, 'conversation deletion rejected'); END`);
    const agent = { persistence: backend, nativeHarness: null } as unknown as Agent;
    await expect(deleteConversationWithChannel(agent, id, {})).rejects.toThrow("conversation deletion rejected");
    expect((await backend.conversations.get(id))?.deletedAt).toBeUndefined();
    expect(await backend.channels.pendingChange(id)).toBeUndefined();
    expect(await backend.reminders.list()).toEqual(before);
    expect((await backend.reminders.wake()).effectiveAt).toBe(120_000);
    database.exec("DROP TRIGGER reject_conversation_delete");
    await deleteConversationWithChannel(agent, id, { deletedAt: "2026-01-01T00:00:00.000Z" });
    expect(await backend.conversations.get(id)).toMatchObject({ deletedAt: "2026-01-01T00:00:00.000Z" });
    expect(await backend.reminders.list()).toEqual([]);
    expect((await backend.reminders.wake()).effectiveAt).toBeNull();
  });
});

test("reminder events reach observers after the journal commits", async () => {
  await withSqlite(async (backend, path) => {
    using observer = new Database(path, { readonly: true });
    const events: Array<{ kind: ReminderEvent["kind"]; status: string; stored: string | undefined }> = [];
    let block = false;
    const service = new ReminderService({
      persistence: backend, running: () => true, now: () => 0,
      live: async ({ reminderId, changeId }) => {
        if (block) return { reason: "invalid_policy" };
        const journal = (await backend.reminders.list()).find(({ id }) => id === reminderId);
        return { confirmed: journal!.changes.find((change) => change.changeId === changeId)!.reminder };
      },
    });
    const channel = service.conversation("channel", true, ({ kind, reminder }) => {
      const change = observer.query<{ value: string }, [string]>(
        "SELECT value FROM reminder_changes WHERE id = ? ORDER BY change_id DESC LIMIT 1",
      ).get(reminder.id);
      const cache = observer.query<{ value: string }, [string]>("SELECT value FROM reminder_cache WHERE id = ?").get(reminder.id);
      events.push({ kind, status: reminder.status, stored: change ? JSON.parse(change.value).state : cache && JSON.parse(cache.value).status });
    });
    const item = await channel.create({ text: "check", schedule: { in: 180_000 } });
    block = true;
    await channel.update(item.id, { text: "edited" });
    block = false;
    await channel.cancel(item.id);
    expect(events).toEqual([
      { kind: "reminder_created", status: "active", stored: "maybe_sent" },
      { kind: "reminder_confirmed", status: "active", stored: "active" },
      { kind: "reminder_changed", status: "active", stored: "maybe_sent" },
      { kind: "reminder_blocked", status: "active", stored: "blocked" },
      { kind: "reminder_cancelled", status: "cancelled", stored: "maybe_sent" },
      { kind: "reminder_confirmed", status: "cancelled", stored: "cancelled" },
    ]);
  });
});

test("owned native and ACP conversations expose their reminder support and share agent state", async () => {
  const rig = await nativeRig();
  try {
    const agent = await rig.open({
      adapters: { main: { kind: "native" }, acp: { command: ["unused"] } },
      conversationDefaults: { providerStart: "on_first_use" },
    });
    const native = await agent.conversations.create();
    const acp = await agent.conversations.create({ adapterId: "acp" });
    const events: string[] = [];
    native.subscribe(({ event }) => events.push(event.kind));
    expect(native.conversationCapabilities.reminders).toBe(true);
    const input = { text: "check", schedule: { in: 180_000 } };
    const item = await native.reminders.create(input);
    expect(await native.reminders.get(item.id)).toEqual(item);
    expect((await agent.reminders.list()).items).toContainEqual(item);
    expect(events).toContain("reminder_created");
    expect(acp.conversationCapabilities.reminders).toBe(false);
    await expect(acp.reminders.create(input)).rejects.toMatchObject({ code: "reminders_unsupported" });
    expect(rig.launches).toEqual([]);
  } finally {
    await rig.clean();
  }
});

test("a native conversation without an owner rejects reminder access with a typed error", async () => {
  const rig = await nativeRig();
  try {
    const agent = await rig.open();
    const id = createAgentConversationId();
    const conversation = await AgentConversation.create({
      adapter: { command: ["unused"] },
      adapterId: "native",
      agentConversationId: id,
      native: { host: agent.nativeHarness!, channelId: id },
    });
    try {
      expect(conversation.conversationCapabilities.reminders).toBe(true);
      expect(() => conversation.reminders).toThrow(expect.objectContaining({ code: "reminders_unavailable" }));
    } finally {
      await conversation.stop();
    }
  } finally {
    await rig.clean();
  }
});
