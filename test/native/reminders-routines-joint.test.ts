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
