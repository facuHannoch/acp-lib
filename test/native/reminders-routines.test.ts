import { expect, test } from "bun:test";
import { createAgentConversationId, createAgentSessionId } from "../../src/agent-ids.ts";
import { ReminderService } from "../../src/native/reminders/service.ts";
import { normalizeReminderSchedule } from "../../src/native/reminders/schedule.ts";
import { fromWireReminder, routineReminderRequest as reminderRequest } from "../../src/native/reminders/wire.ts";
import { SqliteAgentPersistence } from "../../src/persistence/sqlite-backend.ts";

const anchor = 1_000_000;
const iso = (value: number) => new Date(value).toISOString();

test("routine normalization checks the shared minimum, exclusive bounds and numeric cron shape", () => {
  for (const schedule of [
    { every: 599_999 }, { every: 600_000, startAt: anchor + 599_999 },
    { every: 600_000, count: 1, until: anchor + 600_000 },
    { every: 600_000, count: 0 }, { every: 600_000, count: Number.MAX_SAFE_INTEGER + 1 },
    { every: 600_000, until: Number.NaN }, { every: 600_000, until: anchor + 599_999 },
    { cron: "@daily", timezone: "UTC" }, { cron: "0 0 * * MON", timezone: "UTC" },
    { cron: "0 0 * * * *", timezone: "UTC" }, { cron: "0 0 * * *", timezone: " " },
  ]) expect(() => normalizeReminderSchedule(schedule as Parameters<typeof normalizeReminderSchedule>[0], anchor))
    .toThrow(expect.objectContaining({ code: "invalid_schedule" }));
  expect(normalizeReminderSchedule({ every: 600_000, until: anchor + 600_000 }, anchor))
    .toEqual({ every: 600_000, startAt: anchor + 600_000, until: anchor + 600_000 });
  expect(normalizeReminderSchedule({ cron: "0,20-40/10 0-23 * * 0,6", timezone: "Peer/Validates", count: 2 }, anchor))
    .toEqual({ cron: "0,20-40/10 0-23 * * 0,6", timezone: "Peer/Validates", count: 2 });
  for (const cron of ["0/10 * * * *", "*/0 * * * *", "0 0 * * 7"]) {
    expect(normalizeReminderSchedule({ cron, timezone: "UTC" }, anchor)).toEqual({ cron, timezone: "UTC" });
  }
  expect(normalizeReminderSchedule({ every: 600_000, until: anchor }, anchor, undefined, true))
    .toEqual({ every: 600_000, startAt: anchor + 600_000, until: anchor });
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

import { noopLogger } from "../../src/logger.ts";
import { openOrCreate } from "../../src/native/recovery.ts";
import { ReminderSync } from "../../src/native/reminders/sync.ts";
import { RoutinePeer } from "./fixtures/routine-peer.ts";
import type { RoutineConfig, RoutineRow } from "../../src/native/reminders/routine-wire.ts";

const negotiated = { reminders: true, routines: true, unattendedTurnGuard: true } as const;

async function startup(live = false) {
  const id = createAgentSessionId();
  const channel = createAgentConversationId();
  const persistence = await SqliteAgentPersistence.open({ path: ":memory:", agentSessionId: id });
  await persistence.conversations.create({ agentSessionId: id, agentConversationId: channel, controllerKind: "native" });
  const repo = persistence.reminders;
  const sync = new ReminderSync(persistence, repo, noopLogger);
  const peer = new RoutinePeer();
  const service = new ReminderService({ persistence, now: () => anchor,
    routineUnavailable: () => sync.routineAdmission.unavailable(),
    running: () => live, live: async change => await sync.dispatch(peer.client, change) ?? { reason: "not_found" } });
  const reminders = service.conversation(channel, true, () => {});
  const config: RoutineConfig = { version: 1, system: "test", model: { protocol: "scripted", script: "" },
    defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } } };
  const open = (guard?: number, target = peer) => openOrCreate(target.client, {
    sessionId: peer.sessionId, config: guard === undefined ? config : { ...config, limits: { unattendedTurns: guard } },
  }, [{ channel, changeId: "1", displayName: "channel" }], undefined, new AbortController().signal, sync);
  const saved = (id: string): RoutineRow => ({
    id, channel, createdBy: "host", policyNames: [], text: id, state: "active",
    acceptedAt: iso(anchor), nextRunAt: iso(anchor + 600_000), expiresAfter: null, expiresAt: null,
    schedule: { every: 600_000, startAt: iso(anchor + 600_000) }, missedRuns: "coalesce", overlap: "skip",
  });
  return { persistence, repo, sync, peer, reminders, open, saved };
}

