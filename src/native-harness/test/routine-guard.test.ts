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
