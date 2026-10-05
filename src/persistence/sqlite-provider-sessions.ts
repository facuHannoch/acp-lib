import type { Database } from "bun:sqlite";
import type { AgentConversationId } from "../agent-ids.ts";

/**
 * Conversations that own a provider session: the one it is active in, and the ones that asked to adopt it and
 * have not attached it yet (an adoption that failed before the session was recorded still holds its claim).
 * Deleted conversations hold nothing.
 */
export function conversationsUsingProviderSession(
  database: Database,
  internalSessionId: string,
): readonly AgentConversationId[] {
  const rows = database.query<{ agent_conversation_id: string }, [string, string]>(
    `SELECT c.agent_conversation_id
     FROM conversations c
     WHERE c.deleted_at IS NULL
       AND (
         EXISTS (
           SELECT 1 FROM provider_sessions p
           WHERE p.agent_conversation_id = c.agent_conversation_id
             AND p.internal_session_id = ?
             AND p.deactivated_at IS NULL
         )
         OR (
           c.adopt_provider_session_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM provider_sessions p
             WHERE p.agent_conversation_id = c.agent_conversation_id AND p.deactivated_at IS NULL
           )
         )
       )
     ORDER BY c.created_at, c.agent_conversation_id`,
  ).all(internalSessionId, internalSessionId);
  return Object.freeze(rows.map((row) => row.agent_conversation_id as AgentConversationId));
}
