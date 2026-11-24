import { expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ReminderService } from "../../src/native/reminders/service.ts";
import type { HarnessClient, ReminderChange, ReminderChangeResult } from "../../src/native-harness/src/client.ts";
import { spawnHarness } from "../../src/native-harness/test/helpers/stdio.ts";
import { ReminderClock } from "./fixtures/reminder-clock.ts";
import { nativeRig, until } from "./support.ts";

const interval = 600_000;
const iso = (at: number) => new Date(at).toISOString();
const notice = (id: string, at: number) => `reminder-notice:${id}:${iso(at)}`;
type Guard = number | "unlimited";
type Open = Awaited<ReturnType<HarnessClient["openSession"]>>;

async function routineRig() {
  const rig = await nativeRig();
  const clock = new ReminderClock();
  clock.time = Date.now();
  rig.harness.reminderTimer = clock;
  const at = (time: number) => { rig.env.HARNESS_TEST_REMINDER_TIME = String(time); };
  at(clock.time);
  const guard = (limit?: Guard) => {
    rig.harness.config = {
      version: 1, system: "Joint routines",
      model: { protocol: "scripted", script: join(rig.directory, "script.jsonl") },
      defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } },
      ...(limit === undefined ? {} : { limits: { unattendedTurns: limit } }),
    };
  };
  const opens: Open[] = [];
  const batches: Array<Parameters<HarnessClient["openSession"]>[0]> = [];
  const receipts: ReminderChangeResult[] = [];
  const gets: string[] = [];
  let client: HarnessClient | undefined;
  const observeRpc = () => {
    rig.harness.connect = async () => {
      const child = spawnHarness({ home: rig.home, effects: rig.effectsPath, fault: rig.env.HARNESS_TEST_FAULT, reminderTime: Number(rig.env.HARNESS_TEST_REMINDER_TIME) });
      client = child.client;
      const open = client.openSession.bind(client);
      client.openSession = async params => {
        batches.push(structuredClone(params));
        const result = await open(params);
        opens.push(result);
        return result;
      };
      const create = client.createSession.bind(client);
      client.createSession = async params => {
        batches.push(structuredClone(params));
        const result = await create(params);
        opens.push(result);
        return result;
      };
      const get = client.getReminder.bind(client);
      client.getReminder = async params => {
        gets.push(params.id);
        return get(params);
      };
      const change = client.changeReminder.bind(client);
      client.changeReminder = async entry => {
        const result = await change(entry);
        receipts.push(result);
        return result;
      };
      return { client, closed: child.child.exited.then(() => {}), kill: () => child.close() };
    };
  };
  const conversation = async (agent: Awaited<ReturnType<typeof rig.open>>) => {
    const channel = await agent.conversations.create();
    await agent.nativeHarness!.changeChannel(channel.id, { displayName: "Routine target" });
    return channel;
  };
  return { rig, clock, at, guard, opens, batches, receipts, gets, observeRpc, conversation, get client() { return client!; } };
}

test("joint guard rejects a different value and accepts the same value in another Agent and harness", async () => {
  const s = await routineRig();
  s.observeRpc();
  try {
    s.guard(3);
    const first = await s.rig.open();
    await first.nativeHarness!.start();
    const id = first.id;
    await first.close();
    s.guard(4);
    const incompatible = await s.rig.open({ id });
    await expect(incompatible.nativeHarness!.start()).rejects.toMatchObject({ code: "invalid_config" });
    expect(incompatible.nativeHarness!.state).toBe("stopped");
    expect(incompatible.nativeHarness!.launches).toBe(1);
    await incompatible.close();
    s.guard(3);
    const compatible = await s.rig.open({ id });
    await compatible.nativeHarness!.start();
    expect(s.opens.at(-1)?.unattendedTurnGuard).toEqual({ maxConsecutiveTurns: 3 });
    expect(compatible.nativeHarness!.state).toBe("running");
  } finally { await s.rig.clean(); }
}, 15_000);

test("joint unlimited guard and the numeric maximum are interchangeable across fresh launches", async () => {
  const max = 9007199254740991;
  for (const [from, to] of [["unlimited", max], [max, "unlimited"]] as const) {
    const s = await routineRig();
    s.observeRpc();
    try {
      s.guard(from);
      const first = await s.rig.open();
      await first.nativeHarness!.start();
      const id = first.id;
      await first.close();
      s.guard(to);
      const second = await s.rig.open({ id });
      await second.nativeHarness!.start();
      expect(s.batches.at(-1)?.config?.limits).toEqual({ unattendedTurns: max });
      expect(s.opens.at(-1)?.unattendedTurnGuard).toEqual({ maxConsecutiveTurns: max });
    } finally { await s.rig.clean(); }
  }
}, 15_000);

