import { expect, test } from "bun:test";
import { createAgentConversationId } from "../../src/agent-ids.ts";
import type { ChannelPort } from "../../src/native/host.ts";
import { nativeRig, until } from "./support.ts";
import { ReminderClock } from "./fixtures/reminder-clock.ts";
import { ReminderPeer } from "./fixtures/reminder-peer.ts";

async function setup() {
  const fixture = await nativeRig();
  const clock = new ReminderClock();
  const peer = new ReminderPeer();
  peer.now = Date.now();
  clock.time = peer.now;
  fixture.harness.connect = () => peer.connect();
  fixture.harness.reminderTimer = clock;
  fixture.harness.idleStopMs = 1_000;
  fixture.harness.idleStopWindowMs = 5_000;
  const agent = await fixture.open();
  const host = agent.nativeHarness!;
  const stopCalls = () => peer.traffic.filter(({ method, params }) => method === "session/stop" && params.ifIdle === true);
  return { fixture, clock, peer, agent, host, stopCalls };
}

test("idle stop uses the largest pending conversation window and respects an inclusive due boundary", async () => {
  const s = await setup();
  try {
    const first = await s.agent.conversations.create({ runtime: { idleStopWindowMs: 90_000 } });
    const second = await s.agent.conversations.create({ runtime: { idleStopWindowMs: 140_000 } });
    s.peer.channelOrder.push(first.id, second.id);
    await first.reminders.create({ text: "first", schedule: { in: 141_000 } });
    await second.reminders.create({ text: "second", schedule: { in: 141_000 } });
    s.peer.nextDueAt = new Date(s.peer.now + 141_000).toISOString();
    await s.host.start();
    s.peer.now += 1_000;
    s.clock.tickAt(s.peer.now);
    await until(() => s.stopCalls().length === 1);
    expect(s.stopCalls()[0]?.params).toEqual({ ifIdle: true, unlessDueWithinMs: 140_000 });
    expect(s.host.state).toBe("running");
    await until(() => s.clock.delays.length === 1);
    expect(s.clock.delays[0]).toBeGreaterThan(1_000);
  } finally { await s.fixture.clean(); }
});

test("idle stop reads deadline notifications ahead of the reply and rearms cold wake", async () => {
  const s = await setup();
  try {
    const deadline = s.peer.now + 4_000;
    s.peer.beforeIdleStop = async () => {
      s.peer.nextDueAt = new Date(deadline).toISOString();
      s.peer.revision++;
      s.peer.emit({ deadline: { nextDueAt: s.peer.nextDueAt, revision: s.peer.revision } });
    };
    await s.host.start();
    s.peer.now += 1_000;
    s.clock.tickAt(s.peer.now);
    await until(() => s.host.state === "stopped" && s.clock.delays.length === 1);
    expect((await s.agent.persistence.reminders!.wake()).effectiveAt).toBe(deadline);
    expect(s.clock.delays).toEqual([3_000]);
    s.clock.tickAt(deadline);
    await until(() => s.host.state === "running");
    expect(s.host.launches).toBe(2);
  } finally { await s.fixture.clean(); }
});

test("a send racing an idle stop waits then shares one restart", async () => {
  const s = await setup();
  const entered = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  try {
    s.peer.beforeIdleStop = async () => { entered.resolve(); await reply.promise; };
    await s.host.start();
    s.clock.tickAt(s.peer.now + 1_000);
    await entered.promise;
    const channel = createAgentConversationId();
    const send = s.host.push({ id: "racing", channel, sender: "user", text: "restart" });
    const start = s.host.start();
    expect(s.peer.traffic.some(({ method }) => method === "channel/push")).toBe(false);
    reply.resolve();
    await start;
    expect((await send).id).toBe("racing");
    expect(s.host.launches).toBe(2);
    expect(s.peer.traffic.filter(({ method }) => method === "channel/push")).toHaveLength(1);
  } finally {
    reply.resolve();
    await s.fixture.clean();
  }
});

