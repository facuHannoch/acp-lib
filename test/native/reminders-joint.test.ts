import { expect, test } from "bun:test";
import { spawnHarness } from "../../src/native-harness/test/helpers/stdio.ts";
import { HarnessClientError, type HarnessClient, type ReminderSessionEvent } from "../../src/native-harness/src/client.ts";
import { ReminderClock } from "./fixtures/reminder-clock.ts";
import { hold, nativeRig, reply, until } from "./support.ts";

type Child = ReturnType<typeof spawnHarness>;
type Open = Awaited<ReturnType<HarnessClient["openSession"]>>;

async function joint() {
  const rig = await nativeRig();
  const clock = new ReminderClock();
  clock.time = Date.now();
  const peer = { time: clock.time as number | undefined, fault: undefined as string | undefined,
    lostReply: false, dropWake: false, holdWakeUntilStop: false, current: undefined as Child | undefined };
  const opens: Open[] = [];
  const batches: Array<Parameters<HarnessClient["openSession"]>[0]> = [];
  const children: Child[] = [];
  rig.harness.reminderTimer = clock;
  rig.harness.connect = async () => {
    const child = spawnHarness({ home: rig.home, effects: rig.effectsPath, reminderTime: peer.time, fault: peer.fault });
    children.push(child);
    peer.current = child;
    const client = child.client;
    if (peer.dropWake) client.onReminderWake = () => () => {};
    if (peer.holdWakeUntilStop) {
      const subscribe = client.onReminderWake.bind(client);
      const held: Array<() => void> = [];
      let holding = true;
      client.onReminderWake = listener => subscribe((event: ReminderSessionEvent) => {
        if (holding && event.nextDueAt !== null) held.push(() => listener(event));
        else listener(event);
      });
      const stop = client.stop.bind(client);
      client.stop = () => {
        holding = false;
        for (const notify of held.splice(0)) notify();
        return stop();
      };
    }
    const open = client.openSession.bind(client);
    client.openSession = async params => {
      batches.push(structuredClone(params));
      const opened = await open(params);
      opens.push(opened);
      if (peer.lostReply) {
        child.child.kill("SIGKILL");
        await child.child.exited;
        throw new HarnessClientError("transport_closed", "lost open reply");
      }
      return opened;
    };
    return {
      client, closed: child.child.exited.then(() => undefined),
      async kill() { await child.close().catch(() => {}); },
    };
  };
  return {
    rig, clock, peer, opens, batches,
    async clean() {
      await rig.clean();
      for (const child of children) await child.close().catch(() => {});
    },
  };
}

const pending = (text: string, inMs = 180_000) => ({ text, schedule: { in: inMs } });
const atOf = (row: { schedule: object }) => (row.schedule as { at: number }).at;
const iso = (instant: number) => new Date(instant).toISOString();
const notice = (id: string, at: number) => `reminder-notice:${id}:${iso(at)}`;
const last = <T>(rows: T[]) => rows.at(-1)!;

test("joint startup applies channel edits and three distinct reminder intents before due work", async () => {
  const s = await joint();
  try {
    const agent = await s.rig.open();
    const host = agent.nativeHarness!;
    const a = await agent.conversations.create({ title: "initial channel" });
    const b = await agent.conversations.create();
    const c = await agent.conversations.create({ title: "editable channel" });
    const events = s.rig.watch(b);
    await host.start();
    const cancelled = await a.reminders.create(pending("cancel overdue"));
    const edited = await c.reminders.create(pending("edit overdue", 200_000));
    await host.stop();
    await host.changeChannel(b.id, { displayName: "created in the same open" });
    const created = await b.reminders.create(pending("create due", 220_000));
    await a.reminders.cancel(cancelled.id);
    await c.reminders.update(edited.id, { schedule: { in: 600_000 }, text: "moved" });
    s.peer.time = Math.max(atOf(created), atOf(cancelled), atOf(edited));
    await host.start();
    const opened = last(s.opens);
    expect(opened.channelChanges).toContainEqual(expect.objectContaining({ channel: b.id, outcome: "applied" }));
    expect(opened.reminderChanges?.map(receipt => [receipt.reminderId, receipt.outcome]))
      .toEqual([[created.id, "applied"], [cancelled.id, "applied"], [edited.id, "applied"]]);
    expect(opened.reminders?.map(row => [row.id, row.state])).toEqual(expect.arrayContaining([
      [created.id, "done"], [cancelled.id, "cancelled"], [edited.id, "active"],
    ]));
    expect(opened.reminderRevision).toBe(4);
    expect((await s.peer.current!.client.reconcileChannel({ channel: a.id, itemIds: [notice(cancelled.id, atOf(cancelled))] })).items).toEqual([]);
    expect((await s.peer.current!.client.reconcileChannel({ channel: c.id, itemIds: [notice(edited.id, atOf(edited))] })).items).toEqual([]);
    await until(() => events.some(event => event.kind === "reminder_fired"));
    expect(events.filter(event => event.kind === "reminder_fired")).toHaveLength(1);
  } finally { await s.clean(); }
}, 15_000);

