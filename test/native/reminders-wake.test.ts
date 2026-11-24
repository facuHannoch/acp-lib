import { expect, test } from "bun:test";
import { NativeHarnessHost, HarnessIncompatibleError, HarnessUnavailableError, type NativeHostState } from "../../src/native/host.ts";
import { createAgentReminderService } from "../../src/native/reminders/service.ts";
import { ReminderWakeSupervisor } from "../../src/native/reminders/supervisor.ts";
import { SqliteAgentPersistence } from "../../src/persistence/sqlite-backend.ts";
import { nativeRig, until } from "./support.ts";
import { ReminderClock } from "./fixtures/reminder-clock.ts";

import { HarnessClientError } from "../../src/native-harness/src/client.ts";
import { ReminderPeer } from "./fixtures/reminder-peer.ts";
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function wakeRig() {
  const clock = new ReminderClock();
  let host: NativeHostState = "stopped";
  let due: number | null = null;
  let starts = 0;
  let subscribe = () => {};
  const wake = new ReminderWakeSupervisor({
    state: () => host,
    index: async () => ({ reported: null, effectiveAt: due }),
    subscribe: callback => { subscribe = callback; return () => { subscribe = () => {}; }; },
    start: async () => { starts++; host = "running"; },
    error: error => { throw error; },
  }, clock);
  return {
    clock, wake, get starts() { return starts; },
    async set(deadline: number | null, state: NativeHostState = host) {
      due = deadline;
      host = state;
      subscribe();
      await settle();
    },
  };
}

test("cold wake clamps long waits and rechecks early and backward clock wakes", async () => {
  const rig = wakeRig();
  try {
    await rig.set(180_000);
    expect(rig.clock.delays).toEqual([60_000]);
    rig.clock.tickAt(60_000);
    await settle();
    expect(rig.clock.delays).toEqual([60_000]);
    rig.clock.tickAt(30_000);
    await settle();
    expect(rig.clock.delays).toEqual([60_000]);
    rig.clock.tickAt(180_000);
    await settle();
    expect(rig.starts).toBe(1);
    expect(rig.clock.delays).toEqual([]);
  } finally { rig.wake.close(); }
});

test("running harness with a past deadline has no cold timer, and stopping rearms it", async () => {
  const rig = wakeRig();
  try {
    rig.clock.time = 10_000;
    await rig.set(1_000, "running");
    expect(rig.clock.delays).toEqual([]);
    await rig.set(1_000, "stopped");
    expect(rig.clock.delays).toEqual([1_000]);
    rig.clock.tickAt(11_000);
    await settle();
    expect(rig.starts).toBe(1);
    expect(rig.clock.delays).toEqual([]);
  } finally { rig.wake.close(); }
});

test("closing a cold wake before an in-flight index read prevents launch", async () => {
  const clock = new ReminderClock();
  const barrier = Promise.withResolvers<{ reported: null; effectiveAt: number }>();
  let reads = 0, launches = 0;
  const wake = new ReminderWakeSupervisor({
    state: () => "stopped",
    index: () => ++reads === 1 ? Promise.resolve({ reported: null, effectiveAt: 1_000 }) : barrier.promise,
    subscribe: () => () => {},
    start: async () => { launches++; },
    error: error => { throw error; },
  }, clock);
  await settle();
  clock.tickAt(1_000);
  wake.close();
  barrier.resolve({ reported: null, effectiveAt: 1_000 });
  await settle();
  expect(launches).toBe(0);
  expect(clock.delays).toEqual([]);
});

test("only a file SQLite owner installs a cold wake supervisor", async () => {
  const fixture = await nativeRig();
  const memory = await SqliteAgentPersistence.open({ path: ":memory:" });
  try {
    const agent = await fixture.open();
    const host = new NativeHarnessHost({ sessionId: "memory", config: {} as never, home: "", reminderTimer: new ReminderClock() });
    createAgentReminderService(host, memory);
    expect(host.reminderWake).toBeUndefined();
    expect(agent.nativeHarness?.reminderWake).toBeDefined();
  } finally {
    await memory.close();
    await fixture.clean();
  }
});

