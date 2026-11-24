import { spawnHarness } from "./helpers/stdio.ts";
import { writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";
import type { StorageResult } from "../src/contracts/storage.ts";

function take<T>(result: StorageResult<T>): T {
  if (!result.ok) throw Error(result.error.message);
  return result.value;
}
import { expect, test } from "bun:test";
import { unattendedAdmission } from "../src/capabilities/reminders/unattended.ts";

test("an exhausted channel admits participant work but cannot spend another unattended slot", () => {
  expect(unattendedAdmission(1, 0, false)).toEqual({ eligible: true, nextSpent: 1 });
  expect(unattendedAdmission(1, 1, false)).toEqual({ eligible: false, nextSpent: 1 });
  expect(unattendedAdmission(1, 1, true)).toEqual({ eligible: true, nextSpent: 0 });
  expect(unattendedAdmission(undefined, 0, false)).toEqual({ eligible: true, nextSpent: 0 });
});

for (const adapterName of ["memory", "sqlite"] as const) {
  test(`${adapterName}: an executable open binds the guard and carries its counter through archive import`, () => {
    const home = mkdtempSync(join(tmpdir(), "routine-guard-"));
    const make = (file: string) => adapterName === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(home, file));
    const adapter = make("session.sqlite");
    const identity = { sessionId: "guard", compatibilityKey: "test" };
    const config = { version: 1 as const, system: "test", model: { protocol: "scripted" as const, script: "test" },
      defaultPolicy: "open", policies: { open: { fallback: "allow" as const, tools: {} } }, limits: { unattendedTurns: 1 } };
    let store = take(adapter.open({ mode: "create", identity }));
    try {
      expect(take(store.readSession()).formatVersion).toBe(6);
      take(store.close());
      store = take(adapter.open({ mode: "open", identity, config }));
      expect(take(store.readSession()).formatVersion).toBe(8);
      take(store.createChannel({ channelId: "a" }));
      take(store.acceptItem({ kind: "external_notice", inheritedPolicyNames: [], channelId: "a", senderId: "worker", itemId: "n1", text: "first" }));
      const first = take(store.beginTurn("a"))!;
      take(store.finishTurn(first.turn.turnId, { status: "interrupted", reason: "test" }));
      const archive = take(store.exportArchive());
      expect(archive.archiveVersion).toBe(7);
      expect(archive.reminderState?.guard).toEqual({ limit: 1, counters: [{ channel: "a", spent: 1 }] });
      take(store.close());
      const wrong = adapter.open({ mode: "open", identity, config: { ...config, limits: { unattendedTurns: 2 } } });
      expect(wrong).toMatchObject({ ok: false, error: { code: "invalid_config" } });
      const copy = make("copy.sqlite");
      take(copy.importArchive(archive));
      store = take(copy.open({ mode: "open", identity, config: { ...config, limits: undefined } }));
      take(store.acceptItem({ kind: "external_notice", inheritedPolicyNames: [], channelId: "a", senderId: "worker", itemId: "n2", text: "second" }));
      expect(take(store.beginTurn("a"))).toBeNull();
      expect(take(store.readReadyChannels()).channels).toEqual([]);
      take(store.acceptItem({ kind: "participant_message", channelId: "a", senderId: "human", itemId: "p", text: "reset" }));
      expect(take(store.readReadyChannels()).channels).toEqual(["a"]);
      const reset = take(store.beginTurn("a"))!;
      expect(reset.items.map(item => item.itemId)).toEqual(["n2", "p"]);
      take(store.finishTurn(reset.turn.turnId, { status: "interrupted", reason: "test" }));
      expect(take(store.exportArchive()).reminderState?.guard?.counters).toEqual([{ channel: "a", spent: 0 }]);
    } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
  });
}

test("real stdio guard persists across a replacement and participant admission releases the queued notice", async () => {
  const home = mkdtempSync(join(tmpdir(), "routine-guard-stdio-"));
  const script = join(home, "guard.jsonl");
  writeFileSync(script, [
    { type: "scenario", version: 1, name: "guard" },
    { type: "model", content: "first" },
    { type: "model", content: "second" },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const awaitTurn = async (ended: () => boolean) => {
    const deadline = performance.now() + 3000;
    while (!ended() && performance.now() < deadline) await Bun.sleep(5);
    expect(ended()).toBe(true);
  };

  try {
    const first = spawnHarness({ home });
    try {
      let ended = false;
      first.client.onChannelEvent(({ event }) => { if (event.type === "turn_ended") ended = true; });
      await first.client.initialize();
      const opened = await first.client.createSession({ sessionId: "guard", participants: [], channels: {},
        channelChanges: [{ channel: "a", changeId: "a" }],
        config: { version: 1, system: "guard", model: { protocol: "scripted", script },
          defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } }, limits: { unattendedTurns: 1 } },
      });
      expect(opened.unattendedTurnGuard).toEqual({ maxConsecutiveTurns: 1 });
      await first.client.notify({ channel: "a", notice: { id: "n1", text: "first", policyNames: [] } });
      await awaitTurn(() => ended);
      await first.client.notify({ channel: "a", notice: { id: "n2", text: "behind guard", policyNames: [] } });
      expect(await first.client.stopIfIdle()).toEqual({ stopped: true });
    } finally { await first.close(); }

    const second = spawnHarness({ home });
    try {
      let ended = false;
      second.client.onChannelEvent(({ event }) => { if (event.type === "turn_ended") ended = true; });
      await second.client.initialize();
      const reopened = await second.client.openSession({ sessionId: "guard" });
      expect(reopened.unattendedTurnGuard).toEqual({ maxConsecutiveTurns: 1 });
      expect((await second.client.status()).channels[0]?.pending).toEqual(["n2"]);
      await second.client.push({ channel: "a", item: { kind: "user_message", id: "p", sender: "person",
        content: [{ type: "text", text: "continue" }] } });
      await awaitTurn(() => ended);
      const recalled = await second.client.reconcileChannel({ channel: "a", itemIds: ["n2", "p"] });
      expect(recalled.items.map(item => item.turnId)).toEqual(["2", "2"]);
    } finally { await second.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 15000);
