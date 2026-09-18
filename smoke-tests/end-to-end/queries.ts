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

export interface StoredMeteringReferenceRow {
  readonly sequence: number;
  readonly operationId: string;
  readonly meteringRecordId: string;
  readonly status: "available" | "partial" | "unavailable";
}

export interface StoredProtocolCaptureSummary {
  readonly total: number;
  readonly sessionUpdates: number;
  readonly bodies: number;
}

/** Query canonical persistence directly, independently of the library repositories. */
export function findStoredUserMessage(
  database: Database,
  agentConversationId: string,
  content: string,
): StoredMessageRow | null {
  return database.query<StoredMessageRow, [string, string, string]>(`
    SELECT
      r.sequence,
      m.role,
      m.content_text AS content
    FROM conversation_records r
    JOIN conversation_messages m ON m.record_row_id = r.row_id
    WHERE r.agent_conversation_id = ?
      AND r.kind = 'message'
      AND m.role = ?
      AND m.content_text = ?
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
      r.sequence,
      m.role,
      m.content_text AS content
    FROM conversation_records r
    JOIN conversation_messages m ON m.record_row_id = r.row_id
    WHERE r.agent_conversation_id = ?
      AND r.kind = 'message'
    ORDER BY r.sequence
  `).all(agentConversationId);
}

/** Inspect the compact protocol-capture policy independently of the library API. */
export function inspectStoredProtocolCapture(
  database: Database,
  agentConversationId: string,
): StoredProtocolCaptureSummary {
  return database.query<StoredProtocolCaptureSummary, [string]>(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN p.method = 'session/update' THEN 1 ELSE 0 END), 0) AS sessionUpdates,
      COALESCE(SUM(CASE WHEN p.message_json IS NOT NULL THEN 1 ELSE 0 END), 0) AS bodies
    FROM conversation_records r
    JOIN conversation_protocol_records p ON p.record_row_id = r.row_id
    WHERE r.agent_conversation_id = ?
      AND r.kind = 'protocol'
  `).get(agentConversationId)!;
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

/** Locate the ordered timeline reference independently of the metering repository. */
export function findStoredMeteringReference(
  database: Database,
  agentConversationId: string,
  operationId: string,
): StoredMeteringReferenceRow | null {
  return database.query<StoredMeteringReferenceRow, [string, string]>(`
    SELECT
      r.sequence,
      m.operation_id AS operationId,
      m.metering_record_id AS meteringRecordId,
      m.status
    FROM conversation_records r
    JOIN conversation_metering_references m ON m.record_row_id = r.row_id
    WHERE r.agent_conversation_id = ?
      AND r.kind = 'metering'
      AND m.operation_id = ?
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
