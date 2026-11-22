import { randomUUID } from "node:crypto";
import { SqliteWorkerDelivery } from "./sqlite-worker-delivery.ts";
import { Database, type Changes } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  createAgentSessionId,
  isAgentConversationId,
  isAgentSessionId,
  type AgentConversationId,
  type AgentSessionId,
} from "../agent-ids.ts";
import {
  IMPLICIT_USER_PARTICIPANT_ID,
  PersistenceCapabilityError,
  PersistenceConflictError,
  isConversationRecordKind,
  normalizeParticipantRef,
  type AgentConversationSummary,
  type AgentConversationPreview,
  type AgentAuditState,
  type AgentMeteringCommitInput,
  type AgentPersistenceIdentity,
  type AuditOutboxItem,
  type AuditOutboxBacklog,
  type AuditOutboxPersistence,
  type ConversationCheckpointPersistence,
  type ConversationListOptions,
  type ConversationMessagePersistence,
  type ConversationPage,
  type ConversationPreviewPage,
  type ConversationPersistence,
  type ConversationRecord,
  type ConversationRecordPage,
  type ConversationRecordPersistence,
  type ConversationRuntimeCheckpoint,
  type CreateAgentConversationInput,
  type IdentityMemoryObservation,
  type IdentityDeliveryAdvance,
  type IdentityDeliveryCursor,
  type IdentityDeliveryPersistence,
  type IdentityPersistence,
  type IdentityProjectionState,
  type MessageListOptions,
  type MessagePage,
  type MessageRecord,
  type MeteringCommitInput,
  type MeteringPersistence,
  type MeteringRecordListOptions,
  type MeteringRecordPage,
  type NewConversationRecord,
  type OutOfBandDeliveryPersistence,
  type NewAuditOutboxItem,
  type NewIdentityMemoryObservation,
  type ParticipantRef,
  type PersistedIdentitySnapshot,
  type PersistenceBackend,
  type PersistenceCapabilities,
  type PersistenceExtension,
  type PersistenceExtensionCatalog,
  type PersistenceExtensionRegistration,
  type PersistenceJsonPrimitive,
  type PersistenceJsonValue,
  type PersistenceScope,
  type PersistedConversationMeteringState,
  type PersistedAgentMeteringState,
  type ProviderSessionPersistence,
  type ProviderSessionRecord,
  type RecordListOptions,
  type RecentItemPage,
  type RecentItemPageOptions,
  type RecentRecordPage,
  type RecentRecordPageOptions,
  type SearchMatch,
  type SearchPersistence,
  type SearchQuery,
} from "./backend.ts";
import type { OperationMeteringRecord } from "../metering/record.ts";
import type { AgentSessionMeteringState } from "../metering/state.ts";
import { installSqliteFts, migrateSqliteAgentSchema } from "./sqlite-schema.ts";
import { conversationsUsingProviderSession } from "./sqlite-provider-sessions.ts";
import { SqliteInternalInferenceRepository } from "../internal-inference/persistence/sqlite-repository.ts";
import type { InternalInferenceRepository } from "../internal-inference/persistence/repository.ts";
import type { ConversationRecoveryCheckpointRepository } from "../checkpointing/contracts.ts";
import { SqliteConversationRecoveryCheckpointRepository } from "../checkpointing/persistence/sqlite-repository.ts";
import {
  hydrateConversationRecords,
  insertConversationRecordDetail,
  operationIdFromRecord,
  sameConversationRecord,
  type ConversationRecordRow,
} from "./sqlite-conversation-records.ts";
import { SqliteOwnerLock, SqliteOwnerLockConflictError } from "./sqlite-owner-lock.ts";
import { canonicalizeJson } from "./integrity.ts";
import {
  conversationTimelineItemId,
  reconcileConversationTimeline,
  type ConversationTimelineItem,
} from "./timeline-reconcile.ts";
import { SqliteSharedFiles } from "./sqlite-files.ts";
import type { SharedFilesPersistence } from "../media/files.ts";
import { SqliteMediaStore } from "./sqlite-media-store.ts";
import type { MediaStore } from "../media/store.ts";
import type { ChannelPersistence } from "./channels.ts";
import { SqliteChannelPersistence } from "./sqlite-channels.ts";

type SqlValue = string | number | bigint | boolean | Uint8Array | null;
type WriteRunner = <T>(work: () => T) => Promise<T>;

interface ConversationRow {
  agent_conversation_id: string;
  agent_session_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  latest_sequence: number;
  last_human_message_at: string | null;
  deleted_at: string | null;
  metadata: string | null;
  adopted: number;
  adopt_provider_session_id: string | null;
}

interface IdentityRow {
  agent_session_id: string;
  created_at: string;
  updated_at: string;
  metadata: string | null;
}

export interface SqliteAgentPersistenceConfig {
  readonly path: string;
  /** Required to create with a chosen identity; omitted reuses an existing identity or mints one. */
  readonly agentSessionId?: AgentSessionId;
  readonly metadata?: string;
  readonly busyTimeoutMs?: number;
  readonly extensions?: readonly PersistenceExtension[];
  /** Escape hatch for vendor-patched SQLite builds whose version string is not recognized. */
  readonly allowUnsafeWalVersion?: boolean;
}

export class AgentDatabaseInUseError extends Error {
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super(`agent database already has an active runtime owner: ${path}`, options);
    this.name = "AgentDatabaseInUseError";
    this.path = path;
  }
}

/** One caller-located SQLite database containing exactly one agent and its conversations. */
export class SqliteAgentPersistence implements PersistenceBackend {
  readonly path: string;
  readonly identityRecord: AgentPersistenceIdentity;
  readonly capabilities: PersistenceCapabilities;

  readonly media: MediaStore;
  readonly files: SharedFilesPersistence;
  readonly outOfBandDelivery: OutOfBandDeliveryPersistence;
  readonly conversations: ConversationPersistence;
  readonly records: ConversationRecordPersistence;
  readonly messages: ConversationMessagePersistence;
  readonly checkpoints: ConversationCheckpointPersistence;
  readonly providerSessions: ProviderSessionPersistence;
  readonly metering: MeteringPersistence;
  readonly internalInferences: InternalInferenceRepository;
  readonly recoveryCheckpoints: ConversationRecoveryCheckpointRepository;
  readonly identity: IdentityPersistence;
  readonly channels: ChannelPersistence;
  readonly workerDelivery?: SqliteWorkerDelivery;
  private readonly workerOwnerId = randomUUID();
  readonly identityDelivery: IdentityDeliveryPersistence;
  readonly search?: SearchPersistence;
  readonly auditOutbox: AuditOutboxPersistence;
  readonly extensions: PersistenceExtensionCatalog;