test("joint no-guard open holds a routine create and the live harness records its refusal", async () => {
  const s = await routineRig();
  s.observeRpc();
  s.guard();
  try {
    const agent = await s.rig.open();
    const channel = await s.conversation(agent);
    // Simulate a retained offline intent without bypassing activation admission on the real host.
    const offline = new ReminderService({ persistence: agent.persistence, routineUnavailable: () => undefined });
    const item = await offline.conversation(channel.id, true, () => {}).create({ text: "held", schedule: { every: interval } });
    const host = agent.nativeHarness!;
    expect((await agent.persistence.reminders!.wake()).effectiveAt).toBeNull();
    await expect(channel.reminders.create({ text: "new", schedule: { every: interval } })).rejects.toMatchObject({ code: "routines_unavailable" });
    await host.start();
    expect(s.opens.at(-1)?.unattendedTurnGuard).toBeNull();
    expect(s.batches.at(-1)?.reminderChanges ?? []).toEqual([]);
    expect(host.reminderSync!.routineAdmission.available).toBe(false);
    await until(() => s.receipts.some(r => r.reminderId === item.id), "live guard refusal");
    expect(s.receipts).toContainEqual(expect.objectContaining({ reminderId: item.id, outcome: "blocked", reason: "unattended_guard_required" }));
    await until(async () => (await channel.reminders.get(item.id))?.state === "blocked", "stored guard refusal");
    expect(await channel.reminders.get(item.id)).toMatchObject({ state: "blocked", reason: "unattended_guard_required" });
  } finally { await s.rig.clean(); }
}, 15_000);

test("joint production launcher delivers each missed and coalesced disposition once", async () => {
  const s = await routineRig();
  s.guard(4);
  try {
    const agent = await s.rig.open();
    const skipped = await s.conversation(agent);
    const merged = await s.conversation(agent);
    const skippedEvents = s.rig.watch(skipped);
    const mergedEvents = s.rig.watch(merged);
    const host = agent.nativeHarness!;
    await host.start();
    const timing = { every: interval, count: 4, startAt: s.clock.time + interval * 2 };
    const skip = await skipped.reminders.create({ text: "skip", schedule: timing, missedRuns: "skip" });
    const merge = await merged.reminders.create({ text: "merge", schedule: timing, missedRuns: "coalesce" });
    const due = timing.startAt;
    expect(skip.nextRunAt).toBe(due);
    expect(merge.nextRunAt).toBe(due);
    await host.stop();
    s.at(due + interval + 120_000);
    await host.start();
    await until(() => skippedEvents.some(event => event.kind === "routine_disposition") &&
      mergedEvents.some(event => event.kind === "reminder_fired"), "real routine notifications through production launcher");
    await host.reminderSync!.settled();
    const disposition = (id: string, reason: string, count: number, last: number) => ({
      kind: "routine_disposition", reminderId: id, firstScheduledAt: iso(due),
      lastScheduledAt: iso(last), reason, count,
    });
    expect(skippedEvents.filter(event => event.kind === "routine_disposition")).toEqual([disposition(skip.id, "missed", 2, due + interval)]);
    expect(mergedEvents.filter(event => event.kind === "routine_disposition")).toEqual([disposition(merge.id, "coalesced", 2, due + interval)]);
    expect(mergedEvents.filter(event => event.kind === "reminder_fired").map(event => event.noticeId)).toEqual([notice(merge.id, due + interval)]);
    expect(skippedEvents.filter(event => event.kind === "reminder_fired")).toEqual([]);
    const rows = await agent.persistence.reminders!.list();
    for (const id of [skip.id, merge.id]) expect(rows.find(row => row.id === id)?.confirmed)
      .toMatchObject({ remainingCount: 2, nextRunAt: due + interval * 2, status: "active" });
  } finally { await s.rig.clean(); }
}, 15_000);