test("joint lost open replays frozen receipts and clears only the newest sent version", async () => {
  const s = await joint();
  try {
    const agent = await s.rig.open();
    const host = agent.nativeHarness!;
    const channel = await agent.conversations.create({ title: "replay channel" });
    const events = s.rig.watch(channel);
    await host.start();
    await host.stop();
    const item = await channel.reminders.create(pending("original"));
    const repo = agent.persistence.reminders!;
    await repo.markMaybeSent(item.id, 1);
    await channel.reminders.update(item.id, { text: "latest" });
    s.peer.lostReply = true;
    await expect(host.start()).rejects.toMatchObject({ code: "transport_closed" });
    expect((await repo.list()).find(row => row.id === item.id)?.changes.map(change => [change.changeId, change.state]))
      .toEqual([[1, "maybe_sent"], [2, "maybe_sent"]]);
    const unacknowledged = last(s.opens);
    const sent = s.batches.at(-1)!.reminderChanges!;
    const acknowledge = repo.acknowledge.bind(repo);
    const seen: unknown[] = [];
    repo.acknowledge = async (...args) => {
      const result = await acknowledge(...args);
      seen.push((await repo.list()).find(row => row.id === item.id)?.changes.map(change => [change.changeId, change.state]));
      return result;
    };
    s.peer.lostReply = false;
    await host.start();
    expect(last(s.opens).reminderChanges).toEqual(unacknowledged.reminderChanges!);
    expect(unacknowledged.reminderRevision).toBe(1);
    expect(last(s.opens).reminderRevision).toBe(1);
    expect(seen).toEqual([[[1, "applied"], [2, "maybe_sent"]], []]);
    expect(last(s.opens).reminders?.filter(row => row.id === item.id)).toEqual([expect.objectContaining({ text: "latest" })]);
    const create = sent.find(entry => entry.op === "create")!;
    expect(await s.peer.current!.client.changeReminder({ ...create, payload: { ...create.payload, text: "changed replay" } }))
      .toMatchObject({ outcome: "blocked", reason: "conflict" });
    await host.stop();
    s.peer.time = atOf(item);
    await host.start();
    expect(last(s.opens)).toMatchObject({ reminderRevision: 2, nextDueAt: null });
    await until(() => events.some(event => event.kind === "reminder_fired"));
    expect(events.filter(event => event.kind === "reminder_fired")).toHaveLength(1);
    expect((await s.peer.current!.client.reconcileChannel({ channel: channel.id, itemIds: [notice(item.id, atOf(item))] })).items).toHaveLength(1);
  } finally { await s.clean(); }
}, 15_000);

