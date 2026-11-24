import { expect, test } from "bun:test";
import { createAgentConversationId, createAgentSessionId } from "../../src/agent-ids.ts";
import { noopLogger } from "../../src/logger.ts";
import { openOrCreate } from "../../src/native/recovery.ts";
import { ReminderService } from "../../src/native/reminders/service.ts";
import { ReminderSync } from "../../src/native/reminders/sync.ts";
import { reminderRequest, type WireReminderEvent } from "../../src/native/reminders/wire.ts";
import { SqliteAgentPersistence } from "../../src/persistence/sqlite-backend.ts";
import { ReminderPeer } from "./fixtures/reminder-peer.ts";

async function setup() {
  const agentSessionId = createAgentSessionId();
  const channel = createAgentConversationId();
  const backend = await SqliteAgentPersistence.open({ path: ":memory:", agentSessionId });
  await backend.conversations.create({ agentSessionId, agentConversationId: channel, controllerKind: "native" });
  const service = new ReminderService({ persistence: backend, now: () => 1_000_000 });
  const sync = new ReminderSync(backend, backend.reminders, noopLogger);
  const peer = new ReminderPeer();
  const reminders = service.conversation(channel, true, () => {});
  const initialize = () => sync.initialize({ capabilities: { reminders: true }, reminderLimits: { maxActiveRoutinesPerChannel: 0 } });
  const open = () => openOrCreate(peer.client, { sessionId: agentSessionId, config: {
    version: 1, system: "", model: { protocol: "scripted", script: "" },
    defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } },
  } }, [{ channel, changeId: "1", displayName: "Reminder tests" }], undefined, new AbortController().signal, sync);
  return { backend, channel, sync, peer, reminders, open, initialize };
}

const input = { text: "one-off", schedule: { in: 180_000 } };

test("open applies channels before strict reminder entries and drains the bounded remainder", async () => {
  const s = await setup();
  try {
    await s.initialize();
    const ids: string[] = [];
    for (let index = 0; index < 101; index++) ids.push((await s.reminders.create(input)).id);
    await s.open();
    expect(s.peer.traffic[0]?.method).toBe("session/open");
    expect((s.peer.traffic[0]?.params.reminderChanges as any[]).map(row => row.reminderId)).toEqual(ids.slice(0, 100));
    expect(s.peer.rows.size).toBe(100);
    expect(s.peer.rows.get(ids[0]!)?.channel).toBe(s.channel);
    await s.sync.dispatch(s.peer.client);
    expect([...s.peer.rows.keys()]).toEqual(ids);
    expect((await s.backend.reminders.list()).flatMap(row => row.changes)).toHaveLength(0);
  } finally {
    await s.backend.close();
  }
});

test("an unencodable entry and a rejected batch are quarantined without bricking open", async () => {
  const s = await setup();
  try {
    await s.initialize();
    const good = await s.reminders.create(input);
    await s.backend.reminders.enqueue({ op: "create", acceptedAt: 0, reminder: {
      ...good, id: "invalid", schedule: { at: 0 }, scheduleAcceptedAt: 0,
    } });
    s.peer.rejectBatch = true;
    await s.open();
    const requests = s.peer.traffic.filter(({ method }) => method === "session/open");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.params.reminderChanges).toEqual([expect.objectContaining({ reminderId: good.id })]);
    expect(requests[1]?.params).not.toHaveProperty("reminderChanges");
    expect(s.peer.channelOrder).toEqual([s.channel]);
    expect(await s.reminders.get("invalid")).toMatchObject({ state: "blocked", reason: "invalid_local_entry" });
    expect(await s.reminders.get(good.id)).toMatchObject({ state: "blocked", reason: "invalid_params" });
  } finally {
    await s.backend.close();
  }
});

test("strict patches preserve schedule anchor and apply default or explicit grace", async () => {
  const s = await setup();
  try {
    await s.initialize();
    const result = await s.reminders.create(input);
    await s.reminders.update(result.id, { text: "new" });
    await s.open();
    const initial = s.peer.rows.get(result.id)!;
    expect(initial.expiresAfter).toBe(360_000);
    expect(initial.text).toBe("new");
    await s.reminders.update(result.id, { schedule: { in: 240_000 } });
    const [edit] = await s.sync.stage();
    expect(edit!.payload).toEqual({ schedule: { at: new Date(1_240_000).toISOString() }, acceptedAt: new Date(1_000_000).toISOString() });
    await s.sync.dispatch(s.peer.client);
    expect(s.peer.rows.get(result.id)?.expiresAfter).toBe(480_000);
    await s.reminders.update(result.id, { expiresAfter: null });
    await s.sync.dispatch(s.peer.client);
    await s.reminders.update(result.id, { schedule: { in: 300_000 } });
    await s.sync.dispatch(s.peer.client);
    expect(s.peer.rows.get(result.id)?.expiresAt).toBeNull();
  } finally {
    await s.backend.close();
  }
});