const interval = { text: "routine", schedule: { every: 600_000 } };

test("routine authoring requires both capabilities and an effective guard from executable open", async () => {
  const s = await startup();
  try {
    for (const capabilities of [
      { ...negotiated, routines: false }, { ...negotiated, unattendedTurnGuard: false },
    ]) {
      await s.sync.initialize({ capabilities });
      await expect(s.reminders.create(interval)).rejects.toMatchObject({ code: "routines_unavailable" });
      await expect(s.open(3)).rejects.toThrow("must support routines");
    }
    expect(s.peer.calls).toEqual([]);
    await s.sync.initialize({ capabilities: negotiated });
    expect(s.sync.limits).toMatchObject({ repeatIntervalMs: 600_000, perChannel: 20, maxRoutineCatchUp: 10 });
    await expect(s.open(0)).rejects.toMatchObject({ code: "invalid_config" });
    await s.open();
    await expect(s.reminders.create(interval)).rejects.toMatchObject({ code: "routines_unavailable" });
    expect(await s.repo.list()).toEqual([]);
    await s.open(3);
    expect((await s.reminders.create(interval)).state).toBe("pending");
    s.peer.guard = null;
    await s.open(3);
    expect(s.peer.calls.at(-1)?.params.config).not.toHaveProperty("limits");
    await s.sync.dispatch(s.peer.client);
    expect(s.peer.calls.at(-1)?.method).toBe("change");
    expect((await s.repo.list())[0]?.changes[0]).toMatchObject({ state: "blocked", reason: "unattended_guard_required" });
    await s.open(3);
    await expect(s.open(4)).rejects.toMatchObject({ code: "invalid_config" });
  } finally { await s.persistence.close(); }
});

test("startup sends owed pause before due work and holds routine activation until guard confirmation", async () => {
  const s = await startup();
  try {
    s.peer.rows.set("owed", s.saved("owed"));
    await s.sync.initialize({ capabilities: negotiated });
    await s.open(3);
    const created = await s.reminders.create(interval);
    await s.reminders.pause("owed");
    expect((await s.repo.wake()).effectiveAt).toBeNull();
    const original = (await s.repo.list()).find(row => row.id === created.id)!.changes[0]!;
    s.peer.trace.length = 0;
    await s.sync.initialize({ capabilities: negotiated });
    await s.open(3);
    expect(s.peer.trace).toEqual(["guard", "channel:" + s.saved("owed").channel, "change:owed", "due"]);
    expect((await s.repo.list()).find(row => row.id === created.id)?.changes[0]?.state).toBe("pending");
    await s.sync.dispatch(s.peer.client);
    expect(s.peer.calls.at(-1)).toEqual({ method: "change", params: reminderRequest(original) });
    expect(s.peer.rows.get("owed")?.state).toBe("paused");
    expect(s.peer.rows.get(created.id)?.state).toBe("active");
  } finally { await s.persistence.close(); }
});

