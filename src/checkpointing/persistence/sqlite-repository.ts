import type { Database } from "bun:sqlite";
import type { AgentConversationId } from "../../agent-ids.ts";
import type { InternalInferenceId } from "../../internal-inference/contracts.ts";
import { PersistenceConflictError } from "../../persistence/backend.ts";
import type {
  ConversationRecoveryCheckpoint,
  ConversationRecoveryCheckpointId,
  ConversationRecoveryCheckpointListOptions,
  ConversationRecoveryCheckpointRepository,
  PublishConversationRecoveryCheckpointInput,
} from "../contracts.ts";

type WriteRunner = <T>(work: () => T) => Promise<T>;

interface CheckpointRow {
  checkpoint_id: string;
  agent_conversation_id: string;
  revision: number;
  covered_sequence: number;
  previous_checkpoint_id: string | null;
  generator_internal_inference_id: string;
  summary: string;
  created_at: string;
  metadata: string | null;
}

export class SqliteConversationRecoveryCheckpointRepository
implements ConversationRecoveryCheckpointRepository {
  constructor(private readonly database: Database, private readonly runWrite: WriteRunner) {}

  async successfulResponseCount(agentConversationId: AgentConversationId): Promise<number> {
    const row = this.database.query<{ count: number }, [string]>(
      `SELECT COUNT(DISTINCT json_extract(metadata, '$.operationId')) AS count
       FROM conversation_records
       WHERE agent_conversation_id = ? AND kind = 'message'
         AND json_extract(payload_json, '$.role') = 'assistant'
         AND json_extract(payload_json, '$.status') = 'completed'
         AND json_extract(metadata, '$.operationId') IS NOT NULL`,
    ).get(agentConversationId);
    return Number(row?.count ?? 0);
  }

  async latestMessageSequence(agentConversationId: AgentConversationId): Promise<number> {
    const row = this.database.query<{ sequence: number }, [string]>(
      `SELECT COALESCE(MAX(sequence), 0) AS sequence FROM conversation_records
       WHERE agent_conversation_id = ? AND kind = 'message'`,
    ).get(agentConversationId);
    return Number(row?.sequence ?? 0);
  }

  async latest(agentConversationId: AgentConversationId): Promise<ConversationRecoveryCheckpoint | null> {
    const row = this.database.query<CheckpointRow, [string]>(
      `SELECT * FROM conversation_recovery_checkpoints
       WHERE agent_conversation_id = ? ORDER BY revision DESC LIMIT 1`,
    ).get(agentConversationId);
    return row ? fromRow(row) : null;
  }

  async get(checkpointId: ConversationRecoveryCheckpointId): Promise<ConversationRecoveryCheckpoint | null> {
    const row = this.database.query<CheckpointRow, [string]>(
      "SELECT * FROM conversation_recovery_checkpoints WHERE checkpoint_id = ?",
    ).get(checkpointId);
    return row ? fromRow(row) : null;
  }

  async list(
    agentConversationId: AgentConversationId,
    options: ConversationRecoveryCheckpointListOptions = {},
  ): Promise<readonly ConversationRecoveryCheckpoint[]> {
    const limit = boundedLimit(options.limit ?? 100);
    const rows = options.beforeRevision === undefined
      ? this.database.query<CheckpointRow, [string, number]>(
        `SELECT * FROM conversation_recovery_checkpoints
         WHERE agent_conversation_id = ? ORDER BY revision DESC LIMIT ?`,
      ).all(agentConversationId, limit)
      : this.database.query<CheckpointRow, [string, number, number]>(
        `SELECT * FROM conversation_recovery_checkpoints
         WHERE agent_conversation_id = ? AND revision < ? ORDER BY revision DESC LIMIT ?`,
      ).all(agentConversationId, options.beforeRevision, limit);
    return Object.freeze(rows.map(fromRow));
  }

  async publish(input: PublishConversationRecoveryCheckpointInput): Promise<ConversationRecoveryCheckpoint> {
    return await this.runWrite(() => {
      const summary = input.summary.trim();
      if (!summary) throw new Error("recovery checkpoint summary cannot be blank");
      if (!Number.isSafeInteger(input.coveredSequence) || input.coveredSequence < 1) {
        throw new Error("recovery checkpoint coveredSequence must be a positive integer");
      }
      const existing = this.database.query<CheckpointRow, [string]>(
        "SELECT * FROM conversation_recovery_checkpoints WHERE checkpoint_id = ?",
      ).get(input.checkpointId);
      if (existing) {
        const checkpoint = fromRow(existing);
        if (
          checkpoint.agentConversationId !== input.agentConversationId
          || checkpoint.coveredSequence !== input.coveredSequence
          || checkpoint.generatorInternalInferenceId !== input.generatorInternalInferenceId
          || checkpoint.summary !== summary
        ) throw new PersistenceConflictError(`recovery checkpoint id conflict: ${input.checkpointId}`);
        return checkpoint;
      }
      const latest = this.database.query<CheckpointRow, [string]>(
        `SELECT * FROM conversation_recovery_checkpoints
         WHERE agent_conversation_id = ? ORDER BY revision DESC LIMIT 1`,
      ).get(input.agentConversationId);
      const previous = latest ? fromRow(latest) : null;
      if ((previous?.checkpointId ?? undefined) !== input.previousCheckpointId) {
        throw new PersistenceConflictError("recovery checkpoint previous version changed");
      }
      if (previous && input.coveredSequence <= previous.coveredSequence) {
        throw new PersistenceConflictError("recovery checkpoint coverage must increase");
      }
      const revision = (previous?.revision ?? 0) + 1;
      const createdAt = input.createdAt ?? new Date().toISOString();
      this.database.query(
        `INSERT INTO conversation_recovery_checkpoints(
          checkpoint_id, agent_conversation_id, revision, covered_sequence,
          previous_checkpoint_id, generator_internal_inference_id, summary, created_at, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.checkpointId,
        input.agentConversationId,
        revision,
        input.coveredSequence,
        input.previousCheckpointId ?? null,
        input.generatorInternalInferenceId,
        summary,
        createdAt,
        input.metadata ?? null,
      );
      return Object.freeze({ ...input, summary, revision, createdAt });
    });
  }
}

function fromRow(row: CheckpointRow): ConversationRecoveryCheckpoint {
  return Object.freeze({
    checkpointId: row.checkpoint_id as ConversationRecoveryCheckpointId,
    agentConversationId: row.agent_conversation_id as AgentConversationId,
    revision: Number(row.revision),
    coveredSequence: Number(row.covered_sequence),
    ...(row.previous_checkpoint_id
      ? { previousCheckpointId: row.previous_checkpoint_id as ConversationRecoveryCheckpointId }
      : {}),
    generatorInternalInferenceId: row.generator_internal_inference_id as InternalInferenceId,
    summary: row.summary,
    createdAt: row.created_at,
    ...(row.metadata ? { metadata: row.metadata } : {}),
  });
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("recovery checkpoint limit must be an integer between 1 and 1000");
  }
  return value;
}
