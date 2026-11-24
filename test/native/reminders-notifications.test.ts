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