test("startup storage failure keeps the exact frozen batch and replays prior receipts on bounded retry", async () => {
  const s = await startup();
  try {
    for (const id of ["first", "failure", "later"]) s.peer.rows.set(id, s.saved(id));
    await s.sync.initialize({ capabilities: negotiated });
    await s.open(3);
    for (const id of ["first", "failure", "later"]) await s.reminders.update(id, { text: "updated " + id });
    s.peer.failId = "failure";
    s.peer.failures = 3;
    s.peer.trace.length = 0;
    let entered = 0;
    let appended: string | undefined;
    s.peer.beforeStartupBatch = async () => {
      if (++entered === 2) appended = (await s.reminders.create({ text: "new one-off", schedule: { in: 180_000 } })).id;
    };
    await expect(s.open(3)).rejects.toMatchObject({ code: "reminder_batch_retry_exhausted" });
    const [attempt, retry, final] = s.peer.calls.slice(-3);
    expect(attempt).toEqual(retry);
    expect(attempt).toEqual(final);
    expect(JSON.stringify(final)).not.toContain(appended!);
    expect(s.peer.trace).toEqual([
      "guard", "channel:" + s.saved("first").channel, "change:first", "change:failure",
      "guard", "channel:" + s.saved("first").channel, "replay:first", "change:failure",
      "guard", "channel:" + s.saved("first").channel, "replay:first", "change:failure",
    ]);
    expect((await s.repo.list()).filter(row => row.id !== appended).flatMap(row => row.changes.map(change => change.state))).toEqual(["maybe_sent", "maybe_sent", "maybe_sent"]);
    expect(s.peer.rows.get("later")?.text).toBe("later");
    await s.open(3);
    expect(s.peer.calls.at(-1)).toEqual(attempt);
    expect((await s.repo.list()).flatMap(row => row.changes.map(change => change.reminder.id))).toEqual([appended]);
  } finally { await s.persistence.close(); }
});

test("a partially published create recovers by open with the same frozen entries and no second creation", async () => {
  const s = await startup();
  try {
    s.peer.rows.set("owed", s.saved("owed"));
    await s.repo.observe(fromWireReminder(s.saved("owed")));
    await s.reminders.update("owed", { text: "recover after create" });
    await s.sync.initialize({ capabilities: negotiated });
    s.peer.failId = "owed";
    s.peer.failures = 3;
    await s.repo.updateDeadline({ sessionId: s.peer.sessionId, revision: 15, nextDueAt: anchor });
    await expect(s.open(3)).rejects.toMatchObject({ code: "reminder_batch_retry_exhausted" });
    expect((await s.repo.wake()).replacementAttempted).toBe(s.peer.sessionId);
    expect((await s.repo.wake()).reported?.revision).toBe(15);
    await s.open(3);
    expect(s.peer.calls.map(call => call.method)).toEqual(["open", "create", "open", "open", "open"]);
    for (const call of s.peer.calls.slice(2)) {
      expect(call.params.reminderChanges).toEqual(s.peer.calls[1]?.params.reminderChanges);
    }
    expect((await s.repo.wake()).replacementAttempted).toBeUndefined();
    expect((await s.repo.wake()).reported).toEqual({ sessionId: s.peer.sessionId, revision: 0, nextDueAt: null });
    expect(s.peer.guard).toBe(3);
    expect(s.peer.rows.get("owed")?.text).toBe("recover after create");
    expect(s.peer.trace.filter(step => step === "due")).toHaveLength(1);
  } finally { await s.persistence.close(); }
});

test("live proof retry keeps payload identity and guard refusal stays visible as a blocked outcome", async () => {
  const s = await startup();
  try {
    await s.sync.initialize({ capabilities: negotiated });
    await s.open(3);
    const item = await s.reminders.create(interval);
    s.peer.failId = item.id;
    s.peer.failures = 1;
    s.peer.blockActivation = true;
    await s.sync.dispatch(s.peer.client);
    const [first, retry] = s.peer.calls.slice(-2);
    expect(first).toEqual(retry);
    expect(await s.reminders.get(item.id)).toMatchObject({ state: "blocked", reason: "unattended_guard_required" });
  } finally { await s.persistence.close(); }
});

