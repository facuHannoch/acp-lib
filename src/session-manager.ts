// SessionManager — catalog logic over a SessionStore. Owns the record lifecycle (upsert
// with timestamps) and merges OUR catalog with an agent's live `session/list` so the
// caller sees both: sessions we recorded (across adapters, surviving a broken agent list)
// AND sessions the agent reports (incl. ones created via the native CLI/bridge).
//
// It stores routing metadata only — never conversation content. See session-store.ts.

import type { SessionRecord, SessionStore } from "./session-store.ts";
import type { SessionListEntry } from "./types.ts";
import {
  resolveManagedPersistence,
  resolvePersistenceRoot,
  type ManagedSessionPersistenceOptions,
  type ResolvedAgentSessionPersistence,
  type SessionPersistenceConstraints,
} from "./persistence/config.ts";
import { FileAgentSessionStore } from "./persistence/file-registry-store.ts";
import {
  summarizeAgentSessionRecord,
  type AgentSessionListPage,
  type AgentSessionStore,
  type AgentSessionSummary,
  type ListAgentSessionsOptions,
  type ListSessionMaintenanceOptions,
  type SessionMaintenance,
  type SessionMaintenancePage,
} from "./persistence/registry.ts";
import {
  importLegacySessionRegistry,
  type LegacyRegistryImportResult,
} from "./persistence/legacy-registry-import.ts";
import {
  deleteManagedAgentSession,
  type DeleteAgentSessionOptions,
} from "./persistence/deletion.ts";
import {
  createManagedAgentSession,
  type ManagedAgentSessionCreateConfig,
} from "./persistence/managed-creation.ts";
import type { AgentSession } from "./agent-session.ts";
import {
  loadManagedAgentSession,
  type ManagedAgentSessionLoadConfig,
} from "./persistence/managed-load.ts";
import type { AgentSessionOpenResult } from "./agent-session.ts";
import {
  getManagedAgentSessionCheckpoint,
  type GetAgentSessionCheckpointOptions,
  type ResolvedAgentSessionCheckpoint,
} from "./persistence/managed-checkpoint.ts";
import {
  reconfigureManagedAgentSessionPersistence,
  type ReconfigureAgentSessionPersistenceOptions,
} from "./persistence/reconfiguration.ts";

export interface SessionManagerConfig {
  readonly root?: string;
  readonly store?: AgentSessionStore;
  readonly sessionDefaults?: ManagedSessionPersistenceOptions;
  readonly sessionConstraints?: SessionPersistenceConstraints;
}

export class SessionManagerModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionManagerModeError";
  }
}

/** A row in the merged session view. `source` says where it was seen. */
export interface MergedSession {
  /** Our AgentSession id when cataloged, else the ACP/harness sessionId. */
  agentSessionId: string;
  /** The ACP/harness protocol sessionId used by lower-level session operations. */
  internalSessionId: string | null;
  adapter: string;
  mode?: "normal" | "degraded";
  cwd?: string;
  title?: string;
  transcriptPath?: string;
  updatedAt?: string;
  source: "catalog" | "agent" | "both";
}

/** What `record()` accepts — timestamps are managed by the manager. */
export type SessionInput = Omit<SessionRecord, "createdAt" | "updatedAt">;

export class SessionManager {
  private readonly legacyStore: SessionStore | null;
  private readonly agentStore: AgentSessionStore | null;
  private readonly managedRoot: string | null;
  private readonly sessionDefaults?: ManagedSessionPersistenceOptions;
  private readonly sessionConstraints: SessionPersistenceConstraints;

  constructor(store: SessionStore | AgentSessionStore, managedConfig?: SessionManagerConfig) {
    if (isAgentSessionStore(store)) {
      this.legacyStore = null;
      this.agentStore = store;
      this.managedRoot = resolvePersistenceRoot(managedConfig?.root);
      this.sessionDefaults = managedConfig?.sessionDefaults;
      this.sessionConstraints = managedConfig?.sessionConstraints ?? {};
    } else {
      this.legacyStore = store;
      this.agentStore = null;
      this.managedRoot = null;
      this.sessionConstraints = {};
    }
  }

