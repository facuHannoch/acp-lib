import type { ConversationRecord, ConversationRecordKind } from "./backend.ts";

/** One logical chat item, possibly assembled from several immutable lifecycle records. */
export interface ConversationTimelineItem {
  readonly id: string;
  readonly kind: ConversationRecordKind;
  readonly firstSequence: number;
  readonly lastSequence: number;
  /** Records in canonical order; retain these when rendering lifecycle details. */
  readonly revisions: readonly ConversationRecord[];
  /** Later fields override earlier ones, while omitted fields are retained. */
  readonly current: ConversationRecord;
}

/**
 * Reconcile older pages and live catch-up in any arrival order. Physical record IDs
 * deduplicate replay; logical IDs keep lifecycle updates at the original item position.
 */
export function reconcileConversationTimeline(
  existing: readonly ConversationTimelineItem[],
  incoming: readonly ConversationRecord[],
): readonly ConversationTimelineItem[] {
  const grouped = new Map<string, Map<string, ConversationRecord>>();
  for (const item of existing) {
    grouped.set(item.id, new Map(item.revisions.map((record) => [record.recordId, record])));
  }
  for (const record of incoming) {
    const id = conversationTimelineItemId(record);
    const revisions = grouped.get(id) ?? new Map<string, ConversationRecord>();
    revisions.set(record.recordId, record);
    grouped.set(id, revisions);
  }
  const items: ConversationTimelineItem[] = [];
  for (const [id, records] of grouped) {
    const revisions = [...records.values()].sort((left, right) => left.sequence - right.sequence);
    if (revisions.length === 0) continue;
    items.push(Object.freeze({
      id,
      kind: revisions[0]!.kind,
      firstSequence: revisions[0]!.sequence,
      lastSequence: revisions.at(-1)!.sequence,
      revisions: Object.freeze(revisions),
      current: Object.freeze(Object.assign({}, ...revisions)) as ConversationRecord,
    }));
  }
  items.sort((left, right) => left.firstSequence - right.firstSequence || left.id.localeCompare(right.id));
  return Object.freeze(items);
}

/** Stable within a conversation. Independent messages are never combined. */
export function conversationTimelineItemId(record: ConversationRecord): string {
  const prefix = `${record.agentConversationId}:${record.kind}:`;
  const scope = operationScope(record);
  switch (record.kind) {
    case "message": return `${prefix}${JSON.stringify([record.logicalMessageId ?? record.recordId])}`;
    case "tool_call": return `${prefix}${JSON.stringify([scope, record.toolCallId])}`;
    case "permission": return `${prefix}${JSON.stringify([scope, record.permissionId])}`;
    case "thinking": return `${prefix}${JSON.stringify([scope, record.thinkingId])}`;
    case "activity": return `${prefix}${JSON.stringify([scope, record.activityId])}`;
    case "native_action": return `${prefix}${JSON.stringify([record.transitionId ?? record.recordId])}`;
    default: return `${prefix}${JSON.stringify([record.recordId])}`;
  }
}

function operationScope(record: ConversationRecord): string {
  if (!record.metadata) return "";
  try {
    const parsed = JSON.parse(record.metadata) as { operationId?: unknown };
    return typeof parsed.operationId === "string" ? `${parsed.operationId}:` : "";
  } catch {
    return "";
  }
}
