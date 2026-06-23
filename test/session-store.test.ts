import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "../src/session-store.ts";
import type { SessionRecord } from "../src/session-store.ts";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "id-1",
    agentSessionId: "agent-1",
    adapter: "codex",
    mode: "normal",
    cwd: "/work",
    title: "A session",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("FileSessionStore", () => {
  let dir: string;
  let store: FileSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "acp-store-"));
    store = new FileSessionStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("save then get round-trips a record", async () => {
    const rec = record();
    await store.save(rec);
    expect(await store.get("id-1")).toEqual(rec);
  });

  test("get returns null for a missing id", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  test("save overwrites an existing record", async () => {
    await store.save(record({ title: "first" }));
    await store.save(record({ title: "second" }));
    expect((await store.get("id-1"))?.title).toBe("second");
  });

  test("list returns every saved record", async () => {
    await store.save(record({ id: "a" }));
    await store.save(record({ id: "b" }));
    const ids = (await store.list()).map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  test("list skips malformed json files", async () => {
    await store.save(record({ id: "good" }));
    await writeFile(join(dir, "broken.json"), "{ not valid json", "utf8");
    const ids = (await store.list()).map((r) => r.id);
    expect(ids).toEqual(["good"]);
  });

  test("list of a missing directory is empty, not an error", async () => {
    const missing = new FileSessionStore(join(dir, "does-not-exist"));
    expect(await missing.list()).toEqual([]);
  });

  test("delete removes a record and is idempotent", async () => {
    await store.save(record());
    await store.delete("id-1");
    expect(await store.get("id-1")).toBeNull();
    await store.delete("id-1"); // already gone — must not throw
  });

  test("ids with filesystem-unsafe characters survive a round-trip", async () => {
    const rec = record({ id: "weird/id:with*chars" });
    await store.save(rec);
    expect(await store.get("weird/id:with*chars")).toEqual(rec);
  });
});
