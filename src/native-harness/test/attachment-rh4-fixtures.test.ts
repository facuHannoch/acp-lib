import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";
import type { StorageResult, SessionArchive } from "../src/contracts/storage.ts";
function take<T>(result: StorageResult<T>): T { if (!result.ok) throw Error(JSON.stringify(result.error)); return result.value; }
const identity = { sessionId: "a1-rh4-fixture", compatibilityKey: "test" };
const config = { version: 1 as const, system: "test", model: { protocol: "scripted" as const, script: "test" }, defaultPolicy: "open", policies: { open: { fallback: "allow" as const, tools: {} } }, limits: { unattendedTurns: 1 } };

test("approved R-H4 SQLite and logical archive fixtures reopen on the trial runtime", () => {
  const home = mkdtempSync(join(tmpdir(), "a1-rh4-reopen-"));
  try {
    const path = join(home, "sqlite");
    copyFileSync(new URL("./fixtures/attachments-rh4/format-8.sqlite", import.meta.url), path);
    const archive = JSON.parse(readFileSync(new URL("./fixtures/attachments-rh4/archive-7.json", import.meta.url), "utf8")) as SessionArchive;
    const imported = createSqliteStorageAdapter(join(home, "imported"));
    take(imported.importArchive(archive));
    for (const adapter of [createSqliteStorageAdapter(path), imported]) {
      const store = take(adapter.open({ mode: "open", identity, config }));
      try {
        expect(take(store.readSession()).formatVersion).toBe(8);
        expect(take(store.readReminder("routine"))).toMatchObject({ id: "routine", schedule: { every: 600000, count: 2 } });
        const exported = take(store.exportArchive());
        expect(exported.archiveVersion).toBe(7);
        expect(exported.reminderState?.guard).toEqual({ limit: 1, counters: [{ channel: "a", spent: 1 }] });
      } finally { take(store.close()); }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
