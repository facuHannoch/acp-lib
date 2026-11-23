import { randomUUID } from "node:crypto";
import type { AgentConversationId } from "../../agent-ids.ts";
import type { PersistenceBackend } from "../../persistence/backend.ts";
import type { ProviderAttachmentState } from "../../persistence/provider-attachment.ts";

/**
 * Write the provider-session row of a loaded session that no conversation had recorded yet (an adoption). A
 * loaded thread is "recorded" in memory already, so this is the one write that makes it durable; the
 * identity delivery cursors restart, as for any new provider context.
 */
export async function recordAdoptedProviderSession(
  persistenceBackend: PersistenceBackend,
  attachment: ProviderAttachmentState,
  id: AgentConversationId,
  transitionId: string,
): Promise<void> {
  if (attachment.kind === "absent") throw new Error("the adopted provider session is not attached");
  const descriptor = attachment.descriptor;
  await persistenceBackend.transaction(async (persistence) => {
    await persistence.identityDelivery?.reset(id, descriptor.internalSessionId);
    await persistence.providerSessions.append({
      providerSessionRecordId: `provider-${randomUUID()}`,
      agentConversationId: id,
      internalSessionId: descriptor.internalSessionId,
      adapterId: descriptor.adapterId,
      mode: descriptor.mode,
      ...(descriptor.model ? { model: descriptor.model } : {}),
      activatedAt: descriptor.acquiredAt,
      transitionId,
      metadata: JSON.stringify({ adopted: true }),
    });
  });
}
