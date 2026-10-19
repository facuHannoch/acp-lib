import type { Database } from "bun:sqlite";
import type { AgentConversationId, AgentSessionId } from "../../agent-ids.ts";
import { PersistenceConflictError, type ConversationErrorDetails } from "../../persistence/backend.ts";
import type {
  InternalInferenceChainStatus,
  InternalInferenceCompletion,
  InternalInferenceId,
  InternalInferenceInputDescriptor,
  InternalInferencePurpose,
  InternalInferenceStatus,
} from "../contracts.ts";
import type { InternalInferenceRepository } from "./repository.ts";
import type {
  ClaimInternalInferenceInput,
  ClaimedInternalInference,
  CompleteInternalInferenceInput,
  EnqueueInternalInferenceInput,
  FailInternalInferenceInput,
  InternalInferenceAttemptRecord,
  InternalInferenceChainRecord,
  InternalInferenceRecordListOptions,
  InternalInferencePage,
  RecoverExpiredInternalInferenceInput,
} from "./records.ts";

type WriteRunner = <T>(work: () => T) => Promise<T>;

interface AttemptRow {
  internal_inference_id: string;
  root_internal_inference_id: string;
  retry_of_internal_inference_id: string | null;
  attempt_number: number;
  agent_session_id: string;
  agent_conversation_id: string | null;
  purpose: string;
  status: string;
  adapter_id: string;
  execution_profile_id: string | null;
  input_json: string;
  model: string | null;
  internal_session_id: string | null;
  source_checkpoint_id: string | null;
  source_from_sequence: number | null;
  source_through_sequence: number | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  next_attempt_at: string | null;
  worker_id: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  revision: number;
  result_json: string | null;
  error: string | null;
  failure_code: string | null;
  metering_operation_id: string | null;
  metadata: string | null;
}

interface ChainRow {
  root_internal_inference_id: string;
  agent_session_id: string;
  agent_conversation_id: string | null;
  purpose: string;
  status: string;
  active_internal_inference_id: string | null;
  requested_through_sequence: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
  error: string | null;
}

/** SQLite implementation kept outside the general backend to preserve feature ownership. */
export class SqliteInternalInferenceRepository implements InternalInferenceRepository {
  constructor(
    private readonly database: Database,
    private readonly runWrite: WriteRunner,
  ) {}