test("exact receipts replay before high water and preserve a newer observed cache row", async () => {
  const s = await setup();
  try {
    await s.initialize();
    const item = await s.reminders.create(input);
    const [create] = await s.sync.stage();
    s.peer.channelOrder.push(s.channel);
    const receipt = s.peer.apply(create!);
    const newer = { ...receipt.reminder!, text: "newer event" };
    const events: WireReminderEvent[] = [];
    s.sync.notification({ channel: s.channel, event: { kind: "reminder_changed", reminder: newer } }, (_, event) => events.push(event));
    await s.sync.settled();
    await s.sync.dispatch(s.peer.client);
    expect((await s.backend.reminders.list())[0]?.confirmed?.text).toBe("newer event");
    expect(events).toEqual([{ kind: "reminder_changed", reminder: newer }]);
    expect(s.peer.apply({ ...create!, changeId: 3 }).outcome).toBe("applied");
    expect(s.peer.apply(create!)).toEqual(receipt);
    expect(s.peer.apply({ ...create!, changeId: 2 }).reason).toBe("stale");
    expect(s.peer.apply({ ...create!, changeId: 4, payload: { ...create!.payload, text: "different" } }).reason).toBe("conflict");
    expect(s.peer.apply({ ...create!, reminderId: "missing", op: "update", payload: { text: "edit" } }).reason).toBe("not_found");
    expect(await s.reminders.get(item.id)).toMatchObject({ text: "newer event" });
  } finally {
    await s.backend.close();
  }
});

test("unsupported negotiations and routine refusal keep queued changes out of the wake and wire", async () => {
  const s = await setup();
  try {
    await expect(s.reminders.create({ ...input, schedule: { every: 600_000 } })).rejects.toMatchObject({ code: "routines_unavailable" });
    await expect(s.reminders.create({ ...input, schedule: { cron: "* * * * *", timezone: "UTC" } })).rejects.toMatchObject({ code: "routines_unavailable" });
    expect(await s.backend.reminders.list()).toEqual([]);
    await s.reminders.create(input);
    await s.sync.initialize({ capabilities: {} });
    expect(await s.sync.stage()).toEqual([]);
    expect((await s.backend.reminders.wake()).effectiveAt).toBeNull();
    expect((await s.backend.reminders.list())[0]?.changes[0]?.state).toBe("pending");
  } finally {
    await s.backend.close();
  }
});

test("wire snapshots seed agent-created reminders and expiry events skip deleted channels", async () => {
  const s = await setup();
  try {
    await s.initialize();
    const item = await s.reminders.create(input);
    const [row] = await s.backend.reminders.list();
    const create = reminderRequest(row!.changes[0]!);
    s.peer.channelOrder.push(s.channel);
    const receipt = s.peer.apply({ ...create, reminderId: "agent-origin" });
    s.peer.rows.set("agent-origin", { ...receipt.reminder!, createdBy: "agent" });
    await s.sync.refresh(s.peer.client);
    expect(await s.reminders.get("agent-origin")).toMatchObject({ createdBy: "agent" });
    const event = { kind: "reminder_expired", reminderId: "agent-origin", occurrenceId: "o",
      scheduledAt: receipt.reminder!.schedule.at, expiredAt: receipt.reminder!.expiresAt! } as const;
    const events: WireReminderEvent[] = [];
    s.sync.notification({ channel: s.channel, event }, (_, value) => events.push(value));
    await s.sync.settled();
    expect(events).toEqual([event]);
    expect(await s.reminders.get("agent-origin")).toMatchObject({ status: "expired" });
    await s.backend.transaction(async scope => {
      await scope.reminders!.deleteConversation(s.channel);
      await scope.conversations.delete(s.channel);
    });
    await s.sync.refresh(s.peer.client);
    expect(await s.backend.reminders.list()).toEqual([]);
    expect(item.id).not.toBe("agent-origin");
  } finally {
    await s.backend.close();
  }
});

test("a same-session reconnect preserves the fence and a confirmed fresh create replaces it", async () => {
  const s = await setup();
  try {
    await s.initialize();
    s.peer.revision = 4;
    s.peer.nextDueAt = "1970-01-01T01:00:00.000Z";
    await s.open();
    s.peer.revision = 3;
    s.peer.nextDueAt = null;
    await s.open();
    expect((await s.backend.reminders.wake()).reported?.revision).toBe(4);
    s.sync.notification({ deadline: { revision: 4, nextDueAt: null } }, () => {});
    await s.sync.settled();
    expect((await s.backend.reminders.wake()).effectiveAt).toBe(3_600_000);
    s.peer.fresh = true;
    s.peer.revision = 0;
    await s.open();
    expect((await s.backend.reminders.wake()).reported).toEqual({ sessionId: s.peer.sessionId, revision: 0, nextDueAt: null });
  } finally { await s.backend.close(); }
});

test("cursor invalidation retries within the sweep budget without marking absent rows", async () => {
  const s = await setup();
  try {
    await s.initialize();
    const item = await s.reminders.create(input);
    await s.open();
    const original = s.peer.rows.get(item.id)!;
    s.peer.rows.delete(item.id);
    for (let index = 0; index < 51; index++) {
      const id = "agent-" + index;
      s.peer.rows.set(id, { ...original, id, createdBy: "agent" });
    }
    s.peer.invalidatePages = 3;
    await s.sync.refresh(s.peer.client);
    expect(s.sync.unreconciled).toBe(true);
    expect((await s.reminders.get(item.id))?.missing).toBeUndefined();
    await s.sync.refresh(s.peer.client);
    expect(s.sync.unreconciled).toBe(false);
    expect((await s.reminders.get(item.id))?.missing).toBe(true);
  } finally { await s.backend.close(); }
});

test("pending and maybe-sent cancels reject edits, pause and resume with conflict", async () => {
  const s = await setup();
  try {
    await s.initialize();
    const item = await s.reminders.create(input);
    await s.open();
    await s.reminders.cancel(item.id);
    for (const sent of [false, true]) {
      if (sent) await s.sync.stage();
      for (const operation of [s.reminders.pause, s.reminders.resume, (id: string) => s.reminders.update(id, { text: "edit" })]) {
        await expect(operation(item.id)).rejects.toMatchObject({ code: "conflict" });
      }
    }
  } finally { await s.backend.close(); }
});
