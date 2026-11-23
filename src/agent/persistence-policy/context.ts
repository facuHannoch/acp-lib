import type { AgentConversationSummary } from "../../persistence/backend.ts";
import type { ConversationPersistenceContext } from "./types.ts";

export function conversationPersistenceContext(summary: AgentConversationSummary): ConversationPersistenceContext {
  return {
    agentConversationId: summary.agentConversationId,
    participants: summary.participants,
    ...(summary.title !== undefined && summary.title !== null ? { title: summary.title } : {}),
    ...(summary.metadata !== undefined && summary.metadata !== null ? { metadata: summary.metadata } : {}),
    adopted: summary.adopted === true,
    ...(summary.role ? { role: summary.role } : {}),
  };
}
