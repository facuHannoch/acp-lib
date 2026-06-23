import { describe, expect, test } from "bun:test";
import { mergeSessions, SessionManager } from "../src/session-manager.ts";
import type { SessionRecord, SessionStore } from "../src/session-store.ts";

class MemorySessionStore implements SessionStore {
  readonly records = new Map<string, SessionRecord>();

  async save(record: SessionRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async get(id: string): Promise<SessionRecord | null> {
    return this.records.get(id) ?? null;
  }

  async list(): Promise<SessionRecord[]> {
    return [...this.records.values()];
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}

describe("SessionManager", () => {
  test("preserves createdAt while updating a record", async () => {
    const store = new MemorySessionStore();
    const manager = new SessionManager(store);
    const first = await manager.record({
      id: "catalog-1",
      agentSessionId: "agent-1",
      adapter: "codex",
      mode: "normal",
      title: "First title",
    });
    const second = await manager.record({
      id: "catalog-1",
      agentSessionId: "agent-1",
      adapter: "codex",
      mode: "normal",
      title: "Updated title",
    });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.title).toBe("Updated title");
  });

  test("deletes catalog records", async () => {
    const store = new MemorySessionStore();
    const manager = new SessionManager(store);
    await manager.record({
      id: "catalog-1",
      agentSessionId: null,
      adapter: "kimi",
      mode: "degraded",
    });

    await manager.delete("catalog-1");
    expect(await manager.get("catalog-1")).toBeNull();
  });
});

describe("mergeSessions", () => {
  test("combines matching sessions and retains catalog-only and agent-only rows", () => {
    const catalog: SessionRecord[] = [
      {
        id: "catalog-matched",
        agentSessionId: "agent-matched",
        adapter: "codex",
        mode: "normal",
        cwd: "/catalog",
        title: "Catalog title",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "catalog-only",
        agentSessionId: null,
        adapter: "kimi",
        mode: "degraded",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const merged = mergeSessions(
      catalog,
      [
        {
          sessionId: "agent-matched",
          cwd: "/agent",
          title: "Agent title",
          updatedAt: "2026-01-03T00:00:00.000Z",
        },
        {
          sessionId: "agent-only",
          cwd: "/agent-only",
          updatedAt: "2026-01-04T00:00:00.000Z",
        },
      ],
      "codex",
    );

    expect(merged).toHaveLength(3);
    expect(merged.find((item) => item.id === "catalog-matched")).toMatchObject({
      agentSessionId: "agent-matched",
      cwd: "/agent",
      title: "Agent title",
      source: "both",
    });
    expect(merged.find((item) => item.id === "catalog-only")?.source).toBe("catalog");
    expect(merged.find((item) => item.id === "agent-only")?.source).toBe("agent");
  });
});
