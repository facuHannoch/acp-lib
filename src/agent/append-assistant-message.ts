import { randomUUID } from "node:crypto";
import type { Agent } from "../agent.ts";
import type { AgentConversationId } from "../agent-ids.ts";
import { persistParts } from "../media/content.ts";
import { isMediaPart, partsText, promptParts } from "../media/parts.ts";
import { pendingOutOfBandParts } from "../media/pending.ts";
import { resolveParts } from "../media/store.ts";
import { isOutOfBandMessage, OUT_OF_BAND_MESSAGE_ORIGIN, type AppendAssistantMessageInput } from "../out-of-band-messages.ts";
import type { AgentConversationSummary, ConversationRecord, MessageRecord } from "../persistence/backend.ts";
import type { ManagerSettings } from "./manager-settings.ts";
import { persistObservationsInTransaction, updateConversationIdentity } from "./record-capture.ts";

export class AppendDestinationUnavailableError extends Error {}

export async function appendAssistantMessage(
  agent: Agent, id: AgentConversationId, input: AppendAssistantMessageInput, cwd: string,
  writeSettings: (summary: AgentConversationSummary) => ManagerSettings, stableId?: string,
): Promise<MessageRecord> {
  const parts = promptParts(input) ?? [{ kind: "text" as const, text: input.text ?? "" }];
  const hasMedia = parts.some((part) => part.kind !== "text" && part.kind !== "pasted");
  if (!partsText(parts).trim() && !hasMedia) {
    throw new Error("assistant message text cannot be blank");
  }
  const summary = await agent.persistence.conversations.get(id);
  if (!summary || summary.deletedAt) throw new AppendDestinationUnavailableError(`unknown active conversation: ${id}`);
  const settings = writeSettings(summary);
  const level = settings.capture.message;
  if (!hasMedia && level !== "content" && level !== "raw") {
    throw new Error(
      `appending an assistant message requires message capture "content" or "raw", not "${level}"`,
    );
  }
  // No agent reads the parts yet: every kind is accepted now, and delivery names what the agent of
  // the next turn cannot take.
  const resolved = await resolveParts(parts, {
    cwd,
    capabilities: { image: true, audio: true, embeddedContext: true },
    thresholds: agent.media.thresholds,
    owner: id,
    store: agent.media.store ?? agent.persistence.media,
  });
  const appendId = stableId ?? `append-${randomUUID()}`;
  const persisted: ConversationRecord[] = [];
  const recordId = stableId ?? `${appendId}:assistant`;
  const existing = await agent.persistence.transaction(async (scope) => {
    if (stableId !== undefined) {
      const active = await scope.conversations.get(id);
      if (!active || active.deletedAt) throw new AppendDestinationUnavailableError(`unknown active conversation: ${id}`);
      const saved = await scope.records.get(recordId);
      if (saved) {
        if (!isOutOfBandMessage(saved) || saved.agentConversationId !== id || saved.role !== "assistant") {
          throw new Error(`out-of-band record ID belongs to another write: ${recordId}`);
        }
        return saved;
      }
    }
    const content = await persistParts(resolved, id, agent.media.store ?? scope.media, settings.capture.media);
    await persistObservationsInTransaction(settings, scope, [{
      recordId,
      agentSessionId: agent.id,
      agentConversationId: id,
      kind: "message",
      timestamp: new Date().toISOString(),
      // A standalone message at its observed sequence, without a provider operation.
      role: "assistant",
      logicalMessageId: `message:${appendId}:assistant`,
      ...(input.consumerMetadata !== undefined ? { consumerMetadata: input.consumerMetadata } : {}),
      content,
      status: "completed",
      metadata: JSON.stringify({ origin: OUT_OF_BAND_MESSAGE_ORIGIN, appendId }),
    }], true, persisted);
  });
  if (existing) return existing;
  const record = persisted[0];
  if (record?.kind !== "message") throw new Error("assistant message was not persisted");
  // The next turn delivers the message from its record. When the record cannot restore it (a part
  // not recorded, media left out by capture, a copy not kept, text not captured), its parts wait in
  // memory instead.
  const blocks = Array.isArray(record.content) ? record.content : [];
  const media = resolved.filter(isMediaPart);
  const restorable = (level === "content" || level === "raw")
    && resolved.every((part) => part.record !== false)
    && blocks.filter((block) => block.type === "media").length === media.length
    && blocks.filter((block) => block.type === "media" && block.ref).length
      === media.filter((part) => part.mode === "copy").length;
  if (!restorable) pendingOutOfBandParts(agent).set(recordId, { owner: id, parts: resolved });
  agent.publishCommittedRecords(persisted);
  if (settings.auditLog) agent.audit?.notifyPending();
  await updateConversationIdentity(agent, settings, id, [record]);
  return record;
}
