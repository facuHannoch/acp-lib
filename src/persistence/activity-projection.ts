import type { AggregatedRecord } from "../activity.ts";
import type { ActivityEvent, ToolActivity } from "../types.ts";
import type { JsonObject, JsonValue } from "./checkpoint.ts";
import type { NormalizedPersistenceEvent } from "./projection.ts";

/**
 * Classify an already-folded live activity record into persistence security buckets.
 * This function deliberately does not serialize or hash values: capture projection gets
 * to discard a bucket before the writer ever examines its potentially sensitive content.
 */
export function persistenceEventFromActivity(
  record: AggregatedRecord,
  operationId: string,
): NormalizedPersistenceEvent {
  if (record.event.kind === "thinking") {
    return {
      kind: "reasoning",
      reasoningId: record.recordId,
      reasoningRevision: record.seq,
      operationId,
      text: record.event.text,
      status: record.reason === "settled" || record.reason === "flushed" ? "completed" : "in_progress",
    };
  }

  if (record.event.kind === "tool") {
    return {
      kind: "activity",
      activity: toolProjection(record, record.event, operationId),
    };
  }

  return {
    kind: "activity",
    activity: {
      activityId: record.recordId,
      activityRevision: record.seq,
      operationId,
      reason: record.reason,
      kind: record.event.kind,
      content: { event: record.event as unknown as JsonValue },
    },
  };
}

function toolProjection(
  record: AggregatedRecord,
  event: ToolActivity,
  operationId: string,
) {
  const content: Record<string, JsonValue> = {
    toolKind: event.toolKind,
    ...(event.title === undefined ? {} : { title: event.title }),
    ...(event.rawOutput === undefined ? {} : { rawOutput: event.rawOutput as JsonValue }),
    ...(event.content === undefined ? {} : { content: event.content as unknown as JsonValue }),
    ...(event.locations === undefined ? {} : { locations: event.locations as unknown as JsonValue }),
  };
  return {
    activityId: record.recordId,
    activityRevision: record.seq,
    operationId,
    reason: record.reason,
    kind: "tool",
    status: event.status,
    metadata: { providerActivityId: event.toolCallId },
    ...(event.rawInput === undefined
      ? {}
      : { input: { value: event.rawInput as JsonValue } as JsonObject }),
    content: content as JsonObject,
  };
}
