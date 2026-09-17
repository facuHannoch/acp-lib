import type { Database } from "bun:sqlite";

export interface StoredMessageRow {
  readonly sequence: number;
  readonly role: "assistant" | "user";
  readonly content: string;
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