  static async open(config: SessionManagerConfig = {}): Promise<SessionManager> {
    const root = resolvePersistenceRoot(config.root);
    const store = config.store ?? new FileAgentSessionStore({ root });
    return new SessionManager(store, { ...config, root });
  }

  /** Upsert a record: preserves createdAt, bumps updatedAt. Returns the stored record. */
  async record(input: SessionInput): Promise<SessionRecord> {
    const store = this.requireLegacyStore("record()");
    const now = new Date().toISOString();
    const existing = await store.get(input.agentSessionId);
    const record: SessionRecord = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await store.save(record);
    return record;
  }

  get(agentSessionId: string): Promise<SessionRecord | null> {
    return this.requireLegacyStore("get()").get(agentSessionId);
  }

  delete(agentSessionId: string): Promise<void> {
    return this.requireLegacyStore("delete()").delete(agentSessionId);
  }

  /** Catalog records, newest first. */
  async list(): Promise<SessionRecord[]> {
    const records = await this.requireLegacyStore("list()").list();
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
    return mergeSessions(await this.requireLegacyStore("listMerged()").list(), agentEntries, adapter);
  }

  async listAgentSessions(options?: ListAgentSessionsOptions): Promise<AgentSessionListPage> {
    return await this.requireAgentStore("listAgentSessions()").listAgentSessions(options);
  }

  async getAgentSessionInfo(
    agentSessionId: string,
    options: { readonly includeDeleted?: boolean } = {},
  ): Promise<AgentSessionSummary | null> {
    const store = this.requireAgentStore("getAgentSessionInfo()");
    const [record, maintenance] = await Promise.all([
      store.getAgentSessionRecord(agentSessionId),
      store.getMaintenance(agentSessionId),
    ]);
    if (!record) return null;
    if (!options.includeDeleted && (record.deletion || maintenance?.kind === "deletion")) return null;
    return summarizeAgentSessionRecord(record, maintenance ?? undefined);
  }

  async getSessionMaintenance(agentSessionId: string): Promise<SessionMaintenance | null> {
    return await this.requireAgentStore("getSessionMaintenance()").getMaintenance(agentSessionId);
  }

  async listSessionMaintenance(options?: ListSessionMaintenanceOptions): Promise<SessionMaintenancePage> {
    return await this.requireAgentStore("listSessionMaintenance()").listMaintenance(options);
  }

  /** Explicitly import a compatibility SessionStore after its transcripts were migrated. */
  async importLegacySessions(source: SessionStore): Promise<LegacyRegistryImportResult> {
    return importLegacySessionRegistry(source, this.requireAgentStore("importLegacySessions()"));
  }

  /** Tombstone a managed session and optionally delete its known persistence artifacts. */
  async deleteAgentSession(
    agentSessionId: string,
    options: DeleteAgentSessionOptions,
  ): Promise<void> {
    await deleteManagedAgentSession(
      this.requireAgentStore("deleteAgentSession()"),
      agentSessionId,
      options,
    );
  }

  /** Create a transcript-backed logical session under a prepared registry transaction. */
  async createAgentSession(config: ManagedAgentSessionCreateConfig): Promise<AgentSession> {
    const store = this.requireAgentStore("createAgentSession()");
    return await createManagedAgentSession({
      store,
      persistence: this.resolveSessionPersistence(config.persistence),
    }, config);
  }

  /** Load a cataloged logical session from its immutable persistence authority. */
  async loadAgentSession(
    agentSessionId: string,
    config: ManagedAgentSessionLoadConfig,
  ): Promise<AgentSessionOpenResult> {
    return await loadManagedAgentSession(
      this.requireAgentStore("loadAgentSession()"),
      agentSessionId,
      config,
    );
  }

