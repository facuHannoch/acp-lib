// SessionManager — catalog logic over a SessionStore. Owns the record lifecycle (upsert
// with timestamps) and merges OUR catalog with an agent's live `session/list` so the
// caller sees both: sessions we recorded (across adapters, surviving a broken agent list)
// AND sessions the agent reports (incl. ones created via the native CLI/bridge).
//
// It stores routing metadata only — never conversation content. See session-store.ts.

import type { SessionRecord, SessionStore } from "./session-store.ts";
import type { SessionListEntry } from "./types.ts";

/** A row in the merged session view. `source` says where it was seen. */
export interface MergedSession {
  /** Our catalog id when cataloged, else the agent's sessionId. */
  id: string;
  agentSessionId: string | null;
  adapter: string;
  mode?: "normal" | "degraded";
  cwd?: string;
  title?: string;
  updatedAt?: string;
  source: "catalog" | "agent" | "both";
}

/** What `record()` accepts — timestamps are managed by the manager. */
export type SessionInput = Omit<SessionRecord, "createdAt" | "updatedAt">;

export class SessionManager {
  constructor(private readonly store: SessionStore) {}

  /** Upsert a record: preserves createdAt, bumps updatedAt. Returns the stored record. */
  async record(input: SessionInput): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const existing = await this.store.get(input.id);
    const record: SessionRecord = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.store.save(record);
    return record;
  }

  get(id: string): Promise<SessionRecord | null> {
    return this.store.get(id);
  }

  delete(id: string): Promise<void> {
    return this.store.delete(id);
  }

  /** Catalog records, newest first. */
  async list(): Promise<SessionRecord[]> {
    const records = await this.store.list();
    return records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /**
   * Merge the catalog with an agent's live list for `adapter`. The agent list only covers
   * the connected adapter; catalog records span all adapters and are kept even when the
   * agent omits them (other adapter, or a broken/empty list).
   */
  async listMerged(
    agentEntries: SessionListEntry[],
    adapter: string,
  ): Promise<MergedSession[]> {
    return mergeSessions(await this.store.list(), agentEntries, adapter);
  }
}

/** Pure merge — exported for testing. */
export function mergeSessions(
  catalog: SessionRecord[],
  agentEntries: SessionListEntry[],
  adapter: string,
): MergedSession[] {
  const byAgentId = new Map<string, SessionRecord>();
  for (const r of catalog) if (r.agentSessionId) byAgentId.set(r.agentSessionId, r);

  const out: MergedSession[] = [];
  const claimed = new Set<string>(); // catalog ids already emitted via the agent list

  for (const e of agentEntries) {
    const rec = byAgentId.get(e.sessionId);
    if (rec) {
      claimed.add(rec.id);
      out.push({
        id: rec.id,
        agentSessionId: e.sessionId,
        adapter: rec.adapter,
        mode: rec.mode,
        cwd: e.cwd ?? rec.cwd,
        title: e.title ?? rec.title,
        updatedAt: e.updatedAt ?? rec.updatedAt,
        source: "both",
      });
    } else {
      // Reported by the agent but not in our catalog (made via native CLI/bridge).
      out.push({
        id: e.sessionId,
        agentSessionId: e.sessionId,
        adapter,
        cwd: e.cwd,
        title: e.title,
        updatedAt: e.updatedAt,
        source: "agent",
      });
    }
  }

  for (const r of catalog) {
    if (claimed.has(r.id)) continue; // already emitted as "both"
    out.push({
      id: r.id,
      agentSessionId: r.agentSessionId,
      adapter: r.adapter,
      mode: r.mode,
      cwd: r.cwd,
      title: r.title,
      updatedAt: r.updatedAt,
      source: "catalog",
    });
  }

  return out.sort((a, b) => ((a.updatedAt ?? "") < (b.updatedAt ?? "") ? 1 : -1));
}
