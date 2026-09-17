import type { Database } from "bun:sqlite";

export interface StoredMessageRow {
  readonly sequence: number;
  readonly role: "assistant" | "user";
  readonly content: string;
}

export interface StoredMeteringRecordRow {
  readonly operationId: string;
  readonly recordJson: string | null;
}

export interface StoredMeteringStateRow {
  readonly revision: number;
  readonly stateJson: string;
}

/** Query canonical persistence directly, independently of the library repositories. */
export function findStoredUserMessage(
  database: Database,
  agentConversationId: string,
  content: string,
): StoredMessageRow | null {
  return database.query<StoredMessageRow, [string, string, string]>(`
    SELECT
      sequence,
      json_extract(payload_json, '$.role') AS role,
      json_extract(payload_json, '$.content') AS content
    FROM conversation_records
    WHERE agent_conversation_id = ?
      AND kind = 'message'
      AND json_extract(payload_json, '$.role') = ?
      AND json_extract(payload_json, '$.content') = ?
    LIMIT 1
  `).get(agentConversationId, "user", content);
}

/** Return every canonical message boundary in conversation order. */
export function listStoredMessages(
  database: Database,
  agentConversationId: string,
): readonly StoredMessageRow[] {
  return database.query<StoredMessageRow, [string]>(`
    SELECT
      sequence,
      json_extract(payload_json, '$.role') AS role,
      json_extract(payload_json, '$.content') AS content
    FROM conversation_records
    WHERE agent_conversation_id = ?
      AND kind = 'message'
    ORDER BY sequence
  `).all(agentConversationId);
}

/** Query one normalized metering operation independently of the persistence API. */
export function findStoredMeteringRecord(
  database: Database,
  agentConversationId: string,
  operationId: string,
): StoredMeteringRecordRow | null {
  return database.query<StoredMeteringRecordRow, [string, string]>(`
    SELECT operation_id AS operationId, record_json AS recordJson
    FROM metering_records
    WHERE agent_conversation_id = ? AND operation_id = ?
  `).get(agentConversationId, operationId);
}

/** Read the bounded state used to restore metering after a process restart. */
export function findStoredMeteringState(
  database: Database,
  agentConversationId: string,
): StoredMeteringStateRow | null {
  return database.query<StoredMeteringStateRow, [string]>(`
    SELECT revision, state_json AS stateJson
    FROM conversation_metering_state
    WHERE agent_conversation_id = ?
  `).get(agentConversationId);
}