test("joint expired dispositions refresh both an active routine and its final terminal row", async () => {
  const s = await routineRig();
  s.guard(4);
  s.observeRpc();
  try {
    const agent = await s.rig.open();
    const channel = await s.conversation(agent);
    const events = s.rig.watch(channel);
    const host = agent.nativeHarness!;
    await host.start();
    const item = await channel.reminders.create({ text: "short grace", schedule: { every: interval, count: 3 }, expiresAfter: 300_000 });
    const due = item.nextRunAt!;
    const dispositions = () => events.filter(event => event.kind === "routine_disposition");
    for (const [at, count, remaining] of [[due + interval + 300_000, 2, 1], [due + interval * 2 + 300_000, 1, 0]] as const) {
      await host.stop();
      s.at(at);
      await host.start();
      const index = count === 2 ? 0 : 1;
      await until(() => dispositions().length > index, "expired routine disposition");
      await host.reminderSync!.settled();
      expect(dispositions()[index]).toMatchObject({ reminderId: item.id, reason: "expired", count });
      expect(s.gets.filter(id => id === item.id)).toHaveLength(index + 1);
      expect((await agent.persistence.reminders!.list())[0]?.confirmed).toMatchObject({
        status: remaining ? "active" : "completed", remainingCount: remaining, nextRunAt: remaining ? due + interval * 2 : null,
      });
    }
    expect(dispositions()).toHaveLength(2);
    expect(events.filter(event => event.kind === "reminder_expired" || event.kind === "reminder_fired")).toEqual([]);
  } finally { await s.rig.clean(); }
}, 15_000);

test("joint overlap skip recovers the first committed notice after a harness crash", async () => {
  const s = await routineRig();
  s.guard(4);
  s.observeRpc();
  try {
    const agent = await s.rig.open();
    const channel = await s.conversation(agent);
    const events = s.rig.watch(channel);
    const host = agent.nativeHarness!;
    await host.start();
    const item = await channel.reminders.create({ text: "overlap", overlap: "skip", schedule: { every: interval, count: 2 } });
    const first = item.nextRunAt!;
    await host.stop();
    s.at(first);
    s.rig.env.HARNESS_TEST_FAULT = "fireDueReminders:1";
    await expect(host.start()).rejects.toMatchObject({ code: "transport_closed" });
    delete s.rig.env.HARNESS_TEST_FAULT;
    s.at(first + interval);
    await host.start();
    await until(() => events.some(event => event.kind === "routine_disposition"), "overlap disposition after recovery");
    expect(events.filter(event => event.kind === "routine_disposition")).toEqual([{
      kind: "routine_disposition", reason: "overlap", reminderId: item.id, count: 1,
      firstScheduledAt: iso(first + interval), lastScheduledAt: iso(first + interval),
    }]);
    expect((await s.client.reconcileChannel({ channel: channel.id, itemIds: [notice(item.id, first), notice(item.id, first + interval)] })).items
      .map(row => row.id)).toEqual([notice(item.id, first)]);
    expect(await channel.reminders.get(item.id)).toMatchObject({ status: "completed", remainingCount: 0, nextRunAt: null });
  } finally { await s.rig.clean(); }
}, 15_000);