test("routine dispositions precede fires without making a routine terminal", async () => {
  const s = await startup();
  try {
    await s.sync.initialize({ capabilities: negotiated });
    const row = { ...s.saved("counted"), remainingCount: 3 };
    s.peer.rows.set(row.id, row);
    await s.open(3);
    const seen: string[] = [];
    const emit = (_: string, event: { kind: string }) => seen.push(event.kind);
    const channel = row.channel;
    const disposition = { kind: "routine_disposition", reminderId: row.id, firstScheduledAt: iso(anchor + 600_000),
      lastScheduledAt: iso(anchor + 1_200_000), count: 2, reason: "coalesced" } as const;
    s.sync.notification({ channel, event: disposition }, emit);
    s.sync.notification({ channel, event: { ...disposition } }, emit);
    s.sync.notification({ channel, event: { kind: "reminder_fired", reminderId: row.id, occurrenceId: "occ", noticeId: "notice",
      scheduledAt: disposition.lastScheduledAt, firedAt: disposition.lastScheduledAt } }, emit);
    await s.sync.settled();
    expect(seen).toEqual(["routine_disposition", "routine_disposition", "reminder_fired"]);
    expect(await s.reminders.get(row.id)).toMatchObject({ remainingCount: 3, status: "active", nextRunAt: anchor + 600_000, noticeId: "notice" });
    s.sync.notification({ channel, event: { kind: "reminder_changed", reminder: { ...row, remainingCount: 1, nextRunAt: iso(anchor + 1_800_000) } } }, emit);
    await s.sync.settled();
    expect(await s.reminders.get(row.id)).toMatchObject({ remainingCount: 1, status: "active", nextRunAt: anchor + 1_800_000 });
  } finally { await s.persistence.close(); }
});

test("routine migration publishes the hold before its blocked row and delivers identical live events", async () => {
  const s = await startup();
  try {
    await s.sync.initialize({ capabilities: negotiated });
    const row = { ...s.saved("calendar"), schedule: { cron: "0 * * * *", timezone: "Etc/UTC", count: 4 },
      timezoneVersion: "2026a", remainingCount: 2 };
    s.peer.rows.set(row.id, row);
    await s.open(3);
    const timezoneMigration = { fromVersion: "2026a", targetVersion: "2026b", cause: "proof_budget" } as const;
    const blocked = { ...row, state: "blocked", blockedReason: "invalid_schedule", nextRunAt: null, timezoneMigration } as const;
    const channel = row.channel;
    const seen: string[] = [];
    const emit = (_: string, event: { kind: string }) => seen.push(event.kind);
    const event = { kind: "routine_migration_blocked", reminderId: row.id, ...timezoneMigration } as const;
    s.sync.notification({ channel, event }, emit);
    s.sync.notification({ channel, event }, emit);
    s.sync.notification({ channel, event: { kind: "reminder_changed", reminder: blocked } }, emit);
    await s.sync.settled();
    expect(seen).toEqual(["routine_migration_blocked", "routine_migration_blocked", "reminder_changed"]);
    expect(await s.reminders.get(row.id)).toMatchObject({ status: "blocked", blockedReason: "invalid_schedule",
      timezoneVersion: "2026a", timezoneMigration, remainingCount: 2, nextRunAt: null });
    expect((await s.repo.wake()).effectiveAt).toBeNull();
    s.peer.rows.set(row.id, blocked);
    await s.open(3);
    expect(seen).toHaveLength(3);
    s.sync.notification({ channel, event }, emit);
    await s.sync.settled();
    expect(seen).toHaveLength(4);
  } finally { await s.persistence.close(); }
});

test("the wire staging backstop quarantines a routine-shaped journal when routine capability is absent", async () => {
  const s = await startup();
  try {
    await s.sync.initialize({ capabilities: negotiated });
    await s.open(3);
    const item = await s.reminders.create(interval);
    const before = (await s.repo.list())[0]!.changes[0]!;
    expect(reminderRequest(before)).toMatchObject({ op: "create", payload: { schedule: { every: 600_000 } } });
    await s.sync.initialize({ capabilities: { reminders: true } });
    expect(await s.sync.stage()).toEqual([]);
    await s.sync.dispatch(s.peer.client);
    expect(s.peer.calls.every(call => call.method !== "change")).toBe(true);
    expect((await s.repo.list())[0]!.changes[0]).toMatchObject({ state: "blocked", reason: "routines_unavailable" });
    expect((await s.repo.wake()).effectiveAt).toBeNull();
  } finally { await s.persistence.close(); }
});

