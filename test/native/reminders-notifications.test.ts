import { expect, test } from "bun:test";
import { launchNativeConnection } from "../../src/native/connection.ts";
import { noopLogger } from "../../src/logger.ts";
import { separateReminderNotifications } from "../../src/native/reminders/notifications.ts";
import type { ReminderNotification } from "../../src/native/reminders/wire.ts";

const due = { jsonrpc: "2.0", method: "session/event", params: { type: "reminders_due", revision: 7, nextDueAt: null } };
const changed = { jsonrpc: "2.0", method: "channel/event", params: { channel: "one", event: {
  type: "reminder_changed", reminder: { id: "r", channel: "one", schedule: { at: "2026-11-24T00:00:00.000Z" }, text: "café" },
} } };
const response = { jsonrpc: "2.0", id: 1, result: { evidence: true } };

test("reminder notification filter handles split UTF-8, passthrough and unknown or malformed reminder frames", async () => {
  const future = { ...changed, params: { ...changed.params, event: { type: "reminder_future" } } };
  const malformed = { ...due, params: { ...due.params, nextDueAt: 42 } };
  const bytes = new TextEncoder().encode([due, future, malformed, changed, response].map(frame => JSON.stringify(frame) + "\n").join(""));
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 1) controller.enqueue(bytes.slice(offset, offset + 1));
      controller.close();
    },
  });
  const seen: ReminderNotification[] = [];
  expect(await new Response(separateReminderNotifications(readable, event => seen.push(event))).text()).toBe(JSON.stringify(response) + "\n");
  expect(seen).toEqual([
    { deadline: { revision: 7, nextDueAt: null } },
    { channel: "one", event: { kind: "reminder_changed", reminder: changed.params.event.reminder } },
  ]);
});

test("native stdio launch routes reminder notifications to the registered consumer", async () => {
  const script = `
    const reader = Bun.stdin.stream().getReader();
    await reader.read();
    for (const frame of ${JSON.stringify([due, changed, response])}) console.log(JSON.stringify(frame));
    while (!(await reader.read()).done) {}
  `;
  const connection = await launchNativeConnection({
    sessionId: "test", home: "", config: {} as never, command: [process.execPath, "-e", script],
  }, noopLogger);
  try {
    const seen: ReminderNotification[] = [];
    connection.onReminderNotification?.(event => seen.push(event));
    expect(await connection.client.initialize()).toEqual(response.result as never);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ deadline: { revision: 7 } });
    expect(seen[1]).toMatchObject({ event: { kind: "reminder_changed" } });
  } finally { await connection.kill(); }
});

import { reminderNotification } from "../../src/native/reminders/wire.ts";

test("reminder notifications reject missing fields, nonstrings and wrong-channel rows", () => {
  const frame = (event: Record<string, unknown>) =>
    reminderNotification({ jsonrpc: "2.0", method: "channel/event", params: { channel: "one", event } });
  for (const [type, required] of [
    ["reminder_fired", ["reminderId", "occurrenceId", "scheduledAt", "firedAt", "noticeId"]],
    ["reminder_cancelled", ["reminderId", "by"]],
    ["reminder_expired", ["reminderId", "occurrenceId", "scheduledAt", "expiredAt"]],
  ] as const) {
    const event: Record<string, unknown> = { type, ...Object.fromEntries(required.map(key => [key, "value"])) };
    expect(frame(event)).toMatchObject({ event: { kind: type } });
    for (const key of required) {
      const { [key]: _missing, ...absent } = event;
      expect(frame(absent)).toBeUndefined();
      expect(frame({ ...event, [key]: 7 })).toBeUndefined();
    }
  }
  const row = changed.params.event.reminder;
  for (const reminder of [{ ...row, channel: "different" }, { ...row, schedule: {} }, { ...row, id: 42 }, null]) {
    expect(frame({ type: "reminder_changed", reminder })).toBeUndefined();
  }
});

test("the pre-0032 transport shim routes routine events and discards malformed variants", async () => {
  const common = { reminderId: "r", firstScheduledAt: "first", lastScheduledAt: "last" };
  const disposition = { type: "routine_disposition", ...common, count: 2, reason: "coalesced" };
  const migration = { type: "routine_migration_blocked", reminderId: "r", fromVersion: "2026a", targetVersion: "2026b", cause: "proof_budget" };
  const frames = [disposition, { ...disposition, count: 0 }, { ...disposition, reason: "future" }, migration, { ...migration, cause: "future" }]
    .map(event => ({ jsonrpc: "2.0", method: "channel/event", params: { channel: "one", event } }));
  const seen: ReminderNotification[] = [];
  const stream = new Blob([frames.map(frame => JSON.stringify(frame) + "\n").join("")]).stream();
  expect(await new Response(separateReminderNotifications(stream, event => seen.push(event))).text()).toBe("");
  expect(seen.map(event => "event" in event ? event.event.kind : null)).toEqual(["routine_disposition", "routine_migration_blocked"]);
});

test("routine dispositions require the reminder and range string fields", () => {
  const event = { type: "routine_disposition", reminderId: "r", firstScheduledAt: "first",
    lastScheduledAt: "last", count: 2, reason: "expired" };
  const parse = (value: Record<string, unknown>) =>
    reminderNotification({ jsonrpc: "2.0", method: "channel/event", params: { channel: "one", event: value } });
  expect(parse(event)).toMatchObject({ event: { kind: "routine_disposition" } });
  for (const key of ["reminderId", "firstScheduledAt", "lastScheduledAt"] as const) {
    const { [key]: _missing, ...rest } = event;
    expect(parse(rest)).toBeUndefined();
    expect(parse({ ...event, [key]: 9 })).toBeUndefined();
  }
});