test("overdue cold starts share manual startup and failed wakes exhaust the shared budget", async () => {
  const fixture = await nativeRig();
  const clock = new ReminderClock();
  let attempts = 0;
  let gate = Promise.withResolvers<never>();
  fixture.harness.reminderTimer = clock;
  fixture.harness.connect = () => { attempts++; return gate.promise; };
  try {
    const agent = await fixture.open();
    const host = agent.nativeHarness!;
    await agent.persistence.reminders!.updateDeadline({ sessionId: "test", nextDueAt: 0, revision: 1 });
    await until(() => clock.delays.length === 1);
    expect(clock.delays).toEqual([1_000]);
    clock.tickAt(1_000);
    await until(() => attempts === 1);
    const manual = host.start();
    gate.reject(new Error("launch failed"));
    await expect(manual).rejects.toMatchObject({ message: "launch failed" });
    for (let count = 2; count <= 3; count++) {
      gate = Promise.withResolvers<never>();
      await until(() => clock.delays.length === 1);
      clock.tickAt(count * 1_000);
      await until(() => attempts === count);
      gate.reject(new Error("launch failed"));
      await until(() => host.state === "stopped");
    }
    await until(() => clock.delays.length === 1);
    clock.tickAt(4_000);
    await until(() => host.failure !== null);
    expect(host.state).toBe("stopped");
    expect(host.failure).toBeInstanceOf(HarnessUnavailableError);
    expect(attempts).toBe(3);
    expect(clock.delays).toEqual([]);
    expect((await agent.persistence.reminders!.wake()).effectiveAt).toBe(0);
    gate = Promise.withResolvers<never>();
    const explicit = host.start();
    await until(() => attempts === 4);
    expect(host.failure).toBeNull();
    gate.reject(new Error("manual launch attempted"));
    await expect(explicit).rejects.toThrow("manual launch attempted");
  } finally { await fixture.clean(); }
});

test("explicit stop retains an overdue wake and agent close leaves it for the next owner", async () => {
  const fixture = await nativeRig();
  const firstClock = new ReminderClock();
  fixture.harness.reminderTimer = firstClock;
  try {
    const first = await fixture.open();
    await first.persistence.reminders!.updateDeadline({ sessionId: first.id, nextDueAt: 0, revision: 1 });
    await until(() => firstClock.delays.length === 1);
    await first.nativeHarness!.stop();
    await until(() => firstClock.delays.length === 1);
    expect(firstClock.delays).toEqual([1_000]);
    await first.close();
    expect(firstClock.delays).toEqual([]);
    const nextClock = new ReminderClock();
    fixture.harness.reminderTimer = nextClock;
    const next = await fixture.open({ id: first.id });
    await until(() => nextClock.delays.length === 1);
    expect(nextClock.delays).toEqual([1_000]);
    expect((await next.persistence.reminders!.wake()).effectiveAt).toBe(0);
  } finally { await fixture.clean(); }
});

test("an exhausted reminder wake still fails outstanding conversation work", async () => {
  const fixture = await nativeRig();
  const clock = new ReminderClock();
  fixture.harness.reminderTimer = clock;
  fixture.harness.restart = { limit: 0, windowMs: 60_000 };
  try {
    const agent = await fixture.open();
    const host = agent.nativeHarness!;
    const errors: Error[] = [];
    host.attach("held", {
      busy: () => true, failed: error => errors.push(error), reconcile() {}, event() {}, disconnected() {},
    });
    await agent.persistence.reminders!.updateDeadline({ sessionId: "test", nextDueAt: 0, revision: 1 });
    await until(() => clock.delays.length === 1);
    clock.tickAt(1_000);
    await until(() => host.state === "failed");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(HarnessUnavailableError);
    expect(clock.delays).toEqual([]);
  } finally { await fixture.clean(); }
});