test("joint production launcher delivers a timezone migration hold once and caches its blocked row", async () => {
  const s = await routineRig();
  s.guard(4);
  try {
    const agent = await s.rig.open();
    const channel = await s.conversation(agent);
    const events = s.rig.watch(channel);
    const host = agent.nativeHarness!;
    await host.start();
    const item = await channel.reminders.create({ text: "migrate", schedule: { cron: "0 13 * * *", timezone: "Etc/UTC", count: 2 } });
    expect(item.state).toBe("confirmed");
    const targetVersion = item.timezoneVersion!;
    await host.stop();
    // Seed a row from older timezone data in the disposable harness database.
    const paths = Array.from(new Bun.Glob("**/session.sqlite").scanSync({ cwd: s.rig.home, absolute: true }));
    expect(paths).toHaveLength(1);
    {
      using db = new Database(paths[0]!);
      db.query(`UPDATE reminder_rows SET json = json_set(json, '$.timezoneVersion', '0000a',
        '$.schedule.timezone', 'Unavailable/Legacy') WHERE reminder_id = ?`).run(item.id);
    }
    await host.start();
    await until(() => events.some(event => event.kind === "routine_migration_blocked"), "production migration event");
    await host.reminderSync!.settled();
    const holds = () => events.filter(event => event.kind === "routine_migration_blocked");
    expect(holds()).toEqual([{
      kind: "routine_migration_blocked", reminderId: item.id, fromVersion: "0000a", targetVersion, cause: "invalid_schedule",
    }]);
    expect((await agent.persistence.reminders!.list())[0]?.confirmed).toMatchObject({
      status: "blocked", blockedReason: "invalid_schedule", timezoneVersion: "0000a",
      timezoneMigration: { fromVersion: "0000a", targetVersion, cause: "invalid_schedule" },
      remainingCount: 2, nextRunAt: null,
    });
    await host.stop();
    await host.start();
    await host.reminderSync!.settled();
    expect(holds()).toHaveLength(1);
  } finally { await s.rig.clean(); }
}, 15_000);
test("joint harness refuses forged schedule kind and one-off delivery edits without changing confirmed rows", async () => {
  const s = await routineRig();
  s.guard(4);
  s.observeRpc();
  try {
    const agent = await s.rig.open();
    const channel = await s.conversation(agent);
    await agent.nativeHarness!.start();
    const every = await channel.reminders.create({ text: "interval", schedule: { every: interval } });
    const calendar = await channel.reminders.create({ text: "calendar", schedule: { cron: "0 13 * * *", timezone: "Etc/UTC" } });
    const oneOff = await channel.reminders.create({ text: "one-off", schedule: { in: interval } });
    expect([every.state, calendar.state, oneOff.state]).toEqual(["confirmed", "confirmed", "confirmed"]);
    const change = s.client.changeReminder.bind(s.client);
    const malformed = new Map<string, Extract<ReminderChange, { op: "update" }>["payload"]>([
      [every.id, { schedule: { cron: "0 13 * * *", timezone: "Etc/UTC" }, acceptedAt: iso(Date.now()) }],
      [calendar.id, { schedule: { every: interval }, acceptedAt: iso(Date.now()) }],
      [oneOff.id, { overlap: "queue", missedRuns: "skip" }],
    ]);
    s.client.changeReminder = entry => change(entry.op === "update" && malformed.has(entry.reminderId)
      ? { ...entry, payload: malformed.get(entry.reminderId)! } : entry);
    for (const initial of [every, calendar, oneOff]) {
      const result = await channel.reminders.update(initial.id, { text: "forged at the wire boundary" });
      expect(result).toMatchObject({ state: "blocked", reason: "invalid_schedule" });
      const persisted = (await agent.persistence.reminders!.list()).find(row => row.id === initial.id)!;
      expect(persisted.confirmed).toMatchObject({ text: initial.text, schedule: initial.schedule });
      expect(persisted.changes).toMatchObject([{ state: "blocked", changeId: 2, reason: "invalid_schedule" }]);
      expect((await s.client.getReminder({ id: initial.id })).reminder.text).toBe(initial.text);
    }
  } finally { await s.rig.clean(); }
}, 15_000);

test("joint cold wake applies offline cancel and pause before due routine work", async () => {
  const s = await routineRig();
  s.guard(4);
  s.observeRpc();
  try {
    const agent = await s.rig.open();
    const channel = await s.conversation(agent);
    const events = s.rig.watch(channel);
    const host = agent.nativeHarness!;
    await host.start();
    const due = s.clock.time + 2 * interval;
    const create = (text: string) => channel.reminders.create({ text, schedule: { every: interval, startAt: due, count: 2 } });
    const cancelled = await create("cancel");
    const paused = await create("pause");
    const fires = await create("wake");
    await host.stop();
    await channel.reminders.cancel(cancelled.id);
    await channel.reminders.pause(paused.id);
    expect((await agent.persistence.reminders!.wake()).reported?.nextDueAt).toBe(due);
    await until(() => s.clock.delays.length === 1, "cold routine timer armed");
    s.at(due);
    s.clock.tickAt(due);
    await until(() => host.state === "running" && events.some(event => event.kind === "reminder_fired"), "cold routine wake and delivery");
    expect(host.launches).toBe(2);
    expect(s.batches.at(-1)?.reminderChanges?.map(entry => [entry.reminderId, entry.op])).toEqual([[cancelled.id, "cancel"], [paused.id, "update"]]);
    expect(s.opens.at(-1)?.reminders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: cancelled.id, state: "cancelled", nextRunAt: null }),
      expect.objectContaining({ id: paused.id, state: "paused", nextRunAt: null }),
      expect.objectContaining({ id: fires.id, state: "active", remainingCount: 1, nextRunAt: iso(due + interval) }),
    ]));
    expect(events.filter(event => event.kind === "reminder_fired").map(event => event.noticeId)).toEqual([notice(fires.id, due)]);
    expect((await s.client.reconcileChannel({ channel: channel.id, itemIds: [notice(cancelled.id, due), notice(paused.id, due)] })).items).toEqual([]);
  } finally { await s.rig.clean(); }
}, 15_000);