test("joint missed deadline event and post-commit death recover from executable open", async () => {
  const s = await joint();
  try {
    s.peer.dropWake = true;
    const agent = await s.rig.open();
    const host = agent.nativeHarness!;
    const channel = await agent.conversations.create({ title: "crash channel" });
    await host.start();
    const item = await channel.reminders.create(pending("atomic notice"));
    const late = await channel.reminders.create({ ...pending("expire without a notice", 240_000), expiresAfter: 300_000 });
    expect((await agent.persistence.reminders!.wake()).reported?.nextDueAt).toBeNull();
    await host.stop();
    s.peer.dropWake = false;
    await host.start();
    expect((await agent.persistence.reminders!.wake()).reported?.nextDueAt).toBe(Math.min(atOf(item), atOf(late)));
    const prior = last(s.opens).reminderRevision!;
    expect(prior).toBe(1);
    await agent.close();
    const actor = Bun.spawn([process.execPath,
      new URL("./fixtures/reminder-crash-owner.ts", import.meta.url).pathname, s.rig.directory, agent.id, String(atOf(item)),
    ], { stdout: "pipe", stderr: "pipe" });
    const stderr = new Response(actor.stderr).text();
    try {
      const stdout = actor.stdout.getReader();
      try {
        const result = await stdout.read();
        if (result.done) throw new Error("Crash fixture exited before barrier: " + await stderr);
        expect(JSON.parse(new TextDecoder().decode(result.value))).toEqual({ code: "transport_closed", harnessExit: 137 });
      } finally { stdout.releaseLock(); }
      actor.kill("SIGKILL");
      expect(await actor.exited).toBe(137);
    } finally { actor.kill("SIGKILL"); await actor.exited; }
    s.peer.time = atOf(late) + 300_000;
    const recovered = await s.rig.open({ id: agent.id });
    expect((await recovered.persistence.reminders!.wake()).reported?.revision).toBe(prior);
    await recovered.nativeHarness!.start();
    const opened = last(s.opens);
    expect(opened.reminderRevision).toBe(3);
    const client = s.peer.current!.client;
    expect((await client.reconcileChannel({ channel: channel.id, itemIds: [notice(item.id, atOf(item))] })).items).toHaveLength(1);
    const expired = opened.reminders?.find(row => row.id === late.id);
    expect(expired?.state).toBe("expired");
    expect((await client.reconcileChannel({ channel: channel.id, itemIds: [notice(late.id, atOf(late))] })).items).toEqual([]);
  } finally { await s.clean(); }
}, 15_000);

test("joint cold wake survives stop and owner close and fires exactly once on the original channel", async () => {
  const s = await joint();
  try {
    s.peer.holdWakeUntilStop = true;
    const first = await s.rig.open();
    const channel = await first.conversations.create({ title: "cold target" });
    await first.nativeHarness!.start();
    const item = await channel.reminders.create(pending("cold notice"));
    const due = atOf(item);
    const repo = first.persistence.reminders!;
    expect((await repo.wake()).reported?.nextDueAt).toBeNull();
    await first.nativeHarness!.stop();
    expect((await repo.wake()).reported?.nextDueAt).toBe(due);
    s.peer.holdWakeUntilStop = false;
    await until(() => s.clock.delays.length === 1, "first owner re-arms after explicit stop");
    expect((await first.persistence.reminders!.wake()).effectiveAt).toBe(due);
    await first.close();
    expect(s.clock.delays).toEqual([]);
    const next = await s.rig.open({ id: first.id });
    const { conversation: reopenedChannel } = await next.conversations.open(channel.id);
    const events = s.rig.watch(reopenedChannel);
    await until(() => s.clock.delays.length === 1, "second owner re-arms the persisted wake");
    s.peer.time = due;
    s.clock.tickAt(due);
    await until(() => next.nativeHarness!.state === "running", "cold wake starts the second owner’s harness");
    await until(() => events.some(event => event.kind === "reminder_fired"), "second owner receives reminder_fired");
    expect(next.nativeHarness!.launches).toBe(1);
    expect(s.clock.delays).toEqual([]);
    expect(events.filter(event => event.kind === "reminder_fired")).toHaveLength(1);
    expect(last(s.opens)).toMatchObject({ nextDueAt: null, reminderRevision: 2 });
    expect((await s.peer.current!.client.listReminders({ channel: channel.id })).reminders).toMatchObject([
      { id: item.id, channel: channel.id, state: "done", noticeId: notice(item.id, due) },
    ]);
    expect((await reopenedChannel.reminders.get(item.id))?.status).toBe("completed");
  } finally { await s.clean(); }
}, 15_000);