test("startup holds a routine create and follow-up pause, allowing a due occurrence between live requests", async () => {
  const s = await startup();
  try {
    await s.sync.initialize({ capabilities: negotiated });
    await s.open(3);
    const created = await s.reminders.create(interval);
    expect((await s.repo.wake()).effectiveAt).toBeNull();
    expect((await s.repo.wake(true)).effectiveAt).toBe(anchor + 120_000);
    await s.reminders.pause(created.id);
    const removed = await s.reminders.create(interval);
    await s.reminders.cancel(removed.id);
    await s.sync.initialize({ capabilities: negotiated });
    s.peer.trace.length = 0;
    await s.open();
    expect(s.peer.trace).toEqual(["guard", "channel:" + s.saved("unused").channel, "due"]);
    const changes = () => s.repo.list().then(rows => rows.flatMap(row => row.changes));
    expect(await changes()).toMatchObject([{ op: "create", state: "pending" }, { op: "update", state: "pending" }]);
    s.peer.afterLiveChange = entry => {
      if (entry.op === "create") {
        expect(s.peer.rows.get(created.id)?.state).toBe("active");
        s.peer.trace.push("occurrence:" + created.id);
      }
    };
    await s.sync.dispatch(s.peer.client);
    expect(s.peer.trace.slice(-3)).toEqual(["change:" + created.id, "occurrence:" + created.id, "change:" + created.id]);
    expect(s.peer.rows.get(created.id)?.state).toBe("paused");
    expect(s.peer.rows.has(removed.id)).toBe(false);
  } finally { await s.persistence.close(); }
});

test("startup processes the old calendar before a held routine replacement and its follow-up cancel", async () => {
  const s = await startup();
  try {
    s.peer.rows.set("replace", s.saved("replace"));
    await s.sync.initialize({ capabilities: negotiated });
    await s.open(3);
    await s.reminders.update("replace", { schedule: { every: 720_000 } });
    await s.reminders.cancel("replace");
    expect((await s.repo.wake()).effectiveAt).toBeNull();
    s.peer.trace.length = 0;
    await s.open();
    expect(s.peer.trace).toEqual(["guard", "channel:" + s.saved("unused").channel, "due"]);
    expect(s.peer.rows.get("replace")?.schedule).toMatchObject({ every: 600_000 });
    await s.sync.dispatch(s.peer.client);
    expect(s.peer.calls.slice(-2).map(call => (call.params as { op?: string }).op)).toEqual(["update", "cancel"]);
    expect(s.peer.rows.get("replace")?.state).toBe("cancelled");
  } finally { await s.persistence.close(); }
});

test("live storage failure returns the same journaled identity on a consumer retry", async () => {
  const s = await startup(true);
  try {
    await s.sync.initialize({ capabilities: negotiated });
    await s.open(3);
    // Fail each attempt of the next user create, before the peer records a receipt.
    s.peer.failures = 3;
    s.peer.failId = "*";
    const initial = await s.reminders.create(interval);
    expect(initial).toMatchObject({ state: "maybe_sent", reason: "storage_failure" });
    const changeCalls = () => s.peer.calls.filter(call => call.method === "change");
    expect(changeCalls()).toHaveLength(3);
    expect(new Set(changeCalls().map(call => JSON.stringify(call.params))).size).toBe(1);
    const recovered = await s.reminders.create({ schedule: interval.schedule, text: interval.text });
    expect(recovered).toMatchObject({ id: initial.id, state: "confirmed" });
    expect(changeCalls().at(-1)).toEqual(changeCalls()[0]);
    expect(s.peer.rows.size).toBe(1);

    s.peer.failures = 3;
    const edited = await s.reminders.update(initial.id, { text: "retry edit" });
    expect(edited).toMatchObject({ id: initial.id, state: "maybe_sent", reason: "storage_failure" });
    const failedEdit = changeCalls().at(-1);
    expect(await s.reminders.update(initial.id, { text: "retry edit" })).toMatchObject({ state: "confirmed" });
    expect(changeCalls().at(-1)).toEqual(failedEdit);
  } finally { await s.persistence.close(); }
});