  /** Resolve the current continuation checkpoint without starting its harness. */
  async getAgentSessionCheckpoint(
    agentSessionId: string,
    options?: GetAgentSessionCheckpointOptions,
  ): Promise<ResolvedAgentSessionCheckpoint | null> {
    return await getManagedAgentSessionCheckpoint(
      this.requireAgentStore("getAgentSessionCheckpoint()"),
      agentSessionId,
      options,
    );
  }

  /** Replace or disable stopped-session persistence under a prepared transaction. */
  async reconfigureAgentSessionPersistence(
    agentSessionId: string,
    options: ReconfigureAgentSessionPersistenceOptions,
  ): Promise<AgentSessionSummary> {
    return await reconfigureManagedAgentSessionPersistence(
      this.requireAgentStore("reconfigureAgentSessionPersistence()"),
      agentSessionId,
      options,
    );
  }

  /** Shared normalization used by managed create and the upcoming managed load path. */
  resolveSessionPersistence(
    options?: ManagedSessionPersistenceOptions,
  ): ResolvedAgentSessionPersistence {
    if (!this.managedRoot) throw new SessionManagerModeError("resolveSessionPersistence() requires a SessionManager created through SessionManager.open()");
    return resolveManagedPersistence(
      this.managedRoot,
      this.sessionDefaults,
      options,
      this.sessionConstraints,
    );
  }

  private requireLegacyStore(operation: string): SessionStore {
    if (!this.legacyStore) throw new SessionManagerModeError(`${operation} is available only on compatibility SessionManager instances`);
    return this.legacyStore;
  }

  private requireAgentStore(operation: string): AgentSessionStore {
    if (!this.agentStore) throw new SessionManagerModeError(`${operation} requires a SessionManager created through SessionManager.open()`);
    return this.agentStore;
  }
}

function isAgentSessionStore(store: SessionStore | AgentSessionStore): store is AgentSessionStore {
  return "getAgentSessionRecord" in store && typeof store.getAgentSessionRecord === "function";
}

/** Pure merge — exported for testing. */
export function mergeSessions(
  catalog: SessionRecord[],
  agentEntries: SessionListEntry[],
  adapter: string,
): MergedSession[] {
  const byInternalId = new Map<string, SessionRecord>();
  for (const r of catalog) if (r.internalSessionId) byInternalId.set(r.internalSessionId, r);

  const out: MergedSession[] = [];
  const claimed = new Set<string>(); // AgentSession ids already emitted via the agent list

  for (const e of agentEntries) {
    const rec = byInternalId.get(e.sessionId);
    if (rec) {
      claimed.add(rec.agentSessionId);
      out.push({
        agentSessionId: rec.agentSessionId,
        internalSessionId: e.sessionId,
        adapter: rec.adapter,
        mode: rec.mode,
        cwd: e.cwd ?? rec.cwd,
        title: e.title ?? rec.title,
        transcriptPath: rec.transcriptPath,
        updatedAt: e.updatedAt ?? rec.updatedAt,
        source: "both",
      });
    } else {
      // Reported by the agent but not in our catalog (made via native CLI/bridge).
      out.push({
        agentSessionId: e.sessionId,
        internalSessionId: e.sessionId,
        adapter,
        cwd: e.cwd,
        title: e.title,
        updatedAt: e.updatedAt,
        source: "agent",
      });
    }
  }

  for (const r of catalog) {
    if (claimed.has(r.agentSessionId)) continue; // already emitted as "both"
    out.push({
      agentSessionId: r.agentSessionId,
      internalSessionId: r.internalSessionId,
      adapter: r.adapter,
      mode: r.mode,
      cwd: r.cwd,
      title: r.title,
      transcriptPath: r.transcriptPath,
      updatedAt: r.updatedAt,
      source: "catalog",
    });
  }

  return out.sort((a, b) => ((a.updatedAt ?? "") < (b.updatedAt ?? "") ? 1 : -1));
}