test("joint a superseded cold timer and the real harness wall timer yield one firing", async () => {
  const s = await joint();
  try {
    s.peer.time = undefined;
    const agent = await s.rig.open();
    const channel = await agent.conversations.create({ title: "timer race" });
    const events = s.rig.watch(channel);
    const host = agent.nativeHarness!;
    // Capture a queued cold callback, then withdraw its provisional reminder before opening.
    const provisional = await channel.reminders.create(pending("superseded cold wake"));
    await until(() => s.clock.pending.size === 1, "provisional cold timer arms");
    const staleWake = [...s.clock.pending.values()][0]!.task;
    await channel.reminders.cancel(provisional.id);
    await host.start();
    expect(s.clock.delays).toEqual([]);

    // Start the real wall timer on an already running harness. Record revision 1
    // directly so a fast fire can advance to revision 2 before the next read.
    const client = s.peer.current!.client;
    const deadlines: Array<{ revision: number; nextDueAt: string | null }> = [];
    const unsubscribe = client.onReminderWake(({ revision, nextDueAt }) => deadlines.push({ revision, nextDueAt }));
    const due = Date.now() + 1_500;
    const raced = Promise.withResolvers<void>();
    const raceTimer = setTimeout(() => {
      s.clock.time = due;
      staleWake();
      raced.resolve();
    }, Math.max(0, due - Date.now()));
    try {
      expect(await client.changeReminder({ reminderId: "timer-race", changeId: 1, op: "create", payload: {
        channel: channel.id, text: "run once", schedule: { at: iso(due) }, acceptedAt: iso(due - 180_000),
      } })).toMatchObject({ outcome: "applied" });
      await host.reminderSync!.settled();
      expect(s.clock.delays).toEqual([]);
      await Promise.all([raced.promise, until(() => deadlines.some(({ revision }) => revision === 2)
        && events.some(event => event.kind === "reminder_fired"), "real harness fire and deadline advance")]);
      expect(deadlines).toEqual([{ revision: 1, nextDueAt: iso(due) }, { revision: 2, nextDueAt: null }]);
    } finally {
      clearTimeout(raceTimer);
      unsubscribe();
    }
    expect(events.filter(event => event.kind === "reminder_fired")).toHaveLength(1);
    expect(host.launches).toBe(1);
    await host.reminderSync!.settled();
    expect((await agent.persistence.reminders!.wake()).reported).toMatchObject({ revision: 2, nextDueAt: null });
    expect(s.clock.delays).toEqual([]);
  } finally { await s.clean(); }
}, 15_000);

test("joint idle stop refuses busy or near-due work, stops when safe, and restarts for admission and wake", async () => {
  const s = await joint();
  try {
    s.rig.harness.idleStopMs = 1_000;
    s.rig.script([hold("joint-busy", "Working"), reply("done")]);
    // Script calls and reminder notices use the deterministic model fixture.
    const agent = await s.rig.open();
    const host = agent.nativeHarness!;
    const channel = await agent.conversations.create({ title: "idle fence" });
    await host.start();
    const item = await channel.reminders.create(pending("after idle"));
    const due = atOf(item);
    let child = s.peer.current!;
    expect(await child.client.stopIfIdle({ ifIdle: true, unlessDueWithinMs: due - s.peer.time! }))
      .toEqual({ stopped: false, reason: "next_due_soon" });
    expect(host.state).toBe("running");
    const turn = channel.prompt("start hold");
    try {
      await until(() => s.rig.effects().some(entry => entry.includes("start:joint-busy")), "busy tool");
      expect(await child.client.stopIfIdle()).toEqual({ stopped: false, reason: "busy" });
    } finally { s.rig.release("joint-busy"); await Promise.resolve(turn).catch(() => {}); }

    const committed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const request = child.client.request.bind(child.client);
    child.client.request = (async (method, params, signal) => {
      const result = await request(method, params, signal);
      if (method === "session/stop" && (params as { ifIdle?: boolean }).ifIdle) {
        expect(result).toEqual({ stopped: true });
        committed.resolve();
        await release.promise;
      }
      return result;
    }) as typeof child.client.request;
    s.clock.tickAt(s.clock.time + 1_000);
    await committed.promise;
    const sending = host.push({ id: "racing-send", channel: channel.id, sender: "host", text: "racing" });
    release.resolve();
    expect((await sending).id).toBe("racing-send");
    expect(host.launches).toBe(2);
    child = s.peer.current!;
    await until(async () => (await child.client.status()).execution === "idle", "racing admission settled");
    await host.stop();
    await until(() => s.clock.delays.length === 1);
    s.peer.time = due;
    s.clock.tickAt(due);
    await until(() => host.state === "running");
    expect(host.launches).toBe(3);
    expect(last(s.opens)).toMatchObject({ reminderRevision: 2, nextDueAt: null });
    expect((await s.peer.current!.client.getReminder({ id: item.id })).reminder.state).toBe("done");
  } finally { await s.clean(); }
}, 15_000);