  private readonly database: Database;
  private readonly installedExtensions: PersistenceExtension[] = [];
  private writeTail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    path: string,
    database: Database,
    identityRecord: AgentPersistenceIdentity,
    fullTextSearch: boolean,
    private readonly ownerLock?: SqliteOwnerLock,
  ) {
    this.path = path;
    this.database = database;
    this.identityRecord = identityRecord;
    this.capabilities = Object.freeze({
      transactions: true as const,
      fullTextSearch,
      identity: true,
      channels: true,
      workerDelivery: Boolean(ownerLock),
      auditOutbox: true,
      extensions: true,
      vectorSearch: false,
      metering: true,
    });
    const scope = this.createScope(
      (work) => this.autoWrite(work),
      (records) => this.notifyRecordsCommitted(records),
      // Root intent reads must not see a retirement inside an uncommitted delete.
      (work) => {
        this.assertOpen();
        return this.enqueueWrite(async () => work());
      },
    );
    this.media = scope.media!;
    this.files = scope.files!;
    this.outOfBandDelivery = scope.outOfBandDelivery!;
    this.conversations = scope.conversations;
    this.records = scope.records;
    this.messages = scope.messages;
    this.checkpoints = scope.checkpoints;
    this.providerSessions = scope.providerSessions;
    this.metering = scope.metering;
    this.internalInferences = scope.internalInferences!;
    this.recoveryCheckpoints = scope.recoveryCheckpoints!;
    this.identity = scope.identity!;
    this.channels = scope.channels!;
    this.workerDelivery = scope.workerDelivery as SqliteWorkerDelivery | undefined;
    this.identityDelivery = scope.identityDelivery!;
    this.search = fullTextSearch ? new SqliteSearchPersistence(database) : undefined;
    this.auditOutbox = scope.auditOutbox!;
    this.extensions = scope.extensions!;
  }

  static async open(config: SqliteAgentPersistenceConfig): Promise<SqliteAgentPersistence> {
    if (config.agentSessionId !== undefined && !isAgentSessionId(config.agentSessionId)) {
      throw new Error(`invalid agent session id for SQLite persistence: ${config.agentSessionId}`);
    }
    if (!config.path.trim()) throw new Error("SQLite persistence path cannot be blank");
    const path = config.path === ":memory:" ? config.path : await canonicalSqlitePath(config.path);
    let ownerLock: SqliteOwnerLock | undefined;
    if (path !== ":memory:") {
      try {
        ownerLock = await SqliteOwnerLock.acquire(path, `${path}.agent-owner.sqlite`);
      } catch (error) {
        if (error instanceof SqliteOwnerLockConflictError) {
          throw new AgentDatabaseInUseError(path, { cause: error });
        }
        throw error;
      }
    }

    let database: Database;
    try {
      database = new Database(path, { create: true, readwrite: true, strict: true });
    } catch (error) {
      ownerLock?.close();
      throw error;
    }
    try {
      const busyTimeoutMs = boundedInteger(config.busyTimeoutMs ?? 5_000, 1, 60_000, "busyTimeoutMs");
      database.exec("PRAGMA foreign_keys = ON");
      database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      const version = String(
        database.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()?.version ?? "",
      );
      if (!config.allowUnsafeWalVersion && !hasSafeConcurrentWal(version)) {
        throw new Error(
          `SQLite ${version || "unknown"} lacks a recognized concurrent-WAL fix; require 3.51.3+, 3.50.7, or 3.44.6`,
        );
      }
      if (path !== ":memory:") {
        const mode = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get();
        if (mode?.journal_mode?.toLowerCase() !== "wal") {
          throw new Error(`SQLite persistence could not enable WAL mode at ${path}`);
        }
      }
      database.exec("PRAGMA synchronous = NORMAL");
      migrateSqliteAgentSchema(database);
      const fullTextSearch = installSqliteFts(database);
      const existingIdentity = database.query<{ agent_session_id: string }, []>(
        "SELECT agent_session_id FROM agent_identity WHERE singleton = 1",
      ).get();
      const agentSessionId = config.agentSessionId
        ?? (existingIdentity?.agent_session_id as AgentSessionId | undefined)
        ?? createAgentSessionId();
      const identityRecord = initializeAgentIdentity(database, agentSessionId, config.metadata);
      const backend = new SqliteAgentPersistence(path, database, identityRecord, fullTextSearch, ownerLock);
      for (const extension of config.extensions ?? []) await backend.installExtension(extension);
      return backend;
    } catch (error) {
      try {
        database.close();
      } finally {
        ownerLock?.close();
      }
      throw error;
    }
  }

  async transaction<T>(work: (transaction: PersistenceScope) => T | Promise<T>): Promise<T> {
    this.assertOpen();
    return await this.enqueueWrite(async () => {
      const committed: ConversationRecord[] = [];
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const scope = this.createScope(async (operation) => operation(), (records) => {
          committed.push(...records);
        });
        const result = await work(scope);
        this.database.exec("COMMIT");
        await this.notifyRecordsCommitted(committed);
        return result;
      } catch (error) {
        if (this.database.inTransaction) this.database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.writeTail;
    this.closed = true;
    try {
      // sqlite3_close_v2 safely finalizes Bun's cached prepared statements.
      this.database.close();
    } finally {
      this.ownerLock?.close();
    }
  }

  /** How far out-of-band messages were delivered, per conversation and provider context. */
  private createOutOfBandDelivery(runWrite: <T>(work: () => T) => Promise<T>): OutOfBandDeliveryPersistence {
    return {
      get: async (owner, providerContext) => Number(this.database.query<{ through_sequence: number }, [string, string]>(
        "SELECT through_sequence FROM out_of_band_delivery WHERE owner = ? AND provider_context = ?",
      ).get(owner, providerContext)?.through_sequence ?? 0),
      advance: async (owner, providerContext, throughSequence) => {
        await runWrite(() => {
          this.database.query(
            `INSERT INTO out_of_band_delivery(owner, provider_context, through_sequence) VALUES (?, ?, ?)
             ON CONFLICT(owner, provider_context)
             DO UPDATE SET through_sequence = MAX(through_sequence, excluded.through_sequence)`,
          ).run(owner, providerContext, throughSequence);
        });
      },
    };
  }

  private createScope(
    runWrite: WriteRunner,
    onAppended: (records: readonly ConversationRecord[]) => void | Promise<void>,
    readChannels: WriteRunner = runWrite,
  ): PersistenceScope {
    return Object.freeze({
      media: new SqliteMediaStore(this.database, runWrite),
      files: new SqliteSharedFiles(this.database),
      outOfBandDelivery: this.createOutOfBandDelivery(runWrite),
      conversations: new SqliteConversationPersistence(this.database, this.identityRecord.agentSessionId, runWrite),
      records: new SqliteConversationRecordPersistence(
        this.database,
        this.identityRecord.agentSessionId,
        runWrite,
        onAppended,
      ),
      messages: new SqliteConversationMessagePersistence(this.database),
      checkpoints: new SqliteCheckpointPersistence(this.database, runWrite),
      providerSessions: new SqliteProviderSessionPersistence(this.database, runWrite),
      metering: new SqliteMeteringPersistence(this.database, runWrite),
      internalInferences: new SqliteInternalInferenceRepository(this.database, runWrite),
      recoveryCheckpoints: new SqliteConversationRecoveryCheckpointRepository(this.database, runWrite),
      identity: new SqliteIdentityPersistence(
        this.database,
        this.identityRecord.agentSessionId,
        runWrite,
      ),
      identityDelivery: new SqliteIdentityDeliveryPersistence(this.database, runWrite),
      channels: new SqliteChannelPersistence(this.database, runWrite, readChannels),
      ...(this.ownerLock ? { workerDelivery: new SqliteWorkerDelivery(
        this.database, runWrite, readChannels, this.workerOwnerId,
      ) } : {}),
      ...(this.capabilities.fullTextSearch
        ? { search: new SqliteSearchPersistence(this.database) }
        : {}),
      auditOutbox: new SqliteAuditOutboxPersistence(this.database, runWrite),
      extensions: new SqliteExtensionCatalog(this.database),
    });
  }

  private async installExtension(extension: PersistenceExtension): Promise<void> {
    if (!/^[a-z][a-z0-9_.-]*$/i.test(extension.id)) {
      throw new Error(`invalid persistence extension id: ${extension.id}`);
    }
    if (!Number.isSafeInteger(extension.version) || extension.version < 1) {
      throw new Error(`invalid persistence extension version for ${extension.id}: ${extension.version}`);
    }
    if (this.installedExtensions.some((candidate) => candidate.id === extension.id)) {
      throw new Error(`duplicate persistence extension: ${extension.id}`);
    }

    await this.transaction(async (scope) => {
      const installed = await scope.extensions!.get(extension.id);
      const installedVersion = installed?.schemaVersion ?? 0;
      if (installedVersion > extension.version) {
        throw new Error(
          `persistence extension ${extension.id} schema ${installedVersion} is newer than ${extension.version}`,
        );
      }
      if (installedVersion === extension.version) return;
      await extension.migrate({
        extensionId: extension.id,
        installedVersion,
        execute: async (sql, parameters = []) => {
          runSql(this.database, sql, ...(parameters as SqlValue[]));
        },
      });
      const now = new Date().toISOString();
      runSql(this.database,
        `INSERT INTO persistence_extensions(extension_id, schema_version, installed_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(extension_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at`,
        extension.id,
        extension.version,
        installed?.installedAt ?? now,
        now,
      );
    });
    this.installedExtensions.push(extension);
  }

  private async notifyRecordsCommitted(records: readonly ConversationRecord[]): Promise<void> {
    if (records.length === 0) return;
    const owned = Object.freeze(records.map((record) => Object.freeze(structuredClone(record))));
    for (const extension of this.installedExtensions) {
      await extension.recordsCommitted?.(owned);
    }
  }

  private async autoWrite<T>(work: () => T): Promise<T> {
    this.assertOpen();
    return await this.enqueueWrite(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        if (this.database.inTransaction) this.database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  private enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(work, work);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SQLite persistence backend is closed");
  }
}

class SqliteConversationPersistence implements ConversationPersistence {
  constructor(
    private readonly database: Database,
    private readonly agentSessionId: AgentSessionId,
    private readonly runWrite: WriteRunner,
  ) {}

  async create(input: CreateAgentConversationInput): Promise<AgentConversationSummary> {
    if (input.agentSessionId !== this.agentSessionId) {
      throw new Error("conversation agentSessionId does not match the SQLite agent database");
    }
    if (!isAgentConversationId(input.agentConversationId)) {
      throw new Error(`invalid agent conversation id: ${input.agentConversationId}`);
    }
    return await this.runWrite(() => {
      if (conversationRow(this.database, input.agentConversationId)) {
        throw new PersistenceConflictError(`conversation already exists: ${input.agentConversationId}`);
      }
      const now = input.createdAt ?? new Date().toISOString();
      assertInstant(now, "conversation createdAt");
      runSql(this.database,
        `INSERT INTO conversations(
          agent_conversation_id, agent_session_id, title, created_at, updated_at, metadata,
          adopted, adopt_provider_session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.agentConversationId,
        input.agentSessionId,
        input.title ?? null,
        now,
        now,
        input.metadata ?? null,
        input.adoptProviderSessionId === undefined ? 0 : 1,
        input.adoptProviderSessionId ?? null,
      );
      const participants = input.participants?.length
        ? input.participants
        : [{ id: IMPLICIT_USER_PARTICIPANT_ID, kind: "user" as const }];
      for (const participant of participants) {
        ensureParticipantDirect(this.database, input.agentConversationId, participant, now);
      }
      return requireConversationSummary(this.database, input.agentConversationId);
    });
  }

  async get(agentConversationId: AgentConversationId): Promise<AgentConversationSummary | null> {
    const row = conversationRow(this.database, agentConversationId);
    return row ? summaryFromRow(this.database, row) : null;
  }

  async list(options: ConversationListOptions = {}): Promise<ConversationPage> {
    const page = this.listRows(options);
    return Object.freeze({
      conversations: Object.freeze(page.rows.map((row) => summaryFromRow(this.database, row))),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }

  async listPreviews(options: ConversationListOptions = {}): Promise<ConversationPreviewPage> {
    const page = this.listRows(options);
    if (page.rows.length === 0) return Object.freeze({ previews: Object.freeze([]) });
    const ids = page.rows.map((row) => row.agent_conversation_id);
    const placeholders = ids.map(() => "?").join(", ");
    const participantRows = this.database.query<{
      agent_conversation_id: string;
      participant_id: string;
      kind: string;
      name: string | null;
    }, string[]>(
      `SELECT cp.agent_conversation_id, p.participant_id, p.kind, p.name
       FROM conversation_participants cp
       JOIN participants p ON p.participant_id = cp.participant_id
       WHERE cp.agent_conversation_id IN (${placeholders})
       ORDER BY cp.agent_conversation_id, cp.joined_at, p.participant_id`,
    ).all(...ids);
    const participants = new Map<string, ParticipantRef[]>();
    for (const row of participantRows) {
      const group = participants.get(row.agent_conversation_id) ?? [];
      group.push(Object.freeze({
        id: row.participant_id,
        kind: row.kind as ParticipantRef["kind"],
        ...(row.name !== null ? { name: row.name } : {}),
      }));
      participants.set(row.agent_conversation_id, group);
    }
    const previewRows = this.database.query<{
      agent_conversation_id: string;
      record_id: string | null;
      sequence: number | null;
      timestamp: string | null;
      role: string | null;
      participant_id: string | null;
      preview_text: string | null;
      last_human_message_at: string | null;
    }, string[]>(
      `SELECT c.agent_conversation_id, r.record_id, r.sequence, r.timestamp,
              m.role, m.participant_id,
              substr(COALESCE(m.content_text, m.search_text), 1, 240) AS preview_text,
              c.last_human_message_at
       FROM conversations c
       LEFT JOIN conversation_records r ON r.row_id = (
         SELECT latest_r.row_id FROM conversation_records latest_r
         WHERE latest_r.agent_conversation_id = c.agent_conversation_id AND latest_r.kind = 'message'
         ORDER BY latest_r.sequence DESC LIMIT 1
       )
       LEFT JOIN conversation_messages m ON m.record_row_id = r.row_id
       WHERE c.agent_conversation_id IN (${placeholders})`,
    ).all(...ids);
    const previewsById = new Map(previewRows.map((row) => [row.agent_conversation_id, row]));
    const previews: AgentConversationPreview[] = page.rows.map((row) => {
      const preview = previewsById.get(row.agent_conversation_id)!;
      return Object.freeze({
        conversation: summaryFromRowWithParticipants(row, participants.get(row.agent_conversation_id) ?? []),
        ...(preview.record_id !== null ? { latestMessage: Object.freeze({
          recordId: preview.record_id,
          sequence: Number(preview.sequence),
          timestamp: preview.timestamp!,
          role: preview.role as "assistant" | "user",
          ...(preview.participant_id !== null ? { participantId: preview.participant_id } : {}),
          text: preview.preview_text ?? "",
        }) } : {}),
        ...(preview.last_human_message_at !== null
          ? { lastHumanMessageAt: preview.last_human_message_at }
          : {}),
      });
    });
    return Object.freeze({
      previews: Object.freeze(previews),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }

  private listRows(options: ConversationListOptions): { readonly rows: readonly ConversationRow[]; readonly nextCursor?: string } {
    const limit = boundedInteger(options.limit ?? 50, 1, 500, "conversation limit");
    const offset = decodeOffset(options.cursor);
    const where: string[] = ["c.agent_session_id = ?"];
    const parameters: SqlValue[] = [this.agentSessionId];
    if (!options.includeDeleted) where.push("c.deleted_at IS NULL");
    for (const participantId of options.participantIds ?? []) {
      where.push(`EXISTS (
        SELECT 1 FROM conversation_participants cp
        WHERE cp.agent_conversation_id = c.agent_conversation_id
          AND cp.participant_id = ?
      )`);
      parameters.push(participantId);
    }
    parameters.push(limit + 1, offset);
    const rows = this.database.query<ConversationRow, SqlValue[]>(
      `SELECT c.* FROM conversations c
       WHERE ${where.join(" AND ")}
       ORDER BY c.updated_at DESC, c.agent_conversation_id
       LIMIT ? OFFSET ?`,
    ).all(...parameters);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    return Object.freeze({
      rows: Object.freeze(selected),
      ...(hasMore ? { nextCursor: encodeOffset(offset + limit) } : {}),
    });
  }

  async renameParticipant(
    agentConversationId: AgentConversationId,
    participantId: string,
    name: string | undefined,
  ): Promise<void> {
    await this.runWrite(() => {
      requireConversation(this.database, agentConversationId);
      const linked = this.database.query<{ present: number }, [string, string]>(
        `SELECT 1 AS present FROM conversation_participants
         WHERE agent_conversation_id = ? AND participant_id = ?`,
      ).get(agentConversationId, participantId);
      if (!linked) throw new Error(`participant is not in conversation: ${participantId}`);
      runSql(this.database,
        "UPDATE participants SET name = ?, updated_at = ? WHERE participant_id = ?",
        name?.trim() || null,
        new Date().toISOString(),
        participantId,
      );
    });
  }

  async ensureParticipant(
    agentConversationId: AgentConversationId,
    participant: ParticipantRef,
  ): Promise<ParticipantRef> {
    return await this.runWrite(() => ensureParticipantDirect(
      this.database,
      agentConversationId,
      participant,
      new Date().toISOString(),
    ));
  }

  async delete(agentConversationId: AgentConversationId, deletedAt?: string): Promise<void> {
    await this.runWrite(() => {
      requireConversation(this.database, agentConversationId);
      const at = deletedAt ?? new Date().toISOString();
      assertInstant(at, "conversation deletedAt");
      runSql(this.database,
        "UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE agent_conversation_id = ?",
        at,
        at,
        agentConversationId,
      );
    });
  }
}

class SqliteConversationRecordPersistence implements ConversationRecordPersistence {
  constructor(
    private readonly database: Database,
    private readonly agentSessionId: AgentSessionId,
    private readonly runWrite: WriteRunner,
    private readonly onAppended: (records: readonly ConversationRecord[]) => void | Promise<void>,
  ) {}

  async append(record: NewConversationRecord): Promise<ConversationRecord> {
    const records = await this.appendMany([record]);
    return records[0]!;
  }

  async appendMany(records: readonly NewConversationRecord[]): Promise<readonly ConversationRecord[]> {
    if (records.length === 0) return Object.freeze([]);
    const appended = await this.runWrite(() => records.map((record) => this.appendDirect(record)));
    await this.onAppended(appended);
    return Object.freeze(appended);
  }

  async deleteForConversation(agentConversationId: AgentConversationId): Promise<number> {
    return await this.runWrite(() => {
      requireConversation(this.database, agentConversationId);
      // Counted first: the changes count of a DELETE also includes the detail rows and full-text entries
      // that go with each record (ON DELETE CASCADE and triggers), which are not records.
      const count = this.database.query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM conversation_records WHERE agent_conversation_id = ?",
      ).get(agentConversationId)?.n ?? 0;
      this.database.query("DELETE FROM conversation_records WHERE agent_conversation_id = ?").run(agentConversationId);
      this.database.query("DELETE FROM conversation_media WHERE owner = ?").run(agentConversationId);
      this.database.query("DELETE FROM out_of_band_delivery WHERE owner = ?").run(agentConversationId);
      return Number(count);
    });
  }

  async get(recordId: string): Promise<ConversationRecord | null> {
    const row = this.database.query<ConversationRecordRow, [string]>(
      "SELECT * FROM conversation_records WHERE record_id = ?",
    ).get(recordId);
    return row ? hydrateConversationRecords(this.database, [row])[0]! : null;
  }

  async list(
    agentConversationId: AgentConversationId,
    options: RecordListOptions = {},
  ): Promise<ConversationRecordPage> {
    requireConversation(this.database, agentConversationId);
    const limit = boundedInteger(options.limit ?? 100, 1, 1_000, "record limit");
    const offset = decodeOffset(options.cursor);
    const where = ["agent_conversation_id = ?"];
    const parameters: SqlValue[] = [agentConversationId];
    if (options.afterSequence !== undefined) {
      where.push("sequence > ?");
      parameters.push(nonNegativeInteger(options.afterSequence, "afterSequence"));
    }
    if (options.throughSequence !== undefined) {
      where.push("sequence <= ?");
      parameters.push(nonNegativeInteger(options.throughSequence, "throughSequence"));
    }
    if (options.kinds?.length) {
      for (const kind of options.kinds) {
        if (!isConversationRecordKind(kind)) throw new Error(`unknown record kind: ${kind}`);
      }
      where.push(`kind IN (${options.kinds.map(() => "?").join(", ")})`);
      parameters.push(...options.kinds);
    }
    if (options.operationId !== undefined) {
      where.push("operation_id = ?");
      parameters.push(nonblank(options.operationId, "operationId"));
    }
    parameters.push(limit + 1, offset);
    const rows = this.database.query<ConversationRecordRow, SqlValue[]>(
      `SELECT * FROM conversation_records
       WHERE ${where.join(" AND ")}
       ORDER BY sequence
       LIMIT ? OFFSET ?`,
    ).all(...parameters);
    const hasMore = rows.length > limit;
    return Object.freeze({
      records: hydrateConversationRecords(this.database, rows.slice(0, limit)),
      ...(hasMore ? { nextCursor: encodeOffset(offset + limit) } : {}),
    });
  }

  async listRecent(
    agentConversationId: AgentConversationId,
    options: RecentItemPageOptions,
  ): Promise<RecentItemPage>;
  async listRecent(
    agentConversationId: AgentConversationId,
    options?: RecentRecordPageOptions,
  ): Promise<RecentRecordPage>;
  async listRecent(
    agentConversationId: AgentConversationId,
    options: RecentRecordPageOptions | RecentItemPageOptions = {},
  ): Promise<RecentRecordPage | RecentItemPage> {
    const conversation = requireConversation(this.database, agentConversationId);
    const kinds = [...new Set(options.kinds ?? [])].sort();
    for (const kind of kinds) {
      if (!isConversationRecordKind(kind)) throw new Error(`unknown record kind: ${kind}`);
    }
    const detail = options.detail ?? "full";
    if (detail !== "full" && detail !== "summary") throw new Error(`unknown record detail: ${String(detail)}`);
    const fold = options.fold === true;
    const unit = options.agentMessages === undefined ? "records" : "agentMessages";
    const cursor = options.olderCursor
      ? decodeRecentCursor(options.olderCursor, agentConversationId, kinds, unit)
      : null;
    const snapshotSequence = cursor?.snapshotSequence ?? Number(conversation.latest_sequence);
    const beforeSequence = cursor?.beforeSequence ?? snapshotSequence + 1;
    const page = unit === "records"
      ? this.recentRecordRange(agentConversationId, kinds, snapshotSequence, beforeSequence,
        boundedInteger(options.limit ?? 50, 1, 500, "recent record limit"))
      : this.recentAgentMessagePage(agentConversationId, kinds, snapshotSequence, beforeSequence,
        boundedInteger(options.agentMessages!, 1, 10_000, "agentMessages"),
        boundedInteger(options.limit ?? 2_000, 1, 10_000, "recent page limit"), fold);
    const records = detail === "summary" ? page.records.map(summarizeRecord) : page.records;
    const rest = {
      snapshotSequence,
      ...(page.olderBefore !== undefined
        ? { olderCursor: encodeRecentCursor({
            conversationId: agentConversationId,
            snapshotSequence,
            beforeSequence: page.olderBefore,
            kinds,
            unit,
          }) }
        : {}),
      ...(page.truncated ? { truncated: true as const } : {}),
    };
    if (!fold) return Object.freeze({ records: Object.freeze(records), ...rest });
    const items = reconcileConversationTimeline([], records);
    return Object.freeze({
      items: detail === "summary" ? Object.freeze(items.map(summarizeItem)) : items,
      ...rest,
    });
  }

  /** The newest `limit` matching records below `beforeSequence`. */
  private recentRecordRange(
    agentConversationId: AgentConversationId,
    kinds: readonly string[],
    snapshotSequence: number,
    beforeSequence: number,
    limit: number,
  ): RecentPageSlice {
    const where = ["agent_conversation_id = ?", "sequence <= ?", "sequence < ?"];
    const parameters: SqlValue[] = [agentConversationId, snapshotSequence, beforeSequence];
    if (kinds.length) {
      where.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
      parameters.push(...kinds);
    }
    parameters.push(limit + 1);
    const rows = this.database.query<ConversationRecordRow, SqlValue[]>(
      `SELECT * FROM conversation_records WHERE ${where.join(" AND ")}
       ORDER BY sequence DESC LIMIT ?`,
    ).all(...parameters);
    const selected = rows.slice(0, limit);
    const oldest = selected.at(-1);
    return {
      records: hydrateConversationRecords(this.database, selected.reverse()),
      ...(rows.length > limit && oldest ? { olderBefore: Number(oldest.sequence) } : {}),
    };
  }

  /**
   * The items that began after the agent message `count + 1` places below `beforeSequence`, with
   * every revision they have up to the snapshot. An item's revisions all lie in its operation, so
   * the records of the operations the range touches are enough to find where each item began.
   */
  private recentAgentMessagePage(
    agentConversationId: AgentConversationId,
    kinds: readonly string[],
    snapshotSequence: number,
    beforeSequence: number,
    count: number,
    limit: number,
    fold: boolean,
  ): RecentPageSlice {
    const boundaries = this.database.query<{ first: number }, [string, number, number, number]>(`
      SELECT MIN(r.sequence) AS first
      FROM conversation_records r
      JOIN conversation_messages m ON m.record_row_id = r.row_id
      WHERE r.agent_conversation_id = ? AND r.kind = 'message' AND m.role = 'assistant' AND r.sequence <= ?
      GROUP BY COALESCE(m.logical_message_id, r.record_id)
      HAVING first < ?
      ORDER BY first DESC
      LIMIT ?
    `).all(agentConversationId, snapshotSequence, beforeSequence, count + 1);
    const lowest = boundaries.length > count ? Number(boundaries[count]!.first) : 0;

    const inRange = this.database.query<ConversationRecordRow, [string, number, number, number]>(`
      SELECT * FROM conversation_records
      WHERE agent_conversation_id = ? AND sequence > ? AND sequence < ? AND sequence <= ?
      ORDER BY sequence
    `).all(agentConversationId, lowest, beforeSequence, snapshotSequence);
    const operations = [...new Set(inRange.flatMap((row) => row.operation_id === null ? [] : [row.operation_id]))];
    const outside: ConversationRecordRow[] = [];
    for (let index = 0; index < operations.length; index += 500) {
      const chunk = operations.slice(index, index + 500);
      outside.push(...this.database.query<ConversationRecordRow, SqlValue[]>(`
        SELECT * FROM conversation_records
        WHERE agent_conversation_id = ? AND operation_id IN (${chunk.map(() => "?").join(", ")})
          AND sequence <= ? AND (sequence <= ? OR sequence >= ?)
      `).all(agentConversationId, ...chunk, snapshotSequence, lowest, beforeSequence));
    }
    const all = hydrateConversationRecords(this.database,
      [...inRange, ...outside].sort((left, right) => Number(left.sequence) - Number(right.sequence)));

    const firstOf = new Map<string, number>();
    for (const record of all) {
      const id = conversationTimelineItemId(record);
      if (!firstOf.has(id)) firstOf.set(id, record.sequence);
    }
    const startOf = (record: ConversationRecord) => firstOf.get(conversationTimelineItemId(record))!;
    const kept = all.filter((record) => {
      const start = startOf(record);
      return start > lowest && start < beforeSequence && (kinds.length === 0 || kinds.includes(record.kind));
    });

    // Over the limit: keep the newest whole items, and let the next page begin below them.
    const starts = [...new Set(kept.map(startOf))].sort((left, right) => right - left);
    const sizes = new Map<number, number>();
    for (const record of kept) sizes.set(startOf(record), (sizes.get(startOf(record)) ?? 0) + 1);
    let used = 0;
    let oldestKept: number | undefined;
    for (const start of starts) {
      const size = fold ? 1 : sizes.get(start)!;
      if (oldestKept !== undefined && used + size > limit) {
        return {
          records: kept.filter((record) => startOf(record) >= oldestKept!),
          olderBefore: oldestKept,
          truncated: true,
        };
      }
      used += size;
      oldestKept = start;
    }
    return {
      records: kept,
      ...(lowest > 0 ? { olderBefore: lowest + 1 } : {}),
    };
  }

  private appendDirect(input: NewConversationRecord): ConversationRecord {
    if (input.agentSessionId !== this.agentSessionId) {
      throw new Error("record agentSessionId does not match the SQLite agent database");
    }
    if (!isConversationRecordKind(input.kind)) throw new Error(`unknown record kind: ${input.kind}`);
    if (!input.recordId.trim()) throw new Error("recordId cannot be blank");
    assertInstant(input.timestamp, "record timestamp");
    requireConversation(this.database, input.agentConversationId);

    const normalized = input.kind === "message" && input.role === "user" && !input.participantId
      ? { ...input, participantId: IMPLICIT_USER_PARTICIPANT_ID }
      : input;
    let humanMessageAt: string | null = null;
    if (normalized.kind === "message" && normalized.participantId) {
      const known = this.database.query<{ kind: ParticipantRef["kind"]; name: string | null }, [string]>(
        "SELECT kind, name FROM participants WHERE participant_id = ?",
      ).get(normalized.participantId);
      ensureParticipantDirect(this.database, normalized.agentConversationId, {
        id: normalized.participantId,
        kind: known?.kind ?? (normalized.role === "user" ? "user" : "agent"),
        ...(known?.name ? { name: known.name } : {}),
      }, normalized.timestamp);
      if (normalized.role === "user" && (known?.kind ?? "user") === "user") {
        humanMessageAt = normalized.timestamp;
      }
    }
    const existing = this.database.query<ConversationRecordRow, [string]>(
      "SELECT * FROM conversation_records WHERE record_id = ?",
    ).get(normalized.recordId);
    if (existing) {
      const hydrated = hydrateConversationRecords(this.database, [existing])[0]!;
      if (sameConversationRecord(hydrated, normalized)) {
        return hydrated;
      }
      throw new PersistenceConflictError(`record id already exists with different content: ${normalized.recordId}`);
    }

    const next = this.database.query<{ sequence: number }, [string, string]>(
      `UPDATE conversations
       SET latest_sequence = latest_sequence + 1, updated_at = ?
       WHERE agent_conversation_id = ? AND deleted_at IS NULL
       RETURNING latest_sequence AS sequence`,
    ).get(new Date().toISOString(), normalized.agentConversationId);
    if (!next) throw new Error(`conversation is deleted: ${normalized.agentConversationId}`);
    const inserted = this.database.query<{ row_id: number }, SqlValue[]>(
      `INSERT INTO conversation_records(
        record_id, agent_session_id, agent_conversation_id, sequence,
        kind, timestamp, operation_id, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING row_id`,
    ).get(
      normalized.recordId,
      normalized.agentSessionId,
      normalized.agentConversationId,
      next.sequence,
      normalized.kind,
      normalized.timestamp,
      operationIdFromRecord(normalized),
      normalized.metadata ?? null,
    );
    if (!inserted) throw new Error(`could not persist conversation record: ${normalized.recordId}`);
    insertConversationRecordDetail(this.database, Number(inserted.row_id), normalized);
    if (humanMessageAt) {
      runSql(this.database,
        "UPDATE conversations SET last_human_message_at = ? WHERE agent_conversation_id = ?",
        humanMessageAt, normalized.agentConversationId);
    }
    return Object.freeze({ ...normalized, sequence: next.sequence }) as ConversationRecord;
  }
}

class SqliteConversationMessagePersistence implements ConversationMessagePersistence {
  constructor(private readonly database: Database) {}

  async list(
    agentConversationId: AgentConversationId,
    options: MessageListOptions = {},
  ): Promise<MessagePage> {
    requireConversation(this.database, agentConversationId);
    const limit = boundedInteger(options.limit ?? 100, 1, 1_000, "message limit");
    const offset = decodeOffset(options.cursor);
    const where = ["r.agent_conversation_id = ?", "r.kind = 'message'"];
    const parameters: SqlValue[] = [agentConversationId];
    if (options.afterSequence !== undefined) {
      where.push("r.sequence > ?");
      parameters.push(nonNegativeInteger(options.afterSequence, "afterSequence"));
    }
    if (options.throughSequence !== undefined) {
      where.push("r.sequence <= ?");
      parameters.push(nonNegativeInteger(options.throughSequence, "throughSequence"));
    }
    if (options.participantIds?.length) {
      where.push(`m.participant_id IN (${options.participantIds.map(() => "?").join(", ")})`);
      parameters.push(...options.participantIds);
    }
    // Message snapshots remain in the ordered record stream, but the message API
    // returns only the latest revision visible at the requested sequence boundary.
    where.push(`(m.logical_message_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM conversation_messages newer_m
      JOIN conversation_records newer_r ON newer_r.row_id = newer_m.record_row_id
      WHERE newer_r.agent_conversation_id = r.agent_conversation_id
        AND newer_m.logical_message_id = m.logical_message_id
        AND newer_r.sequence > r.sequence
        ${options.throughSequence === undefined ? "" : "AND newer_r.sequence <= ?"}
    ))`);
    if (options.throughSequence !== undefined) {
      parameters.push(nonNegativeInteger(options.throughSequence, "throughSequence"));
    }
    parameters.push(limit + 1, offset);
    const rows = this.database.query<ConversationRecordRow, SqlValue[]>(
      `SELECT r.* FROM conversation_records r
       JOIN conversation_messages m ON m.record_row_id = r.row_id
       WHERE ${where.join(" AND ")}
       ORDER BY r.sequence
       LIMIT ? OFFSET ?`,
    ).all(...parameters);
    const hasMore = rows.length > limit;
    return Object.freeze({
      messages: hydrateConversationRecords(this.database, rows.slice(0, limit)) as readonly MessageRecord[],
      ...(hasMore ? { nextCursor: encodeOffset(offset + limit) } : {}),
    });
  }
}

class SqliteCheckpointPersistence implements ConversationCheckpointPersistence {
  constructor(private readonly database: Database, private readonly runWrite: WriteRunner) {}

  async get(agentConversationId: AgentConversationId): Promise<ConversationRuntimeCheckpoint | null> {
    const row = this.database.query<{
      agent_conversation_id: string;
      revision: number;
      covered_sequence: number;
      state_json: string;
      updated_at: string;
    }, [string]>("SELECT * FROM conversation_checkpoints WHERE agent_conversation_id = ?").get(agentConversationId);
    return row ? Object.freeze({
      agentConversationId: row.agent_conversation_id as AgentConversationId,
      revision: Number(row.revision),
      coveredSequence: Number(row.covered_sequence),
      state: parseJson(row.state_json),
      updatedAt: row.updated_at,
    }) : null;
  }

  async put(
    checkpoint: ConversationRuntimeCheckpoint,
    expectedRevision?: number,
  ): Promise<ConversationRuntimeCheckpoint> {
    return await this.runWrite(() => {
      requireConversation(this.database, checkpoint.agentConversationId);
      const current = this.database.query<{ revision: number }, [string]>(
        "SELECT revision FROM conversation_checkpoints WHERE agent_conversation_id = ?",
      ).get(checkpoint.agentConversationId);
      if (expectedRevision !== undefined && Number(current?.revision ?? 0) !== expectedRevision) {
        throw new PersistenceConflictError(
          `checkpoint revision mismatch: expected ${expectedRevision}, found ${Number(current?.revision ?? 0)}`,
        );
      }
      if (current && checkpoint.revision <= Number(current.revision)) {
        throw new PersistenceConflictError("checkpoint revision must increase");
      }
      runSql(this.database,
        `INSERT INTO conversation_checkpoints(
          agent_conversation_id, revision, covered_sequence, state_json, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_conversation_id) DO UPDATE SET
          revision = excluded.revision,
          covered_sequence = excluded.covered_sequence,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at`,
        checkpoint.agentConversationId,
        nonNegativeInteger(checkpoint.revision, "checkpoint revision"),
        nonNegativeInteger(checkpoint.coveredSequence, "checkpoint coveredSequence"),
        JSON.stringify(checkpoint.state),
        checkpoint.updatedAt,
      );
      return Object.freeze(structuredClone(checkpoint));
    });
  }
}

class SqliteProviderSessionPersistence implements ProviderSessionPersistence {
  constructor(private readonly database: Database, private readonly runWrite: WriteRunner) {}

  async append(record: ProviderSessionRecord): Promise<void> {
    await this.runWrite(() => {
      requireConversation(this.database, record.agentConversationId);
      const existing = this.database.query<{ present: number }, [string]>(
        "SELECT 1 AS present FROM provider_sessions WHERE provider_session_record_id = ?",
      ).get(record.providerSessionRecordId);
      if (existing) return;
      if (!record.deactivatedAt) {
        runSql(this.database,
          `UPDATE provider_sessions SET deactivated_at = ?
           WHERE agent_conversation_id = ? AND deactivated_at IS NULL`,
          record.activatedAt,
          record.agentConversationId,
        );
      }
      runSql(this.database,
        `INSERT INTO provider_sessions(
          provider_session_record_id, agent_conversation_id, internal_session_id,
          adapter_id, mode, model, activated_at, deactivated_at, transition_id, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.providerSessionRecordId,
        record.agentConversationId,
        record.internalSessionId,
        record.adapterId,
        record.mode,
        record.model ?? null,
        record.activatedAt,
        record.deactivatedAt ?? null,
        record.transitionId ?? null,
        record.metadata ?? null,
      );
    });
  }

  async list(agentConversationId: AgentConversationId): Promise<readonly ProviderSessionRecord[]> {
    requireConversation(this.database, agentConversationId);
    const rows = this.database.query<Record<string, unknown>, [string]>(
      `SELECT * FROM provider_sessions
       WHERE agent_conversation_id = ?
       ORDER BY activated_at, provider_session_record_id`,
    ).all(agentConversationId);
    return Object.freeze(rows.map(providerSessionFromRow));
  }

  async active(agentConversationId: AgentConversationId): Promise<ProviderSessionRecord | null> {
    requireConversation(this.database, agentConversationId);
    const row = this.database.query<Record<string, unknown>, [string]>(
      `SELECT * FROM provider_sessions
       WHERE agent_conversation_id = ? AND deactivated_at IS NULL`,
    ).get(agentConversationId);
    return row ? providerSessionFromRow(row) : null;
  }

  async conversationsUsing(internalSessionId: string): Promise<readonly AgentConversationId[]> {
    return conversationsUsingProviderSession(this.database, internalSessionId);
  }
}

class SqliteMeteringPersistence implements MeteringPersistence {
  constructor(private readonly database: Database, private readonly runWrite: WriteRunner) {}

  async commit(input: MeteringCommitInput): Promise<PersistedConversationMeteringState> {
    return await this.runWrite(() => {
      requireConversation(this.database, input.agentConversationId);
      const operationId = nonblank(input.record.operationId, "metering operationId");
      const existing = this.database.query<{ record_json: string | null }, [string, string]>(
        `SELECT record_json FROM metering_records
         WHERE agent_conversation_id = ? AND operation_id = ?`,
      ).get(input.agentConversationId, operationId);
      const serializedRecord = JSON.stringify(input.record);
      if (existing) {
        if (existing.record_json !== null && existing.record_json !== serializedRecord) {
          throw new PersistenceConflictError(
            `metering operation already exists with different content: ${operationId}`,
          );
        }
        if (input.meteringRecords === "all" && existing.record_json === null) {
          runSql(this.database,
            `UPDATE metering_records SET record_json = ?
             WHERE agent_conversation_id = ? AND operation_id = ?`,
            serializedRecord,
            input.agentConversationId,
            operationId,
          );
        }
        const current = readMeteringState(this.database, input.agentConversationId);
        if (!current) {
          throw new PersistenceConflictError(
            `metering operation ${operationId} exists without restoration state`,
          );
        }
        return current;
      }

      const current = readMeteringState(this.database, input.agentConversationId);
      if (input.record.nextState.agentSessionId !== input.record.agentSessionId) {
        throw new PersistenceConflictError("metering record and next state belong to different agents");
      }
      if (current && input.record.nextState.operationCount !== current.state.operationCount + 1) {
        throw new PersistenceConflictError(
          `metering operation count mismatch: expected ${current.state.operationCount + 1}, found ${input.record.nextState.operationCount}`,
        );
      }
      if (!current && input.record.nextState.operationCount !== 1) {
        throw new PersistenceConflictError(
          `initial metering operation count must be 1, found ${input.record.nextState.operationCount}`,
        );
      }

      runSql(this.database,
        `INSERT INTO metering_records(
          agent_conversation_id, operation_id, internal_session_id, adapter_id,
          operation_kind, outcome, completed_at, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.agentConversationId,
        operationId,
        input.record.internalSessionId,
        input.record.provider.adapterId,
        input.record.operationKind,
        input.record.outcome,
        input.record.completedAt,
        input.meteringRecords === "none" ? null : serializedRecord,
      );

      const revision = (current?.revision ?? 0) + 1;
      const updatedAt = input.updatedAt ?? new Date().toISOString();
      runSql(this.database,
        `INSERT INTO conversation_metering_state(
          agent_conversation_id, revision, state_json, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(agent_conversation_id) DO UPDATE SET
          revision = excluded.revision,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at`,
        input.agentConversationId,
        revision,
        JSON.stringify(input.record.nextState),
        updatedAt,
      );
      if (typeof input.meteringRecords === "object") {
        const retain = boundedInteger(
          input.meteringRecords.retain,
          0,
          1_000_000,
          "metering record retention",
        );
        runSql(this.database,
          `UPDATE metering_records SET record_json = NULL
           WHERE agent_conversation_id = ? AND operation_id NOT IN (
             SELECT operation_id FROM metering_records
             WHERE agent_conversation_id = ? AND record_json IS NOT NULL
             ORDER BY completed_at DESC, operation_id DESC LIMIT ?
           )`,
          input.agentConversationId,
          input.agentConversationId,
          retain,
        );
      }
      return Object.freeze({
        agentConversationId: input.agentConversationId,
        revision,
        state: structuredClone(input.record.nextState),
        updatedAt,
      });
    });
  }

  async state(agentConversationId: AgentConversationId): Promise<PersistedConversationMeteringState | null> {
    requireConversation(this.database, agentConversationId);
    return readMeteringState(this.database, agentConversationId);
  }

  async saveState(
    agentConversationId: AgentConversationId,
    state: AgentSessionMeteringState,
    updatedAt = new Date().toISOString(),
  ): Promise<PersistedConversationMeteringState> {
    return await this.runWrite(() => {
      requireConversation(this.database, agentConversationId);
      const current = readMeteringState(this.database, agentConversationId);
      const serialized = JSON.stringify(state);
      if (current && JSON.stringify(current.state) === serialized) return current;
      if (current && state.operationCount < current.state.operationCount) {
        throw new PersistenceConflictError("metering state cannot move to an earlier operation count");
      }
      const revision = (current?.revision ?? 0) + 1;
      runSql(this.database,
        `INSERT INTO conversation_metering_state(
          agent_conversation_id, revision, state_json, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(agent_conversation_id) DO UPDATE SET
          revision = excluded.revision,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at`,
        agentConversationId,
        revision,
        serialized,
        updatedAt,
      );
      return Object.freeze({
        agentConversationId,
        revision,
        state: structuredClone(state),
        updatedAt,
      });
    });
  }

  async list(
    agentConversationId: AgentConversationId,
    options: MeteringRecordListOptions = {},
  ): Promise<MeteringRecordPage> {
    requireConversation(this.database, agentConversationId);
    const limit = boundedInteger(options.limit ?? 100, 1, 1_000, "metering list limit");
    const offset = decodeOffset(options.cursor);
    const rows = this.database.query<{ record_json: string }, [string, number, number]>(
      `SELECT record_json FROM metering_records
       WHERE agent_conversation_id = ? AND record_json IS NOT NULL
       ORDER BY completed_at, operation_id
       LIMIT ? OFFSET ?`,
    ).all(agentConversationId, limit + 1, offset);
    const hasMore = rows.length > limit;
    return Object.freeze({
      records: Object.freeze(rows.slice(0, limit).map((row) => Object.freeze(
        JSON.parse(row.record_json) as OperationMeteringRecord,
      ))),
      ...(hasMore ? { nextCursor: encodeOffset(offset + limit) } : {}),
    });
  }

  async get(
    agentConversationId: AgentConversationId,
    operationId: string,
  ): Promise<OperationMeteringRecord | null> {
    requireConversation(this.database, agentConversationId);
    const row = this.database.query<{ record_json: string | null }, [string, string]>(
      `SELECT record_json FROM metering_records
       WHERE agent_conversation_id = ? AND operation_id = ?`,
    ).get(agentConversationId, nonblank(operationId, "metering operationId"));
    return row?.record_json
      ? Object.freeze(JSON.parse(row.record_json) as OperationMeteringRecord)
      : null;
  }

  async commitAgent(input: AgentMeteringCommitInput): Promise<PersistedAgentMeteringState> {
    return await this.runWrite(() => {
      if (input.agentSessionId !== input.record.agentSessionId) {
        throw new PersistenceConflictError("agent metering record belongs to another agent");
      }
      const operationId = nonblank(input.record.operationId, "metering operationId");
      const existing = this.database.query<{ record_json: string | null }, [string, string]>(
        `SELECT record_json FROM agent_metering_records
         WHERE agent_session_id = ? AND operation_id = ?`,
      ).get(input.agentSessionId, operationId);
      const serializedRecord = JSON.stringify(input.record);
      if (existing) {
        if (existing.record_json !== null && existing.record_json !== serializedRecord) {
          throw new PersistenceConflictError(
            `agent metering operation already exists with different content: ${operationId}`,
          );
        }
        if (input.meteringRecords === "all" && existing.record_json === null) {
          runSql(this.database,
            `UPDATE agent_metering_records SET record_json = ?
             WHERE agent_session_id = ? AND operation_id = ?`,
            serializedRecord, input.agentSessionId, operationId,
          );
        }
        const current = readAgentMeteringState(this.database, input.agentSessionId);
        if (!current) {
          throw new PersistenceConflictError(
            `agent metering operation ${operationId} exists without restoration state`,
          );
        }
        return current;
      }

      const current = readAgentMeteringState(this.database, input.agentSessionId);
      const expectedCount = (current?.state.operationCount ?? 0) + 1;
      if (input.record.nextState.operationCount !== expectedCount) {
        throw new PersistenceConflictError(
          `agent metering operation count mismatch: expected ${expectedCount}, found ${input.record.nextState.operationCount}`,
        );
      }
      runSql(this.database,
        `INSERT INTO agent_metering_records(
          agent_session_id, operation_id, internal_session_id, adapter_id,
          operation_kind, outcome, completed_at, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.agentSessionId, operationId, input.record.internalSessionId,
        input.record.provider.adapterId, input.record.operationKind, input.record.outcome,
        input.record.completedAt, input.meteringRecords === "none" ? null : serializedRecord,
      );
      const revision = (current?.revision ?? 0) + 1;
      const updatedAt = input.updatedAt ?? new Date().toISOString();
      runSql(this.database,
        `INSERT INTO agent_metering_state(agent_session_id, revision, state_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_session_id) DO UPDATE SET
           revision = excluded.revision,
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
        input.agentSessionId, revision, JSON.stringify(input.record.nextState), updatedAt,
      );
      if (typeof input.meteringRecords === "object") {
        const retain = boundedInteger(input.meteringRecords.retain, 0, 1_000_000, "metering record retention");
        runSql(this.database,
          `UPDATE agent_metering_records SET record_json = NULL
           WHERE agent_session_id = ? AND operation_id NOT IN (
             SELECT operation_id FROM agent_metering_records
             WHERE agent_session_id = ? AND record_json IS NOT NULL
             ORDER BY completed_at DESC, operation_id DESC LIMIT ?
           )`,
          input.agentSessionId, input.agentSessionId, retain,
        );
      }
      return Object.freeze({
        agentSessionId: input.agentSessionId,
        revision,
        state: structuredClone(input.record.nextState),
        updatedAt,
      });
    });
  }

  async agentState(agentSessionId: AgentSessionId): Promise<PersistedAgentMeteringState | null> {
    return readAgentMeteringState(this.database, agentSessionId);
  }

  async listAgent(
    agentSessionId: AgentSessionId,
    options: MeteringRecordListOptions = {},
  ): Promise<MeteringRecordPage> {
    const limit = boundedInteger(options.limit ?? 100, 1, 1_000, "metering list limit");
    const offset = decodeOffset(options.cursor);
    const rows = this.database.query<{ record_json: string }, [string, number, number]>(
      `SELECT record_json FROM agent_metering_records
       WHERE agent_session_id = ? AND record_json IS NOT NULL
       ORDER BY completed_at, operation_id LIMIT ? OFFSET ?`,
    ).all(agentSessionId, limit + 1, offset);
    const hasMore = rows.length > limit;
    return Object.freeze({
      records: Object.freeze(rows.slice(0, limit).map((row) => Object.freeze(
        JSON.parse(row.record_json) as OperationMeteringRecord,
      ))),
      ...(hasMore ? { nextCursor: encodeOffset(offset + limit) } : {}),
    });
  }

  async getAgent(
    agentSessionId: AgentSessionId,
    operationId: string,
  ): Promise<OperationMeteringRecord | null> {
    const row = this.database.query<{ record_json: string | null }, [string, string]>(
      `SELECT record_json FROM agent_metering_records
       WHERE agent_session_id = ? AND operation_id = ?`,
    ).get(agentSessionId, nonblank(operationId, "metering operationId"));
    return row?.record_json
      ? Object.freeze(JSON.parse(row.record_json) as OperationMeteringRecord)
      : null;
  }
}

function readMeteringState(
  database: Database,
  agentConversationId: AgentConversationId,
): PersistedConversationMeteringState | null {
  const row = database.query<{
    agent_conversation_id: string;
    revision: number;
    state_json: string;
    updated_at: string;
  }, [string]>(
    "SELECT * FROM conversation_metering_state WHERE agent_conversation_id = ?",
  ).get(agentConversationId);
  return row ? Object.freeze({
    agentConversationId: row.agent_conversation_id as AgentConversationId,
    revision: Number(row.revision),
    state: Object.freeze(JSON.parse(row.state_json) as AgentSessionMeteringState),
    updatedAt: row.updated_at,
  }) : null;
}

function readAgentMeteringState(
  database: Database,
  agentSessionId: AgentSessionId,
): PersistedAgentMeteringState | null {
  const row = database.query<{
    agent_session_id: string;
    revision: number;
    state_json: string;
    updated_at: string;
  }, [string]>("SELECT * FROM agent_metering_state WHERE agent_session_id = ?").get(agentSessionId);
  return row ? Object.freeze({
    agentSessionId: row.agent_session_id as AgentSessionId,
    revision: Number(row.revision),
    state: Object.freeze(JSON.parse(row.state_json) as AgentSessionMeteringState),
    updatedAt: row.updated_at,
  }) : null;
}

class SqliteIdentityPersistence implements IdentityPersistence {
  constructor(
    private readonly database: Database,
    private readonly agentSessionId: AgentSessionId,
    private readonly runWrite: WriteRunner,
  ) {}

  async append(
    observations: readonly NewIdentityMemoryObservation[],
  ): Promise<readonly IdentityMemoryObservation[]> {
    if (observations.length === 0) return Object.freeze([]);
    return await this.runWrite(() => Object.freeze(observations.map((observation) => {
      if (observation.agentSessionId !== this.agentSessionId) {
        throw new Error("identity observation belongs to another agent");
      }
      requireConversation(this.database, observation.sourceConversationId);
      const existing = this.database.query<Record<string, unknown>, [string]>(
        "SELECT * FROM identity_memories WHERE memory_id = ?",
      ).get(observation.memoryId);
      if (existing) {
        const persisted = identityMemoryFromRow(existing);
        const comparable = {
          memoryId: persisted.memoryId,
          agentSessionId: persisted.agentSessionId,
          sourceConversationId: persisted.sourceConversationId,
          sourceRecordIds: persisted.sourceRecordIds,
          ...(persisted.participantId ? { participantId: persisted.participantId } : {}),
          kind: persisted.kind,
          content: persisted.content,
          createdAt: persisted.createdAt,
          ...(persisted.metadata ? { metadata: persisted.metadata } : {}),
        };
        if (JSON.stringify(comparable) !== JSON.stringify(observation)) {
          throw new PersistenceConflictError(
            `identity memory id already exists with different content: ${observation.memoryId}`,
          );
        }
        return persisted;
      }
      if (!observation.memoryId.trim()) throw new Error("identity memoryId cannot be blank");
      assertInstant(observation.createdAt, "identity memory createdAt");
      const next = this.database.query<{ sequence: number }, []>(
        `UPDATE identity_state
         SET observed_through_sequence = observed_through_sequence + 1
         WHERE singleton = 1
         RETURNING observed_through_sequence AS sequence`,
      ).get();
      if (!next) throw new Error("identity state is unavailable");
      runSql(this.database,
        `INSERT INTO identity_memories(
          memory_id, agent_session_id, sequence, source_conversation_id,
          source_record_ids_json, participant_id, kind, content_json, created_at, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        observation.memoryId,
        observation.agentSessionId,
        next.sequence,
        observation.sourceConversationId,
        JSON.stringify(observation.sourceRecordIds),
        observation.participantId ?? null,
        observation.kind,
        JSON.stringify(observation.content),
        observation.createdAt,
        observation.metadata ?? null,
      );
      return Object.freeze({ ...structuredClone(observation), sequence: next.sequence });
    })));
  }

  async listAfter(sequence: number, limit = 100): Promise<readonly IdentityMemoryObservation[]> {
    const rows = this.database.query<Record<string, unknown>, [number, number]>(
      `SELECT * FROM identity_memories
       WHERE sequence > ? ORDER BY sequence LIMIT ?`,
    ).all(nonNegativeInteger(sequence, "identity sequence"), boundedInteger(limit, 1, 1_000, "identity limit"));
    return Object.freeze(rows.map(identityMemoryFromRow));
  }

  async latestSnapshot(): Promise<PersistedIdentitySnapshot | null> {
    const row = this.database.query<Record<string, unknown>, []>(
      "SELECT * FROM identity_snapshots ORDER BY version DESC LIMIT 1",
    ).get();
    return row ? identitySnapshotFromRow(row) : null;
  }

  async publishSnapshot(snapshot: PersistedIdentitySnapshot, expectedVersion?: number): Promise<void> {
    await this.runWrite(() => {
      if (snapshot.agentSessionId !== this.agentSessionId) {
        throw new Error("identity snapshot belongs to another agent");
      }
      const state = identityProjectionState(this.database, this.agentSessionId);
      const latest = this.database.query<{ version: number }, []>(
        "SELECT version FROM identity_snapshots ORDER BY version DESC LIMIT 1",
      ).get();
      const currentVersion = Number(latest?.version ?? 0);
      if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
        throw new PersistenceConflictError(
          `identity snapshot version mismatch: expected ${expectedVersion}, found ${currentVersion}`,
        );
      }
      if (snapshot.version <= currentVersion) {
        throw new PersistenceConflictError("identity snapshot version must increase");
      }
      if (snapshot.processedThroughSequence > state.observedThroughSequence) {
        throw new Error("identity snapshot cannot process observations that do not exist");
      }
      runSql(this.database,
        `INSERT INTO identity_snapshots(
          snapshot_id, agent_session_id, version, processed_through_sequence, value_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        snapshot.snapshotId,
        snapshot.agentSessionId,
        snapshot.version,
        snapshot.processedThroughSequence,
        JSON.stringify(snapshot.value),
        snapshot.createdAt,
      );
      runSql(this.database,
        `UPDATE identity_state
         SET processed_through_sequence = ?, active_snapshot_id = ?
         WHERE singleton = 1`,
        snapshot.processedThroughSequence,
        snapshot.snapshotId,
      );
    });
  }

  async projectionState(): Promise<IdentityProjectionState> {
    return identityProjectionState(this.database, this.agentSessionId);
  }
}

class SqliteIdentityDeliveryPersistence implements IdentityDeliveryPersistence {
  constructor(private readonly database: Database, private readonly runWrite: WriteRunner) {}

  async get(
    targetConversationId: AgentConversationId,
    targetProviderContextId: string,
    sourceConversationId: AgentConversationId,
  ): Promise<IdentityDeliveryCursor | null> {
    const row = this.database.query<{
      delivered_through_sequence: number;
      updated_at: string;
    }, [string, string, string]>(
      `SELECT delivered_through_sequence, updated_at FROM identity_delivery_cursors
       WHERE target_conversation_id = ? AND target_provider_context_id = ?
         AND source_conversation_id = ?`,
    ).get(targetConversationId, targetProviderContextId, sourceConversationId);
    return row ? Object.freeze({
      targetConversationId,
      targetProviderContextId,
      sourceConversationId,
      deliveredThroughSequence: Number(row.delivered_through_sequence),
      updatedAt: row.updated_at,
    }) : null;
  }

  async advance(updates: readonly IdentityDeliveryAdvance[]): Promise<void> {
    if (updates.length === 0) return;
    await this.runWrite(() => {
      const now = new Date().toISOString();
      const statement = this.database.query<unknown, [string, string, string, number, string]>(
        `INSERT INTO identity_delivery_cursors(
           target_conversation_id, target_provider_context_id,
           source_conversation_id, delivered_through_sequence, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(target_conversation_id, target_provider_context_id, source_conversation_id)
         DO UPDATE SET
           delivered_through_sequence = MAX(
             identity_delivery_cursors.delivered_through_sequence,
             excluded.delivered_through_sequence
           ),
           updated_at = excluded.updated_at`,
      );
      for (const update of updates) {
        if (update.targetConversationId === update.sourceConversationId) {
          throw new Error("identity cannot deliver a conversation to itself");
        }
        if (!update.targetProviderContextId.trim()) {
          throw new Error("identity target provider context id cannot be blank");
        }
        const through = nonNegativeInteger(update.deliveredThroughSequence, "identity delivered sequence");
        if (through === 0) continue;
        requireConversation(this.database, update.targetConversationId);
        const source = requireConversation(this.database, update.sourceConversationId);
        if (through > source.latest_sequence) {
          throw new Error("identity cursor cannot exceed source conversation sequence");
        }
        statement.run(
          update.targetConversationId,
          update.targetProviderContextId,
          update.sourceConversationId,
          through,
          now,
        );
      }
    });
  }

  async reset(targetConversationId: AgentConversationId, targetProviderContextId: string): Promise<void> {
    if (!targetProviderContextId.trim()) throw new Error("identity target provider context id cannot be blank");
    await this.runWrite(() => {
      requireConversation(this.database, targetConversationId);
      this.database.query<unknown, [string, string]>(
        `DELETE FROM identity_delivery_cursors
         WHERE target_conversation_id = ? AND target_provider_context_id = ?`,
      ).run(targetConversationId, targetProviderContextId);
    });
  }
}

class SqliteSearchPersistence implements SearchPersistence {
  constructor(private readonly database: Database) {}

  async search(query: SearchQuery): Promise<readonly SearchMatch[]> {
    if (!query.text.trim()) throw new Error("search text cannot be blank");
    const limit = boundedInteger(query.limit ?? 50, 1, 500, "search limit");
    const requested = query.kinds?.length
      ? query.kinds
      : (["message", "tool_call", "activity"] as const);
    const searchable = requested.filter((kind): kind is "message" | "tool_call" | "activity" =>
      kind === "message" || kind === "tool_call" || kind === "activity");
    const rows = searchable.flatMap((kind) => searchRecordKind(this.database, kind, query, limit));
    rows.sort((left, right) => left.score - right.score || left.sequence - right.sequence);
    return Object.freeze(rows.slice(0, limit).map((row): SearchMatch => Object.freeze({
      recordId: row.record_id,
      agentConversationId: row.agent_conversation_id as AgentConversationId,
      sequence: Number(row.sequence),
      kind: row.kind as ConversationRecord["kind"],
      score: Number(row.score),
      ...(row.snippet ? { snippet: row.snippet } : {}),
    })));
  }

  async rebuild(): Promise<void> {
    for (const table of SEARCH_FTS_TABLES) {
      this.database.exec(`INSERT INTO ${table}(${table}) VALUES ('rebuild')`);
    }
  }

  async integrityCheck(): Promise<void> {
    for (const table of SEARCH_FTS_TABLES) {
      this.database.exec(`INSERT INTO ${table}(${table}, rank) VALUES ('integrity-check', 1)`);
    }
  }
}

const SEARCH_FTS_TABLES = [
  "conversation_messages_fts",
  "conversation_tool_calls_fts",
  "conversation_activities_fts",
] as const;

interface SearchRow {
  readonly record_id: string;
  readonly agent_conversation_id: string;
  readonly sequence: number;
  readonly kind: string;
  readonly score: number;
  readonly snippet: string | null;
}

function searchRecordKind(
  database: Database,
  kind: "message" | "tool_call" | "activity",
  query: SearchQuery,
  limit: number,
): SearchRow[] {
  if (query.participantIds?.length && kind !== "message") return [];
  const table = kind === "message"
    ? "conversation_messages_fts"
    : kind === "tool_call"
      ? "conversation_tool_calls_fts"
      : "conversation_activities_fts";
  const detailTable = kind === "message" ? "conversation_messages" : null;
  const where = [`${table} MATCH ?`, "r.kind = ?"];
  const parameters: SqlValue[] = [query.text, kind];
  if (query.conversationIds?.length) {
    where.push(`r.agent_conversation_id IN (${query.conversationIds.map(() => "?").join(", ")})`);
    parameters.push(...query.conversationIds);
  }
  if (query.participantIds?.length) {
    where.push(`d.participant_id IN (${query.participantIds.map(() => "?").join(", ")})`);
    parameters.push(...query.participantIds);
  }
  if (query.after) {
    where.push("r.timestamp >= ?");
    parameters.push(query.after);
  }
  if (query.before) {
    where.push("r.timestamp <= ?");
    parameters.push(query.before);
  }
  parameters.push(limit);
  return database.query<SearchRow, SqlValue[]>(
    `SELECT
       r.record_id,
       r.agent_conversation_id,
       r.sequence,
       r.kind,
       bm25(${table}) AS score,
       snippet(${table}, 0, '[', ']', '…', 32) AS snippet
     FROM ${table}
     JOIN conversation_records r ON r.row_id = ${table}.rowid
     ${detailTable ? `JOIN ${detailTable} d ON d.record_row_id = r.row_id` : ""}
     WHERE ${where.join(" AND ")}
     ORDER BY score, r.sequence
     LIMIT ?`,
  ).all(...parameters);
}

class SqliteAuditOutboxPersistence implements AuditOutboxPersistence {
  constructor(private readonly database: Database, private readonly runWrite: WriteRunner) {}

  async initialize(
    auditLogId: string,
    captureFingerprint: string,
    now = new Date().toISOString(),
  ): Promise<AgentAuditState> {
    return await this.runWrite(() => {
      const existing = readAuditState(this.database);
      if (existing) {
        if (existing.auditLogId !== auditLogId) {
          throw new PersistenceConflictError(
            `agent audit state belongs to ${existing.auditLogId}, not ${auditLogId}`,
          );
        }
        if (existing.captureFingerprint !== captureFingerprint) {
          runSql(this.database,
            "UPDATE agent_audit_state SET capture_fingerprint = ?, updated_at = ? WHERE singleton = 1",
            captureFingerprint,
            now,
          );
        }
        return readAuditState(this.database)!;
      }
      runSql(this.database,
        `INSERT INTO agent_audit_state(
          singleton, audit_log_id, last_allocated_sequence, last_delivered_sequence,
          capture_fingerprint, created_at, updated_at
        ) VALUES (1, ?, 0, 0, ?, ?, ?)`,
        auditLogId,
        captureFingerprint,
        now,
        now,
      );
      return readAuditState(this.database)!;
    });
  }

  async state(): Promise<AgentAuditState | null> {
    return readAuditState(this.database);
  }

  async backlog(): Promise<AuditOutboxBacklog> {
    const row = this.database.query<{
      pending_count: number;
      pending_payload_bytes: number;
      oldest_pending_at: string | null;
    }, []>(
      `SELECT COUNT(*) AS pending_count,
              COALESCE(SUM(payload_bytes), 0) AS pending_payload_bytes,
              MIN(created_at) AS oldest_pending_at
       FROM audit_outbox`,
    ).get()!;
    return Object.freeze({
      pendingCount: Number(row.pending_count),
      pendingPayloadBytes: Number(row.pending_payload_bytes),
      ...(row.oldest_pending_at !== null ? { oldestPendingAt: row.oldest_pending_at } : {}),
    });
  }

  async enqueue(item: NewAuditOutboxItem): Promise<AuditOutboxItem> {
    return await this.runWrite(() => {
      const payload = canonicalizeJson(item.payload);
      const payloadSha256 = createHash("sha256").update(payload, "utf8").digest("hex");
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      const existing = this.database.query<Record<string, unknown>, [string]>(
        "SELECT * FROM audit_outbox WHERE source_observation_id = ?",
      ).get(item.sourceObservationId);
      if (existing) {
        const hydrated = auditOutboxFromRow(existing);
        if (!samePendingAuditItem(hydrated, item, payloadSha256)) {
          throw new PersistenceConflictError(
            `audit source observation already has different pending content: ${item.sourceObservationId}`,
          );
        }
        return hydrated;
      }
      const state = readAuditState(this.database);
      if (!state) throw new Error("agent audit state is not initialized");
      const auditSequence = state.lastAllocatedSequence + 1;
      runSql(this.database,
        `INSERT INTO audit_outbox(
          outbox_id, audit_sequence, source_observation_id, source_record_id,
          operation_id, agent_conversation_id, occurred_at, kind, capture_level,
          capture_fingerprint, payload_json, payload_sha256, payload_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        item.outboxId,
        auditSequence,
        item.sourceObservationId,
        item.sourceRecordId ?? null,
        item.operationId ?? null,
        item.agentConversationId ?? null,
        item.occurredAt,
        item.kind,
        item.captureLevel,
        item.captureFingerprint,
        payload,
        payloadSha256,
        payloadBytes,
        item.createdAt,
      );
      runSql(this.database,
        // The state's fingerprint is the Agent's base policy and only `initialize` writes it: an entry
        // carries the fingerprint of the policy that projected it, which a conversation's override changes.
        `UPDATE agent_audit_state
         SET last_allocated_sequence = ?, updated_at = ?
         WHERE singleton = 1`,
        auditSequence,
        item.createdAt,
      );
      return auditOutboxFromRow(this.database.query<Record<string, unknown>, [string]>(
        "SELECT * FROM audit_outbox WHERE outbox_id = ?",
      ).get(item.outboxId)!);
    });
  }

  async head(): Promise<AuditOutboxItem | null> {
    const row = this.database.query<Record<string, unknown>, []>(
      "SELECT * FROM audit_outbox ORDER BY audit_sequence LIMIT 1",
    ).get();
    return row ? auditOutboxFromRow(row) : null;
  }

  async pending(limit = 100, now = new Date().toISOString()): Promise<readonly AuditOutboxItem[]> {
    const rows = this.database.query<Record<string, unknown>, [number]>(
      `SELECT * FROM audit_outbox
       ORDER BY audit_sequence LIMIT ?`,
    ).all(boundedInteger(limit, 1, 1_000, "audit outbox limit"));
    const head = rows[0];
    if (head && head.next_attempt_at !== null && String(head.next_attempt_at) > now) {
      return Object.freeze([]);
    }
    return Object.freeze(rows.map(auditOutboxFromRow));
  }

  async acknowledge(
    outboxIds: readonly string[],
    deliveredAt = new Date().toISOString(),
  ): Promise<AgentAuditState> {
    if (outboxIds.length === 0) throw new Error("audit acknowledgement cannot be empty");
    return await this.runWrite(() => {
      const rows = this.database.query<{ outbox_id: string; audit_sequence: number }, [number]>(
        "SELECT outbox_id, audit_sequence FROM audit_outbox ORDER BY audit_sequence LIMIT ?",
      ).all(outboxIds.length);
      if (rows.length !== outboxIds.length || rows.some((row, index) => row.outbox_id !== outboxIds[index])) {
        throw new PersistenceConflictError("audit acknowledgement is not the contiguous pending head");
      }
      const throughSequence = Number(rows.at(-1)!.audit_sequence);
      const placeholders = outboxIds.map(() => "?").join(", ");
      runSql(this.database, `DELETE FROM audit_outbox WHERE outbox_id IN (${placeholders})`, ...outboxIds);
      runSql(this.database,
        `UPDATE agent_audit_state
         SET last_delivered_sequence = ?, updated_at = ?
         WHERE singleton = 1`,
        throughSequence,
        deliveredAt,
      );
      return readAuditState(this.database)!;
    });
  }

  async markFailed(outboxId: string, error: string, nextAttemptAt?: string): Promise<void> {
    await this.runWrite(() => {
      const changed = runSql(this.database,
        `UPDATE audit_outbox
         SET attempt_count = attempt_count + 1, last_error = ?, next_attempt_at = ?
         WHERE outbox_id = ?
           AND audit_sequence = (SELECT MIN(audit_sequence) FROM audit_outbox)`,
        truncateUtf8(error, 4_096),
        nextAttemptAt ?? null,
        outboxId,
      );
      if (changed.changes === 0) throw new PersistenceConflictError(`audit outbox item is not pending head: ${outboxId}`);
    });
  }

  async retryHead(): Promise<void> {
    await this.runWrite(() => {
      runSql(this.database,
        `UPDATE audit_outbox SET next_attempt_at = NULL
         WHERE audit_sequence = (SELECT MIN(audit_sequence) FROM audit_outbox)`,
      );
    });
  }
}

class SqliteExtensionCatalog implements PersistenceExtensionCatalog {
  constructor(private readonly database: Database) {}

  async get(extensionId: string): Promise<PersistenceExtensionRegistration | null> {
    const row = this.database.query<{
      extension_id: string;
      schema_version: number;
      installed_at: string;
      updated_at: string;
    }, [string]>("SELECT * FROM persistence_extensions WHERE extension_id = ?").get(extensionId);
    return row ? extensionRegistrationFromRow(row) : null;
  }

  async list(): Promise<readonly PersistenceExtensionRegistration[]> {
    const rows = this.database.query<{
      extension_id: string;
      schema_version: number;
      installed_at: string;
      updated_at: string;
    }, []>("SELECT * FROM persistence_extensions ORDER BY extension_id").all();
    return Object.freeze(rows.map(extensionRegistrationFromRow));
  }
}

function initializeAgentIdentity(
  database: Database,
  agentSessionId: AgentSessionId,
  metadata: string | undefined,
): AgentPersistenceIdentity {
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.query<IdentityRow, []>("SELECT * FROM agent_identity WHERE singleton = 1").get();
    if (existing && existing.agent_session_id !== agentSessionId) {
      throw new PersistenceConflictError(
        `SQLite database belongs to ${existing.agent_session_id}, not ${agentSessionId}`,
      );
    }
    if (!existing) {
      const now = new Date().toISOString();
      runSql(database,
        `INSERT INTO agent_identity(
          singleton, agent_session_id, created_at, updated_at, metadata
        ) VALUES (1, ?, ?, ?, ?)`,
        agentSessionId,
        now,
        now,
        metadata ?? null,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
  const row = database.query<IdentityRow, []>("SELECT * FROM agent_identity WHERE singleton = 1").get();
  if (!row) throw new Error("failed to initialize SQLite agent identity");
  return Object.freeze({
    agentSessionId: row.agent_session_id as AgentSessionId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.metadata !== null ? { metadata: row.metadata } : {}),
  });
}

function conversationRow(database: Database, id: AgentConversationId): ConversationRow | null {
  return database.query<ConversationRow, [string]>(
    "SELECT * FROM conversations WHERE agent_conversation_id = ?",
  ).get(id) ?? null;
}

function requireConversation(database: Database, id: AgentConversationId): ConversationRow {
  const row = conversationRow(database, id);
  if (!row) throw new Error(`unknown conversation: ${id}`);
  return row;
}

function requireConversationSummary(database: Database, id: AgentConversationId): AgentConversationSummary {
  return summaryFromRow(database, requireConversation(database, id));
}

function summaryFromRow(database: Database, row: ConversationRow): AgentConversationSummary {
  const participants = database.query<{
    participant_id: string;
    kind: string;
    name: string | null;
  }, [string]>(
    `SELECT p.participant_id, p.kind, p.name
     FROM participants p
     JOIN conversation_participants cp ON cp.participant_id = p.participant_id
     WHERE cp.agent_conversation_id = ?
     ORDER BY cp.joined_at, p.participant_id`,
  ).all(row.agent_conversation_id).map((participant): ParticipantRef => Object.freeze({
    id: participant.participant_id,
    kind: participant.kind as ParticipantRef["kind"],
    ...(participant.name !== null ? { name: participant.name } : {}),
  }));
  return summaryFromRowWithParticipants(row, participants);
}

function summaryFromRowWithParticipants(
  row: ConversationRow,
  participants: readonly ParticipantRef[],
): AgentConversationSummary {
  return Object.freeze({
    agentConversationId: row.agent_conversation_id as AgentConversationId,
    agentSessionId: row.agent_session_id as AgentSessionId,
    ...(row.title !== null ? { title: row.title } : {}),
    participants: Object.freeze(participants),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestSequence: Number(row.latest_sequence),
    ...(row.deleted_at !== null ? { deletedAt: row.deleted_at } : {}),
    ...(row.adopted ? { adopted: true } : {}),
    ...(row.adopt_provider_session_id !== null ? { adoptProviderSessionId: row.adopt_provider_session_id } : {}),
    ...(row.metadata !== null ? { metadata: row.metadata } : {}),
  });
}

function ensureParticipantDirect(
  database: Database,
  agentConversationId: AgentConversationId,
  input: ParticipantRef,
  now: string,
): ParticipantRef {
  requireConversation(database, agentConversationId);
  const participant = normalizeParticipantRef(input);
  const existing = database.query<{ kind: string; name: string | null }, [string]>(
    "SELECT kind, name FROM participants WHERE participant_id = ?",
  ).get(participant.id);
  if (existing && existing.kind !== participant.kind) {
    throw new PersistenceConflictError(
      `participant ${participant.id} is already ${existing.kind}, not ${participant.kind}`,
    );
  }
  if (!existing) {
    runSql(database,
      `INSERT INTO participants(participant_id, kind, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      participant.id,
      participant.kind,
      participant.name ?? null,
      now,
      now,
    );
  } else if (participant.name !== undefined && participant.name !== existing.name) {
    runSql(database,
      "UPDATE participants SET name = ?, updated_at = ? WHERE participant_id = ?",
      participant.name,
      now,
      participant.id,
    );
  }
  runSql(database,
    `INSERT OR IGNORE INTO conversation_participants(
      agent_conversation_id, participant_id, joined_at
    ) VALUES (?, ?, ?)`,
    agentConversationId,
    participant.id,
    now,
  );
  return participant;
}

function providerSessionFromRow(row: Record<string, unknown>): ProviderSessionRecord {
  return Object.freeze({
    providerSessionRecordId: String(row.provider_session_record_id),
    agentConversationId: String(row.agent_conversation_id) as AgentConversationId,
    internalSessionId: String(row.internal_session_id),
    adapterId: String(row.adapter_id),
    mode: String(row.mode) as ProviderSessionRecord["mode"],
    ...(row.model !== null ? { model: String(row.model) } : {}),
    activatedAt: String(row.activated_at),
    ...(row.deactivated_at !== null ? { deactivatedAt: String(row.deactivated_at) } : {}),
    ...(row.transition_id !== null ? { transitionId: String(row.transition_id) } : {}),
    ...(row.metadata !== null ? { metadata: String(row.metadata) } : {}),
  });
}

function identityMemoryFromRow(row: Record<string, unknown>): IdentityMemoryObservation {
  return Object.freeze({
    memoryId: String(row.memory_id),
    agentSessionId: String(row.agent_session_id) as AgentSessionId,
    sequence: Number(row.sequence),
    sourceConversationId: String(row.source_conversation_id) as AgentConversationId,
    sourceRecordIds: Object.freeze(parseStringArray(String(row.source_record_ids_json))),
    ...(row.participant_id !== null ? { participantId: String(row.participant_id) } : {}),
    kind: String(row.kind),
    content: parseJson(String(row.content_json)),
    createdAt: String(row.created_at),
    ...(row.metadata !== null ? { metadata: String(row.metadata) } : {}),
  });
}

function identitySnapshotFromRow(row: Record<string, unknown>): PersistedIdentitySnapshot {
  return Object.freeze({
    snapshotId: String(row.snapshot_id),
    agentSessionId: String(row.agent_session_id) as AgentSessionId,
    version: Number(row.version),
    processedThroughSequence: Number(row.processed_through_sequence),
    value: parseJson(String(row.value_json)),
    createdAt: String(row.created_at),
  });
}

function identityProjectionState(database: Database, agentSessionId: AgentSessionId): IdentityProjectionState {
  const row = database.query<{
    observed_through_sequence: number;
    processed_through_sequence: number;
    active_snapshot_id: string | null;
  }, []>("SELECT * FROM identity_state WHERE singleton = 1").get();
  if (!row) throw new Error("identity state is unavailable");
  return Object.freeze({
    agentSessionId,
    observedThroughSequence: Number(row.observed_through_sequence),
    processedThroughSequence: Number(row.processed_through_sequence),
    ...(row.active_snapshot_id !== null ? { activeSnapshotId: row.active_snapshot_id } : {}),
  });
}

function auditOutboxFromRow(row: Record<string, unknown>): AuditOutboxItem {
  return Object.freeze({
    outboxId: String(row.outbox_id),
    auditSequence: Number(row.audit_sequence),
    sourceObservationId: String(row.source_observation_id),
    ...(row.source_record_id !== null ? { sourceRecordId: String(row.source_record_id) } : {}),
    ...(row.operation_id !== null ? { operationId: String(row.operation_id) } : {}),
    ...(row.agent_conversation_id !== null
      ? { agentConversationId: String(row.agent_conversation_id) as AgentConversationId }
      : {}),
    occurredAt: String(row.occurred_at),
    kind: String(row.kind),
    captureLevel: String(row.capture_level),
    captureFingerprint: String(row.capture_fingerprint),
    payload: parseJson(String(row.payload_json)),
    payloadSha256: String(row.payload_sha256),
    payloadBytes: Number(row.payload_bytes),
    createdAt: String(row.created_at),
    attemptCount: Number(row.attempt_count),
    ...(row.next_attempt_at !== null ? { nextAttemptAt: String(row.next_attempt_at) } : {}),
    ...(row.last_error !== null ? { lastError: String(row.last_error) } : {}),
  });
}

function readAuditState(database: Database): AgentAuditState | null {
  const row = database.query<Record<string, unknown>, []>(
    "SELECT * FROM agent_audit_state WHERE singleton = 1",
  ).get();
  if (!row) return null;
  return Object.freeze({
    auditLogId: String(row.audit_log_id),
    lastAllocatedSequence: Number(row.last_allocated_sequence),
    lastDeliveredSequence: Number(row.last_delivered_sequence),
    captureFingerprint: String(row.capture_fingerprint),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
}

function samePendingAuditItem(
  existing: AuditOutboxItem,
  candidate: NewAuditOutboxItem,
  payloadSha256: string,
): boolean {
  return existing.sourceObservationId === candidate.sourceObservationId
    && existing.sourceRecordId === candidate.sourceRecordId
    && existing.operationId === candidate.operationId
    && existing.agentConversationId === candidate.agentConversationId
    && existing.occurredAt === candidate.occurredAt
    && existing.kind === candidate.kind
    && existing.captureLevel === candidate.captureLevel
    && existing.captureFingerprint === candidate.captureFingerprint
    && existing.payloadSha256 === payloadSha256;
}

function extensionRegistrationFromRow(row: {
  extension_id: string;
  schema_version: number;
  installed_at: string;
  updated_at: string;
}): PersistenceExtensionRegistration {
  return Object.freeze({
    extensionId: row.extension_id,
    schemaVersion: Number(row.schema_version),
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  });
}

function parseJson(value: string): PersistenceJsonValue {
  return JSON.parse(value) as PersistenceJsonValue;
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("persisted source record ids are malformed");
  }
  return parsed;
}

function encodeOffset(offset: number): string {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64url");
}

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new Error("invalid persistence cursor");
  }
  const match = /^offset:(\d+)$/.exec(decoded);
  if (!match) throw new Error("invalid persistence cursor");
  return nonNegativeInteger(Number(match[1]), "persistence cursor");
}

interface RecentCursor {
  readonly conversationId: AgentConversationId;
  readonly snapshotSequence: number;
  readonly beforeSequence: number;
  readonly kinds: readonly string[];
  /** What the page counts. A cursor of one unit is refused by the other: their pages split differently. */
  readonly unit: "records" | "agentMessages";
}

/** One page of `listRecent` before detail and folding: `olderBefore` is the next page's `beforeSequence`. */
interface RecentPageSlice {
  readonly records: readonly ConversationRecord[];
  readonly olderBefore?: number;
  readonly truncated?: true;
}

function encodeRecentCursor(cursor: RecentCursor): string {
  const { unit, ...rest } = cursor;
  // Record cursors keep their earlier encoding.
  return Buffer.from(JSON.stringify({ v: 1, ...rest, ...(unit === "records" ? {} : { unit }) }), "utf8")
    .toString("base64url");
}

function decodeRecentCursor(
  encoded: string,
  conversationId: AgentConversationId,
  kinds: readonly string[],
  unit: RecentCursor["unit"],
): RecentCursor {
  try {
    if (encoded.length > 4_096) throw new Error();
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    if (value.v !== 1 || value.conversationId !== conversationId
      || !Number.isSafeInteger(value.snapshotSequence) || Number(value.snapshotSequence) < 0
      || !Number.isSafeInteger(value.beforeSequence) || Number(value.beforeSequence) < 1
      || Number(value.beforeSequence) > Number(value.snapshotSequence) + 1
      || JSON.stringify(value.kinds) !== JSON.stringify(kinds)
      || (value.unit ?? "records") !== unit) throw new Error();
    return {
      conversationId,
      snapshotSequence: Number(value.snapshotSequence),
      beforeSequence: Number(value.beforeSequence),
      kinds,
      unit,
    };
  } catch {
    throw new Error("invalid or mismatched recent-record cursor");
  }
}

/** A tool call without its input and output, the bulk of a history page. */
function summarizeRecord(record: ConversationRecord): ConversationRecord {
  if (record.kind !== "tool_call" || (record.input === undefined && record.output === undefined)) return record;
  const { input: _input, output: _output, ...rest } = record;
  return Object.freeze(rest);
}

/** An item reduced to its first revision and its merged current, filed under the latest revision's id. */
function summarizeItem(item: ConversationTimelineItem): ConversationTimelineItem {
  if (item.revisions.length <= 2) return item;
  return Object.freeze({ ...item, revisions: Object.freeze([item.revisions[0]!, item.current]) });
}

async function canonicalSqlitePath(input: string): Promise<string> {
  const resolved = resolve(input);
  const parent = dirname(resolved);
  await mkdir(parent, { recursive: true });
  try {
    return await realpath(resolved);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
    return join(await realpath(parent), basename(resolved));
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function nonblank(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} cannot be blank`);
  return value;
}

function assertInstant(value: string, label: string): void {
  if (!value.trim() || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO-8601 instant`);
}

function runSql(database: Database, sql: string, ...parameters: SqlValue[]): Changes {
  return database.query<unknown, SqlValue[]>(sql).run(...parameters);
}

/** Recognizes upstream versions containing SQLite's multi-connection WAL-reset fix. */
export function hasSafeConcurrentWal(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major > 3) return true;
  if (major < 3) return false;
  if (minor > 51) return true;
  if (minor === 51) return patch >= 3;
  if (minor === 50) return patch >= 7;
  if (minor === 44) return patch >= 6;
  return false;
}

export function requireSqliteSearch(backend: PersistenceBackend): SearchPersistence {
  if (!backend.search) throw new PersistenceCapabilityError("fullTextSearch");
  return backend.search;
}