test("a held routine alone never arms or launches a stopped SQLite owner", async () => {
  const fixture = await nativeRig();
  const clock = new ReminderClock();
  fixture.harness.reminderTimer = clock;
  try {
    const agent = await fixture.open();
    const host = agent.nativeHarness!;
    const repository = agent.persistence.reminders!;
    const sessionId = agent.id;
    await repository.enqueue({ acceptedAt: 0, op: "create", reminder: {
      id: "held", conversationId: "routine-channel", schedule: { cron: "*/10 * * * *", timezone: "Etc/UTC" },
      text: "held routine", expiry: { kind: "harness_default" }, expiryPolicy: { kind: "default" },
      status: "active", scheduleAcceptedAt: 0, missedRuns: "coalesce", overlap: "skip",
    } });
    await repository.updateDeadline({ sessionId, nextDueAt: 180_000, revision: 1 });
    await until(() => clock.delays.length === 1);
    await repository.updateDeadline({ sessionId, nextDueAt: null, revision: 2 });
    await until(() => clock.delays.length === 0);
    clock.tickAt(600_000);
    await settle();
    expect(clock.delays).toEqual([]);
    expect(host.state).toBe("stopped");
    expect(host.launches).toBe(0);
    expect((await repository.list())[0]?.changes[0]?.state).toBe("pending");
  } finally { await fixture.clean(); }
});

test("automatic reopen stops on invalid_config and explicit restart retries after correction", async () => {
  const fixture = await nativeRig();
  const peer = new ReminderPeer();
  let first: Awaited<ReturnType<ReminderPeer["connect"]>> | undefined;
  let attempts = 0;
  fixture.harness.connect = async () => {
    const link = await peer.connect();
    if (++attempts === 1) first = link;
    if (attempts === 2) link.client.openSession = async () => {
      throw new HarnessClientError("invalid_config", "guard configuration changed");
    };
    return link;
  };
  try {
    const agent = await fixture.open();
    const host = agent.nativeHarness!;
    const detach = host.attach("outstanding", { busy: () => true, reconcile() {}, event() {}, failed() {}, disconnected() {} });
    await host.start();
    await first!.kill();
    await until(() => host.state === "failed" || attempts > 2, "terminal reopen outcome");
    expect(attempts).toBe(2);
    expect(host.failure).toMatchObject({ code: "invalid_config" });
    detach();
    await host.restart();
    expect(host.state).toBe("running");
    expect(attempts).toBe(3);
  } finally { await fixture.clean(); }
});

test("a cold wake stops on incompatible harness and allows a later explicit start", async () => {
  const fixture = await nativeRig();
  const clock = new ReminderClock();
  const peer = new ReminderPeer();
  const incompatible = new HarnessIncompatibleError("unsupported guard");
  let attempts = 0;
  fixture.harness.reminderTimer = clock;
  fixture.harness.connect = async () => {
    if (++attempts === 1) throw incompatible;
    return peer.connect();
  };
  try {
    const agent = await fixture.open();
    const host = agent.nativeHarness!;
    await agent.persistence.reminders!.updateDeadline({ sessionId: peer.sessionId, nextDueAt: 0, revision: 1 });
    await until(() => clock.delays.length === 1, "armed cold wake");
    clock.tickAt(1_000);
    await until(() => fixture.logs.some(([, event]) => event === "reminder_wake_failed"), "reported incompatible wake");
    expect(host.failure).toBe(incompatible);
    expect(host.state).toBe("stopped");
    expect(clock.delays).toEqual([]);
    expect(attempts).toBe(1);
    await host.start();
    expect(host.state).toBe("running");
    expect(attempts).toBe(2);
  } finally { await fixture.clean(); }
});