test("joint an agent tool reminder reaches the conversation and survives a fresh local cache observation", async () => {
  const s = await joint();
  try {
    s.rig.script([{ content: null, calls: [
      { id: "schedule", name: "schedule_reminder", arguments: { schedule: { in: "5m" }, text: "agent scheduled" } },
    ] }, reply("scheduled")]);
    const agent = await s.rig.open();
    const host = agent.nativeHarness!;
    const channel = await agent.conversations.create({ title: "agent tool" });
    const events = s.rig.watch(channel);
    await channel.prompt("schedule");
    await until(() => events.some(event => event.kind === "reminder_changed"), "agent-created reminder event");
    const event = events.find(value => value.kind === "reminder_changed")!;
    expect(event.reminder).toMatchObject({ channel: channel.id, createdBy: "agent", text: "agent scheduled" });
    const id = event.reminder.id as string;
    expect((await agent.persistence.reminders!.list()).find(row => row.id === id)?.highWater).toBe(0);
    await host.stop();
    await host.start();
    expect(last(s.opens)).toMatchObject({ reminderRevision: 1 });
    expect(await channel.reminders.get(id)).toMatchObject({ createdBy: "agent", status: "active", text: "agent scheduled" });
  } finally { await s.clean(); }
}, 15_000);

test("joint deleting an offline conversation removes pending work and prevents orphan cache rows", async () => {
  const s = await joint();
  try {
    const agent = await s.rig.open();
    const host = agent.nativeHarness!;
    const deleted = await agent.conversations.create({ title: "deleted channel" });
    await host.start();
    await host.stop();
    const item = await deleted.reminders.create(pending("must not fire"));
    await agent.conversations.delete(deleted.id);
    expect((await agent.persistence.reminders!.list()).some(row => row.conversationId === deleted.id)).toBe(false);
    s.peer.time = atOf(item);
    await host.start();
    expect(last(s.batches)?.reminderChanges).toBeUndefined();
    expect(last(s.opens)).toMatchObject({ reminderRevision: 0, nextDueAt: null, reminders: [] });
    await expect(s.peer.current!.client.getReminder({ id: item.id })).rejects.toMatchObject({ code: "not_found" });
  } finally { await s.clean(); }
}, 15_000);

test("joint suspended channel holds due work outside the wake until resumed", async () => {
  const s = await joint();
  try {
    const agent = await s.rig.open();
    const host = agent.nativeHarness!;
    const channel = await agent.conversations.create({ title: "suspended" });
    await host.start();
    const item = await channel.reminders.create(pending("held reminder"));
    const due = atOf(item);
    await host.stop();
    await host.changeChannel(channel.id, { lifecycle: "suspended" });
    s.peer.time = due;
    await host.start();
    expect(last(s.opens)).toMatchObject({ reminderRevision: 2, nextDueAt: null });
    expect((await s.peer.current!.client.getReminder({ id: item.id })).reminder.state).toBe("active");
    await host.stop();
    expect(s.clock.delays).toEqual([]);
    expect((await agent.persistence.reminders!.wake()).effectiveAt).toBeNull();
    await host.changeChannel(channel.id, { lifecycle: "open" });
    await host.start();
    expect(last(s.opens).reminderRevision).toBe(4);
    expect((await s.peer.current!.client.getReminder({ id: item.id })).reminder.state).toBe("done");
    expect((await s.peer.current!.client.reconcileChannel({ channel: channel.id, itemIds: [notice(item.id, due)] })).items).toHaveLength(1);
  } finally { await s.clean(); }
}, 15_000);