  async enqueue(input: EnqueueInternalInferenceInput): Promise<ClaimedInternalInference> {
    return await this.runWrite(() => {
      const now = input.requestedAt ?? databaseNow(this.database);
      const active = input.purpose === "conversation_checkpoint"
        ? this.database.query<ChainRow, [string, string, string]>(
        `SELECT * FROM internal_inference_chains
         WHERE agent_session_id = ? AND COALESCE(agent_conversation_id, '') = ?
           AND purpose = ? AND status = 'active'`,
        ).get(input.agentSessionId, input.agentConversationId ?? "", input.purpose)
        : null;
      if (active) {
        if (input.requestedThroughSequence !== undefined) {
          this.database.query(
            `UPDATE internal_inference_chains SET
               requested_through_sequence = MAX(COALESCE(requested_through_sequence, 0), ?),
               revision = revision + 1, updated_at = ?
             WHERE root_internal_inference_id = ? AND status = 'active'`,
          ).run(input.requestedThroughSequence, now, active.root_internal_inference_id);
        }
        return this.requireClaimed(active.active_internal_inference_id!);
      }

      this.database.query(
        `INSERT INTO internal_inference_chains(
           root_internal_inference_id, agent_session_id, agent_conversation_id, purpose,
           status, active_internal_inference_id, requested_through_sequence,
           revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1, ?, ?)`,
      ).run(
        input.internalInferenceId,
        input.agentSessionId,
        input.agentConversationId ?? null,
        input.purpose,
        input.internalInferenceId,
        input.requestedThroughSequence ?? null,
        now,
        now,
      );
      this.database.query(
        `INSERT INTO internal_inferences(
           internal_inference_id, root_internal_inference_id, attempt_number,
           agent_session_id, agent_conversation_id, purpose, status, adapter_id,
           execution_profile_id, input_json, source_checkpoint_id, source_from_sequence,
           source_through_sequence, requested_at, next_attempt_at, revision, metadata
         ) VALUES (?, ?, 1, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(
        input.internalInferenceId,
        input.internalInferenceId,
        input.agentSessionId,
        input.agentConversationId ?? null,
        input.purpose,
        input.adapterId,
        input.executionProfileId ?? null,
        JSON.stringify(input.input),
        input.sourceCheckpointId ?? null,
        input.sourceFromSequence ?? null,
        input.sourceThroughSequence ?? null,
        now,
        input.nextAttemptAt ?? null,
        input.metadata ?? null,
      );
      return this.requireClaimed(input.internalInferenceId);
    });
  }

  async claimNext(input: ClaimInternalInferenceInput): Promise<ClaimedInternalInference | null> {
    return await this.runWrite(() => {
      const now = input.now ?? databaseNow(this.database);
      const row = this.database.query<AttemptRow, [string]>(
        `SELECT i.* FROM internal_inferences i
         JOIN internal_inference_chains c
           ON c.root_internal_inference_id = i.root_internal_inference_id
         WHERE i.status = 'queued' AND c.status = 'active'
           AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= ?)
         ORDER BY COALESCE(i.next_attempt_at, i.requested_at), i.requested_at,
                  i.internal_inference_id LIMIT 1`,
      ).get(now);
      if (!row) return null;
      const expiresAt = new Date(Date.parse(now) + input.leaseDurationMs).toISOString();
      const changed = this.database.query(
        `UPDATE internal_inferences SET status = 'running', worker_id = ?, lease_token = ?,
           lease_expires_at = ?, heartbeat_at = ?, started_at = COALESCE(started_at, ?),
           revision = revision + 1
         WHERE internal_inference_id = ? AND status = 'queued' AND revision = ?`,
      ).run(
        input.workerId,
        input.leaseToken,
        expiresAt,
        now,
        now,
        row.internal_inference_id,
        row.revision,
      );
      if (changed.changes !== 1) return null;
      return this.requireClaimed(row.internal_inference_id);
    });
  }

  async heartbeat(
    id: InternalInferenceId,
    workerId: string,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<InternalInferenceAttemptRecord | null> {
    return await this.runWrite(() => {
      const now = databaseNow(this.database);
      const expiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString();
      const changed = this.database.query(
        `UPDATE internal_inferences SET heartbeat_at = ?, lease_expires_at = ?, revision = revision + 1
         WHERE internal_inference_id = ? AND status = 'running'
           AND worker_id = ? AND lease_token = ? AND lease_expires_at > ?`,
      ).run(now, expiresAt, id, workerId, leaseToken, now);
      return changed.changes === 1 ? this.getAttemptSync(id) : null;
    });
  }

  async complete(input: CompleteInternalInferenceInput): Promise<InternalInferenceAttemptRecord> {
    return await this.runWrite(() => {
      const now = input.completedAt ?? databaseNow(this.database);
      const row = this.requireOwnedRunning(input.internalInferenceId, input.workerId, input.leaseToken, now);
      const changed = this.database.query(
        `UPDATE internal_inferences SET status = 'completed', completed_at = ?, model = ?,
           internal_session_id = ?, result_json = ?, metering_operation_id = ?,
           worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
           revision = revision + 1
         WHERE internal_inference_id = ? AND status = 'running'
           AND worker_id = ? AND lease_token = ?`,
      ).run(
        now,
        input.model ?? null,
        input.internalSessionId,
        JSON.stringify(input.completion),
        input.meteringOperationId ?? null,
        input.internalInferenceId,
        input.workerId,
        input.leaseToken,
      );
      if (changed.changes !== 1) throw lostLease(input.internalInferenceId);
      this.database.query(
        `UPDATE internal_inference_chains SET status = 'completed',
           revision = revision + 1, updated_at = ?
         WHERE root_internal_inference_id = ? AND status = 'active'
           AND active_internal_inference_id = ?`,
      ).run(now, row.root_internal_inference_id, input.internalInferenceId);
      return this.getAttemptSync(input.internalInferenceId)!;
    });
  }

  async fail(input: FailInternalInferenceInput): Promise<InternalInferenceAttemptRecord> {
    return await this.runWrite(() => {
      const now = input.completedAt ?? databaseNow(this.database);
      const row = this.requireOwnedRunning(input.internalInferenceId, input.workerId, input.leaseToken, now);
      this.database.query(
        `UPDATE internal_inferences SET status = 'failed', completed_at = ?, error = ?,
           failure_code = ?, result_json = ?, worker_id = NULL, lease_token = NULL,
           lease_expires_at = NULL, revision = revision + 1
         WHERE internal_inference_id = ? AND status = 'running'
           AND worker_id = ? AND lease_token = ?`,
      ).run(
        now,
        input.error,
        input.failureCode,
        input.resultMetadata === undefined ? null : JSON.stringify(input.resultMetadata),
        input.internalInferenceId,
        input.workerId,
        input.leaseToken,
      );
      if (input.retry) {
        this.database.query(
          `INSERT INTO internal_inferences(
             internal_inference_id, root_internal_inference_id, retry_of_internal_inference_id,
             attempt_number, agent_session_id, agent_conversation_id, purpose, status,
             adapter_id, execution_profile_id, input_json, source_checkpoint_id,
             source_from_sequence, source_through_sequence, requested_at, next_attempt_at,
             revision, metadata
           ) SELECT ?, root_internal_inference_id, internal_inference_id, attempt_number + 1,
             agent_session_id, agent_conversation_id, purpose, 'queued', adapter_id,
             execution_profile_id, input_json, source_checkpoint_id, source_from_sequence,
             source_through_sequence, ?, ?, 1, metadata
           FROM internal_inferences WHERE internal_inference_id = ?`,
        ).run(input.retry.internalInferenceId, now, input.retry.nextAttemptAt ?? null, input.internalInferenceId);
        this.database.query(
          `UPDATE internal_inference_chains SET active_internal_inference_id = ?,
             revision = revision + 1, updated_at = ?, error = NULL
           WHERE root_internal_inference_id = ? AND status = 'active'
             AND active_internal_inference_id = ?`,
        ).run(input.retry.internalInferenceId, now, row.root_internal_inference_id, input.internalInferenceId);
      } else {
        this.database.query(
          `UPDATE internal_inference_chains SET status = 'failed',
             revision = revision + 1,
             updated_at = ?, error = ?
           WHERE root_internal_inference_id = ? AND status = 'active'
             AND active_internal_inference_id = ?`,
        ).run(now, input.error, row.root_internal_inference_id, input.internalInferenceId);
      }
      return this.getAttemptSync(input.internalInferenceId)!;
    });
  }

  async cancel(rootId: InternalInferenceId, reason = "cancelled by consumer"): Promise<InternalInferenceChainRecord> {
    return await this.runWrite(() => {
      const now = databaseNow(this.database);
      this.database.query(
        `UPDATE internal_inferences SET status = 'cancelled', completed_at = ?, error = ?,
           failure_code = 'consumer_cancelled', worker_id = NULL, lease_token = NULL,
           lease_expires_at = NULL, revision = revision + 1
         WHERE root_internal_inference_id = ? AND status IN ('queued', 'running')`,
      ).run(now, reason, rootId);
      const changed = this.database.query(
        `UPDATE internal_inference_chains SET status = 'cancelled',
           revision = revision + 1,
           updated_at = ?, error = ?
         WHERE root_internal_inference_id = ? AND status = 'active'`,
      ).run(now, reason, rootId);
      if (changed.changes !== 1) throw new PersistenceConflictError(`internal inference run is not active: ${rootId}`);
      return this.getChainSync(rootId)!;
    });
  }

  async recoverExpired(
    input: RecoverExpiredInternalInferenceInput,
  ): Promise<InternalInferenceAttemptRecord | null> {
    return await this.runWrite(() => {
      const now = input.now ?? databaseNow(this.database);
      const row = this.database.query<AttemptRow, [string]>(
        `SELECT * FROM internal_inferences
         WHERE status = 'running' AND lease_expires_at <= ?
         ORDER BY lease_expires_at, internal_inference_id LIMIT 1`,
      ).get(now);
      if (!row) return null;
      const retry = row.attempt_number < input.maxAttempts;
      const changed = this.database.query(
        `UPDATE internal_inferences SET status = 'failed', completed_at = ?,
           error = 'worker lease expired', failure_code = 'lease_expired',
           worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
           revision = revision + 1
         WHERE internal_inference_id = ? AND status = 'running'
           AND lease_token = ? AND lease_expires_at <= ?`,
      ).run(now, row.internal_inference_id, row.lease_token, now);
      if (changed.changes !== 1) return null;
      if (retry) {
        this.database.query(
          `INSERT INTO internal_inferences(
             internal_inference_id, root_internal_inference_id, retry_of_internal_inference_id,
             attempt_number, agent_session_id, agent_conversation_id, purpose, status,
             adapter_id, execution_profile_id, input_json, source_checkpoint_id,
             source_from_sequence, source_through_sequence, requested_at, next_attempt_at,
             revision, metadata
           ) SELECT ?, root_internal_inference_id, internal_inference_id, attempt_number + 1,
             agent_session_id, agent_conversation_id, purpose, 'queued', adapter_id,
             execution_profile_id, input_json, source_checkpoint_id, source_from_sequence,
             source_through_sequence, ?, ?, 1, metadata
           FROM internal_inferences WHERE internal_inference_id = ?`,
        ).run(input.retryInternalInferenceId, now, input.nextAttemptAt ?? null, row.internal_inference_id);
        this.database.query(
          `UPDATE internal_inference_chains SET active_internal_inference_id = ?,
             revision = revision + 1, updated_at = ?, error = NULL
           WHERE root_internal_inference_id = ? AND status = 'active'
             AND active_internal_inference_id = ?`,
        ).run(
          input.retryInternalInferenceId,
          now,
          row.root_internal_inference_id,
          row.internal_inference_id,
        );
      } else {
        this.database.query(
          `UPDATE internal_inference_chains SET status = 'failed', revision = revision + 1,
             updated_at = ?, error = 'worker lease expired'
           WHERE root_internal_inference_id = ? AND status = 'active'
             AND active_internal_inference_id = ?`,
        ).run(now, row.root_internal_inference_id, row.internal_inference_id);
      }
      return this.getAttemptSync(row.internal_inference_id as InternalInferenceId);
    });
  }

  async getAttempt(id: InternalInferenceId): Promise<InternalInferenceAttemptRecord | null> {
    return this.getAttemptSync(id);
  }

  async getChain(rootId: InternalInferenceId): Promise<InternalInferenceChainRecord | null> {
    return this.getChainSync(rootId);
  }

  async list(options: InternalInferenceRecordListOptions = {}): Promise<InternalInferencePage> {
    const limit = boundedLimit(options.limit ?? 100);
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (options.agentConversationId) {
      clauses.push("agent_conversation_id = ?");
      values.push(options.agentConversationId);
    }
    if (options.purpose) {
      clauses.push("purpose = ?");
      values.push(options.purpose);
    }
    if (options.status) {
      clauses.push("status = ?");
      values.push(options.status);
    }
    if (options.rootId) {
      clauses.push("root_internal_inference_id = ?");
      values.push(options.rootId);
    }
    if (cursor) {
      clauses.push("(requested_at < ? OR (requested_at = ? AND internal_inference_id < ?))");
      values.push(cursor.requestedAt, cursor.requestedAt, cursor.id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.query<AttemptRow, Array<string | number>>(
      `SELECT * FROM internal_inferences ${where}
       ORDER BY requested_at DESC, internal_inference_id DESC LIMIT ?`,
    ).all(...values, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      attempts: Object.freeze(page.map(attemptFromRow)),
      ...(rows.length > limit && last
        ? { nextCursor: encodeCursor(last.requested_at, last.internal_inference_id) }
        : {}),
    };
  }

  async pruneTerminal(retainRuns: number): Promise<number> {
    if (!Number.isSafeInteger(retainRuns) || retainRuns < 0) {
      throw new Error("internal inference retention must be a non-negative integer");
    }
    return await this.runWrite(() => {
      const roots = this.database.query<{ root_internal_inference_id: string }, [number]>(
        `SELECT root_internal_inference_id FROM internal_inference_chains
         WHERE status IN ('completed', 'failed', 'cancelled')
         ORDER BY updated_at DESC, root_internal_inference_id DESC
         LIMIT -1 OFFSET ?`,
      ).all(retainRuns).map((row) => row.root_internal_inference_id);
      if (!roots.length) return 0;
      const placeholders = roots.map(() => "?").join(", ");
      this.database.query(`DELETE FROM internal_inferences WHERE root_internal_inference_id IN (${placeholders})`)
        .run(...roots);
      this.database.query(`DELETE FROM internal_inference_chains WHERE root_internal_inference_id IN (${placeholders})`)
        .run(...roots);
      return roots.length;
    });
  }

  private requireClaimed(id: string): ClaimedInternalInference {
    const attempt = this.getAttemptSync(id as InternalInferenceId);
    if (!attempt) throw new Error(`internal inference attempt disappeared: ${id}`);
    const chain = this.getChainSync(attempt.rootInternalInferenceId);
    if (!chain) throw new Error(`internal inference chain disappeared: ${attempt.rootInternalInferenceId}`);
    return { attempt, chain };
  }

  private requireOwnedRunning(id: InternalInferenceId, workerId: string, leaseToken: string, now: string): AttemptRow {
    const row = this.database.query<AttemptRow, [string, string, string, string]>(
      `SELECT * FROM internal_inferences WHERE internal_inference_id = ?
       AND status = 'running' AND worker_id = ? AND lease_token = ? AND lease_expires_at > ?`,
    ).get(id, workerId, leaseToken, now);
    if (!row) throw lostLease(id);
    return row;
  }

  private getAttemptSync(id: InternalInferenceId): InternalInferenceAttemptRecord | null {
    const row = this.database.query<AttemptRow, [string]>(
      "SELECT * FROM internal_inferences WHERE internal_inference_id = ?",
    ).get(id);
    return row ? attemptFromRow(row) : null;
  }

  private getChainSync(rootId: InternalInferenceId): InternalInferenceChainRecord | null {
    const row = this.database.query<ChainRow, [string]>(
      "SELECT * FROM internal_inference_chains WHERE root_internal_inference_id = ?",
    ).get(rootId);
    return row ? chainFromRow(row) : null;
  }
}

function attemptFromRow(row: AttemptRow): InternalInferenceAttemptRecord {
  return Object.freeze({
    internalInferenceId: row.internal_inference_id as InternalInferenceId,
    rootInternalInferenceId: row.root_internal_inference_id as InternalInferenceId,
    ...(row.retry_of_internal_inference_id
      ? { retryOfInternalInferenceId: row.retry_of_internal_inference_id as InternalInferenceId }
      : {}),
    attemptNumber: row.attempt_number,
    agentSessionId: row.agent_session_id as AgentSessionId,
    ...(row.agent_conversation_id ? { agentConversationId: row.agent_conversation_id as AgentConversationId } : {}),
    purpose: row.purpose as InternalInferencePurpose,
    status: row.status as InternalInferenceStatus,
    adapterId: row.adapter_id,
    ...(row.execution_profile_id ? { executionProfileId: row.execution_profile_id } : {}),
    input: JSON.parse(row.input_json) as InternalInferenceInputDescriptor,
    ...(row.model ? { model: row.model } : {}),
    ...(row.internal_session_id ? { internalSessionId: row.internal_session_id } : {}),
    ...(row.source_checkpoint_id ? { sourceCheckpointId: row.source_checkpoint_id } : {}),
    ...(row.source_from_sequence === null ? {} : { sourceFromSequence: row.source_from_sequence }),
    ...(row.source_through_sequence === null ? {} : { sourceThroughSequence: row.source_through_sequence }),
    requestedAt: row.requested_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.worker_id ? { workerId: row.worker_id } : {}),
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.heartbeat_at ? { heartbeatAt: row.heartbeat_at } : {}),
    revision: row.revision,
    ...(row.result_json && row.status === "completed"
      ? { completion: JSON.parse(row.result_json) as InternalInferenceCompletion }
      : {}),
    ...(row.result_json && row.status === "failed"
      ? { failureDetails: JSON.parse(row.result_json) as ConversationErrorDetails }
      : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    ...(row.metering_operation_id ? { meteringOperationId: row.metering_operation_id } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {}),
  });
}

function chainFromRow(row: ChainRow): InternalInferenceChainRecord {
  return Object.freeze({
    rootInternalInferenceId: row.root_internal_inference_id as InternalInferenceId,
    agentSessionId: row.agent_session_id as AgentSessionId,
    ...(row.agent_conversation_id ? { agentConversationId: row.agent_conversation_id as AgentConversationId } : {}),
    purpose: row.purpose as InternalInferencePurpose,
    status: row.status as InternalInferenceChainStatus,
    ...(row.active_internal_inference_id
      ? { activeInternalInferenceId: row.active_internal_inference_id as InternalInferenceId }
      : {}),
    ...(row.requested_through_sequence === null ? {} : { requestedThroughSequence: row.requested_through_sequence }),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.error ? { error: row.error } : {}),
  });
}

function databaseNow(database: Database): string {
  const row = database.query<{ now: string }, []>(
    "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now",
  ).get();
  if (!row) throw new Error("SQLite did not provide a current timestamp");
  return row.now;
}

function lostLease(id: InternalInferenceId): PersistenceConflictError {
  return new PersistenceConflictError(`internal inference lease is no longer owned: ${id}`);
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("internal inference list limit must be between 1 and 1000");
  }
  return value;
}

function encodeCursor(requestedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ requestedAt, id }), "utf8").toString("base64url");
}

function decodeCursor(value: string): { requestedAt: string; id: string } {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object") throw new Error();
    const record = decoded as Record<string, unknown>;
    if (typeof record.requestedAt !== "string" || typeof record.id !== "string") throw new Error();
    return { requestedAt: record.requestedAt, id: record.id };
  } catch {
    throw new Error("invalid internal inference cursor");
  }
}
