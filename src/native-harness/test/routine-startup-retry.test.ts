import { expect, test } from "bun:test";
import { HarnessClient, createInProcessTransport } from "../src/client.ts";
import { createSession } from "../src/index.ts";
import { createProtocolServer } from "../src/interfaces/protocol/server.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import type { ReminderChange } from "../src/contracts/reminders.ts";

for (const mode of ["create", "open"] as const) {
  test(`same-connection startup retry after a per-entry failure on ${mode}`, async () => {
    const adapter = createMemoryStorageAdapter();
    const identity = { sessionId: "startup", compatibilityKey: "test" };
    if (mode === "open") {
      const initial = adapter.open({ mode: "create", identity });
      if (!initial.ok) throw Error(initial.error.message);
      initial.value.close();
    }
    const now = Date.parse("2026-11-24T12:00:00Z");
    const attempts: string[] = [];
    let failed = false, processed = 0, started = 0;
    const server = createProtocolServer(async request => {
      const opened = adapter.open({ mode: request.mode, identity });
      if (!opened.ok) throw Error(opened.error.message);
      const session = createSession({ systemPrompt: "test", storage: opened.value,
        reminderClock: { now: () => now, setTimer: () => () => {} },
        configureTurn: () => { throw Error("No inference expected"); },
      });
      const reminders = session.reminders!;
      const change = reminders.change, process = reminders.processStartup, start = session.start;
      reminders.change = entry => {
        attempts.push(entry.reminderId);
        if (entry.reminderId === "budget" && !failed) {
          failed = true;
          return { ok: false, error: { code: "storage_failure", message: "Injected proof budget exhaustion" } };
        }
        return change(entry);
      };
      reminders.processStartup = () => { processed++; process(); };
      session.start = () => { started++; start(); };
      return { session, close: () => { opened.value.close(); } };
    }, { durable: true });
    const client = new HarnessClient(createInProcessTransport(server));
    try {
      await client.initialize();
      const reminderChanges: ReminderChange[] = ["first", "budget", "last"].map(reminderId => ({
        op: "create", reminderId, changeId: 1,
        payload: { channel: "alice", text: reminderId, acceptedAt: new Date(now).toISOString(),
          schedule: { at: new Date(now + 600_000).toISOString() } },
      }));
      const params = { sessionId: identity.sessionId, reminderChanges,
        channelChanges: [{ channel: "alice", changeId: "channel", displayName: "Alice" }] };
      const request = mode === "create" ? client.createSession({ ...params, participants: [], channels: {} })
        : client.openSession(params);
      await expect(request).rejects.toMatchObject({ code: "storage_failure" });
      expect(attempts).toEqual(["first", "budget"]);
      expect(processed).toBe(0);
      expect(started).toBe(0);

      const peek = adapter.open({ mode: "open", identity });
      if (!peek.ok) throw Error(peek.error.message);
      try {
        const saved = peek.value.readReminder("first");
        expect(saved.ok && saved.value?.id).toBe("first");
        const later = peek.value.readReminder("last");
        expect(later.ok && later.value).toBeUndefined();
      } finally { peek.value.close(); }

      const retried = await client.openSession(params);
      expect(retried.sessionId).toBe(identity.sessionId);
      expect(retried.reminderChanges?.map(result => result.outcome)).toEqual(["applied", "applied", "applied"]);
      expect(attempts).toEqual(["first", "budget", "first", "budget", "last"]);
      expect(processed).toBe(1);
    } finally { client.close(); server.dispose(); }
  });
}