test("joint default and explicit grace expire at the boundary while null still delivers late", async () => {
  const s = await joint();
  try {
    const agent = await s.rig.open();
    const host = agent.nativeHarness!;
    const channel = await agent.conversations.create({ title: "expiry options" });
    const events = s.rig.watch(channel);
    await host.start();
    const defaulted = await channel.reminders.create(pending("default grace"));
    const explicit = await channel.reminders.create({ ...pending("explicit grace"), expiresAfter: 300_000 });
    const unlimited = await channel.reminders.create({ ...pending("unlimited grace"), expiresAfter: null });
    const before = (await s.peer.current!.client.listReminders()).reminders;
    const def = before.find(row => row.id === defaulted.id)!;
    const exp = before.find(row => row.id === explicit.id)!;
    expect(def.expiresAfter).toBe(360_000);
    expect(exp.expiresAfter).toBe(300_000);
    expect(before.find(row => row.id === unlimited.id)?.expiresAt).toBeNull();
    await host.stop();
    s.peer.time = Math.max(Date.parse(def.expiresAt!), Date.parse(exp.expiresAt!));
    await host.start();
    expect(last(s.opens)).toMatchObject({ reminderRevision: 2, nextDueAt: null });
    expect(last(s.opens).reminders?.map(row => row.state)).toEqual(["expired", "expired", "done"]);
    await until(() => events.filter(event => event.kind === "reminder_expired").length === 2
      && events.some(event => event.kind === "reminder_fired"), "expiry and fire notifications");
    expect(events.filter(event => event.kind === "reminder_expired")).toHaveLength(2);
    expect(events.filter(event => event.kind === "reminder_fired")).toHaveLength(1);
    const ids = [defaulted, explicit, unlimited].map(item => notice(item.id, atOf(item)));
    const { items } = await s.peer.current!.client.reconcileChannel({ channel: channel.id, itemIds: ids });
    expect(items.map(item => item.id)).toEqual([ids[2]]);
  } finally { await s.clean(); }
}, 15_000);

test("joint production launcher delivers one fire, deadline update, cache change and notice", async () => {
  const rig = await nativeRig();
  const clock = new ReminderClock();
  clock.time = Date.now();
  rig.harness.reminderTimer = clock;
  try {
    const agent = await rig.open();
    const channel = await agent.conversations.create({ title: "production notification path" });
    const events = rig.watch(channel);
    const repo = agent.persistence.reminders!;
    const host = agent.nativeHarness!;
    await host.start();
    expect(clock.delays).toEqual([]);
    expect(rig.launches.map(launch => launch.kind)).toEqual(["native-harness"]);

    const seen = { fire: 0, deadlines: [] as Array<{ revision: number; nextDueAt: string | null }> };
    const sync = host.reminderSync!;
    const notify = sync.notification.bind(sync);
    sync.notification = (notification, emit) => {
      if ("deadline" in notification) seen.deadlines.push(notification.deadline);
      else if (notification.event.kind === "reminder_fired") seen.fire++;
      notify(notification, emit);
    };
    const id = "production-fire";
    const due = Date.now() + 1_500;
    const acceptedAt = due - 180_000;
    const change = await repo.enqueue({ op: "create", acceptedAt, reminder: {
      id, conversationId: channel.id, text: "production reminder", status: "active",
      schedule: { at: due }, scheduleAcceptedAt: acceptedAt, expiryPolicy: { kind: "default" }, expiry: null,
    } });
    expect(await host.changeReminder({
      reminderId: id, changeId: change!.changeId, op: "create",
      payload: { channel: channel.id, text: "production reminder", schedule: { at: iso(due) }, acceptedAt: iso(acceptedAt) },
    })).toMatchObject({ confirmed: { id } });
    await until(() => events.some(event => event.kind === "reminder_fired")
      && seen.deadlines.some(({ revision }) => revision === 2), "production reminder fire and deadline");
    const noticeId = notice(id, due);
    const result = await host.reconcileChannel({ channel: channel.id, itemIds: [noticeId] });
    await sync.settled();
    expect(seen).toEqual({ fire: 1, deadlines: [
      { nextDueAt: iso(due), revision: 1 }, { nextDueAt: null, revision: 2 },
    ] });
    expect(events.filter(event => event.kind === "reminder_fired")).toHaveLength(1);
    expect((await repo.wake()).reported).toMatchObject({ revision: 2, nextDueAt: null });
    const cache = (await repo.list()).find(row => row.id === id)!;
    expect(events.filter(event => event.kind === "reminder_changed")).toHaveLength(1);
    expect(cache.observation).toBe(2); // One observation for creation and one for the fire.
    expect(cache.confirmed).toMatchObject({ status: "completed", noticeId });
    expect(result.items.map(item => item.id)).toEqual([noticeId]);
  } finally { await rig.clean(); }
}, 15_000);