test("confirmed absence after an interrupted create permits a fresh create on the next start", async () => {
  for (const code of ["transport_closed", "timeout"] as const) {
    const s = await startup();
    try {
      await s.sync.initialize({ capabilities: negotiated });
      s.peer.failBeforeCreate = code;
      await expect(s.open(3)).rejects.toMatchObject({ code });
      expect((await s.repo.wake()).replacementAttempted).toBe(s.peer.sessionId);
      await s.open(3);
      expect(s.peer.calls.map(call => call.method)).toEqual(["open", "create", "open", "create"]);
      expect((await s.repo.wake()).replacementAttempted).toBeUndefined();
    } finally { await s.persistence.close(); }
  }
});

test("routine expiry consumes a range and becomes terminal only from the authoritative row", async () => {
  const s = await startup();
  try {
    await s.sync.initialize({ capabilities: negotiated });
    const row = { ...s.saved("expiry"), remainingCount: 3 };
    const channel = row.channel;
    s.peer.rows.set(row.id, row);
    await s.open(3);
    const first = iso(anchor + 600_000), last = iso(anchor + 1_200_000);
    const snapshot = async () => (await s.repo.list())[0]?.confirmed;
    s.sync.notification({ channel, event: { kind: "reminder_expired", reminderId: row.id,
      occurrenceId: "unexpected", scheduledAt: first, expiredAt: last } }, () => {}, s.peer.client);
    await s.sync.settled();
    expect(await snapshot()).toMatchObject({ status: "active", remainingCount: 3, nextRunAt: anchor + 600_000 });

    const disposition = { kind: "routine_disposition", reason: "expired", reminderId: row.id,
      firstScheduledAt: first, lastScheduledAt: last, count: 2 } as const;
    const next = iso(anchor + 1_800_000);
    s.peer.rows.set(row.id, { ...row, remainingCount: 1, nextRunAt: next });
    s.sync.notification({ channel, event: disposition }, () => {}, s.peer.client);
    await s.sync.settled();
    expect(await snapshot()).toMatchObject({ status: "active", remainingCount: 1, nextRunAt: anchor + 1_800_000 });

    s.peer.rows.set(row.id, { ...row, state: "done", remainingCount: 0, nextRunAt: null });
    s.sync.notification({ channel, event: { ...disposition, firstScheduledAt: next, lastScheduledAt: next, count: 1 } },
      () => {}, s.peer.client);
    await s.sync.settled();
    expect(await snapshot()).toMatchObject({ status: "completed", remainingCount: 0, nextRunAt: null });
  } finally { await s.persistence.close(); }
});

test("discardExhausted removes only the chosen reminder from the frozen batch", async () => {
  const s = await startup();
  try {
    for (const id of ["broken", "keep"]) s.peer.rows.set(id, s.saved(id));
    await s.sync.initialize({ capabilities: negotiated });
    await s.open(3);
    await s.reminders.update("broken", { text: "bad change" });
    await s.reminders.update("keep", { text: "good change" });
    expect(await s.reminders.discardExhausted("broken")).toBe(false);
    s.peer.failId = "broken";
    s.peer.failures = 10;
    await expect(s.open()).rejects.toMatchObject({ code: "reminder_batch_retry_exhausted" });
    const original = (await s.repo.wake()).startupRetry?.entries;
    expect(original?.map(entry => entry.reminderId)).toEqual(["broken", "keep"]);
    expect(await s.reminders.discardExhausted("broken")).toBe(true);
    expect(await s.reminders.discardExhausted("broken")).toBe(false);
    expect((await s.repo.wake()).startupRetry?.entries).toEqual(original?.slice(1));
    expect((await s.repo.list()).find(row => row.id === "broken")).toMatchObject({ highWater: 1, changes: [] });
    await s.open();
    expect(s.peer.rows.get("broken")?.text).toBe("broken");
    expect(s.peer.rows.get("keep")?.text).toBe("good change");
    expect((await s.repo.wake()).startupRetry).toBeUndefined();
  } finally { await s.persistence.close(); }
});
