import type { Database } from "bun:sqlite";

export interface StoredInferenceRow {
  readonly internalInferenceId: string;
  readonly rootInternalInferenceId: string;
  readonly agentConversationId: string | null;
  readonly purpose: string;
  readonly status: string;
  readonly internalSessionId: string | null;
  readonly resultJson: string | null;
  readonly meteringOperationId: string | null;
}

export interface StoredMessageRow {
  readonly sequence: number;
  readonly role: "assistant" | "user";
  readonly content: string;
}

export function listStoredMessages(
  database: Database,
  agentConversationId: string,
): readonly StoredMessageRow[] {
  return database.query<StoredMessageRow, [string]>(`
    SELECT
      r.sequence,
      m.role,
      m.content_text AS content
    FROM conversation_records r
    JOIN conversation_messages m ON m.record_row_id = r.row_id
    WHERE r.agent_conversation_id = ? AND r.kind = 'message'
    ORDER BY r.sequence
  `).all(agentConversationId);
}

export function findStoredInference(
  database: Database,
  internalInferenceId: string,
): StoredInferenceRow | null {
  return database.query<StoredInferenceRow, [string]>(`
    SELECT
      internal_inference_id AS internalInferenceId,
      root_internal_inference_id AS rootInternalInferenceId,
      agent_conversation_id AS agentConversationId,
      purpose,
      status,
      internal_session_id AS internalSessionId,
      result_json AS resultJson,
      metering_operation_id AS meteringOperationId
    FROM internal_inferences
    WHERE internal_inference_id = ?
  `).get(internalInferenceId);
}