test("joint explicit stop adopts a starting connection, drains its deadline and drops its channel event", async () => {
  const rig = await nativeRig();
  const clock = new ReminderClock();
  clock.time = Date.now();
  rig.harness.reminderTimer = clock;
  const connecting = Promise.withResolvers<void>();
  const connect = Promise.withResolvers<void>();
  const stoppedRpc = Promise.withResolvers<void>();
  let writing = false;
  const write = Promise.withResolvers<void>();
  const id = "stopping-connection";
  const due = clock.time + 180_000;
  let channelId: string;
  let launches = 0;
  let killed = false;
  rig.harness.connect = async () => {
    const first = ++launches === 1;
    if (first) {
      connecting.resolve();
      await connect.promise;
    }
    const child = spawnHarness({ home: rig.home, reminderTime: clock.time });
    if (first) {
      const stop = child.client.stop.bind(child.client);
      child.client.stop = async () => {
        expect(await child.client.changeReminder({ reminderId: id, changeId: 1, op: "create", payload: {
          channel: channelId, text: "committed while stopping", acceptedAt: iso(clock.time), schedule: { at: iso(due) },
        } })).toMatchObject({ outcome: "applied" });
        const result = await stop();
        stoppedRpc.resolve();
        return result;
      };
    }
    return {
      client: child.client, closed: child.child.exited.then(() => undefined),
      async kill() {
        if (first) killed = true;
        await child.close().catch(() => {});
      },
    };
  };

  try {
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const channel = await agent.conversations.create({ title: "stop adopts connection" });
    channelId = channel.id;
    const events = rig.watch(channel);
    const repo = agent.persistence.reminders!;
    const update = repo.updateDeadline.bind(repo);
    repo.updateDeadline = async (deadline, replace) => {
      if (deadline.nextDueAt === due) {
        writing = true;
        await write.promise;
      }
      return update(deadline, replace);
    };
    const starting = host.start();
    await connecting.promise;
    const stopping = host.stop();
    connect.resolve();
    await starting;
    await stoppedRpc.promise;
    await until(() => writing, "deadline write was reached", 2_000);
    // The stop response has arrived, but that notification is still blocked in persistence.
    await Bun.sleep(0);
    expect(killed).toBe(false);
    expect((await repo.wake()).reported?.nextDueAt).toBeNull();
    expect(events.filter(event => event.kind === "reminder_changed")).toEqual([]);
    expect(await repo.list()).toEqual([]);
    write.resolve();
    await stopping;
    expect(killed).toBe(true);
    expect((await repo.wake()).reported).toMatchObject({ revision: 1, nextDueAt: due });
    await host.start();
    expect((await repo.list()).find(row => row.id === id)?.confirmed)
      .toMatchObject({ text: "committed while stopping", status: "active" });
    expect(events.filter(event => event.kind === "reminder_changed")).toEqual([]);
  } finally {
    connect.resolve();
    write.resolve();
    await rig.clean();
  }
}, 15_000);