test("local held work prevents idle RPC and a harness busy refusal leaves it running", async () => {
  const s = await setup();
  try {
    let busy = true;
    const port: ChannelPort = {
      event() {}, reconcile() {}, failed() {}, disconnected() {}, busy: () => busy,
    };
    s.host.attach(createAgentConversationId(), port);
    await s.host.start();
    s.clock.tickAt(s.peer.now + 1_000);
    await until(() => s.clock.delays.length === 1);
    expect(s.stopCalls()).toHaveLength(0);
    busy = false;
    s.peer.busy = true;
    s.clock.tickAt(s.peer.now + 3_000);
    await until(() => s.stopCalls().length === 1 && s.clock.delays.length === 1);
    expect(s.host.state).toBe("running");
    expect(s.clock.delays[0]).toBeGreaterThan(1_000);
  } finally { await s.fixture.clean(); }
});

test("pending approval, channel intents and reminder intents each prevent idle stop", async () => {
  const s = await setup();
  try {
    const conversation = await s.agent.conversations.create();
    s.peer.channelOrder.push(conversation.id);
    await s.host.start();
    s.peer.channelEvent({ channel: conversation.id, event: {
      type: "approval_requested", turnId: "turn", requestId: "approval", channel: conversation.id,
      toolCallId: "tool", tool: "check", arguments: "{}",
    } as never });
    s.clock.tickAt(s.peer.now + 1_000);
    await until(() => s.clock.delays.length === 1);
    expect(s.stopCalls()).toHaveLength(0);
    s.peer.channelEvent({ channel: conversation.id, event: {
      type: "approval_closed", turnId: "turn", requestId: "approval", reason: "dispatched",
    } });
    const held = await s.agent.persistence.channels!.desire(conversation.id, { displayName: "held" });
    s.clock.tickAt(s.peer.now + 2_000);
    await until(() => s.clock.delays.length === 1);
    expect(s.stopCalls()).toHaveLength(0);
    await s.agent.persistence.channels!.confirmChange(conversation.id, held.version);
    const repository = s.agent.persistence.reminders!;
    await repository.enqueue({ op: "create", acceptedAt: s.peer.now, reminder: {
      id: "held", conversationId: conversation.id, text: "held", status: "active",
      schedule: { at: s.peer.now + 180_000 }, expiryPolicy: { kind: "default" }, expiry: null,
    } });
    s.clock.tickAt(s.peer.now + 4_000);
    await until(() => s.clock.delays.length === 1);
    expect(s.stopCalls()).toHaveLength(0);
    await repository.deleteConversation(conversation.id);
    s.clock.tickAt(s.peer.now + 8_000);
    await until(() => s.host.state === "stopped");
    expect(s.stopCalls()).toHaveLength(1);
  } finally { await s.fixture.clean(); }
});

test("the owned conversation receives separate live intent and wire events", async () => {
  const s = await setup();
  try {
    const conversation = await s.agent.conversations.create();
    s.peer.channelOrder.push(conversation.id);
    await s.host.start();
    const eventKinds: string[] = [];
    conversation.subscribe(({ event }) => eventKinds.push(event.kind));
    const item = await conversation.reminders.create({ text: "live", schedule: { in: 180_000 }, expiresAfter: 300_000 });
    expect(item.state).toBe("confirmed");
    const row = s.peer.rows.get(item.id)!;
    expect(item.expiry).toMatchObject({ at: Date.parse(row.expiresAt!) });
    s.peer.emit({ channel: conversation.id, event: { kind: "reminder_changed", reminder: { ...row, text: "wire" } } });
    const notification = { kind: "reminder_fired", reminderId: row.id, occurrenceId: "occurrence",
      noticeId: "notice", scheduledAt: row.schedule.at, firedAt: row.schedule.at } as const;
    s.peer.emit({ channel: conversation.id, event: notification });
    s.peer.emit({ channel: conversation.id, event: notification });
    await s.host.reminderSync!.settled();
    expect(eventKinds.filter(kind => kind.startsWith("reminder"))).toEqual([
      "reminder_intent_recorded", "reminder_intent_confirmed", "reminder_changed", "reminder_fired",
    ]);
    expect((await s.agent.persistence.reminders!.list())[0]?.confirmed).toMatchObject({ text: "wire", status: "completed" });
  } finally { await s.fixture.clean(); }
});
