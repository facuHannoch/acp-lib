import type { JsonObject } from "./checkpoint.ts";
import type {
  TranscriptActivityRecord,
  TranscriptMessageRecord,
  TranscriptReasoningRecord,
} from "./records.ts";

export type TranscriptPresentationRecord =
  | TranscriptMessageRecord
  | TranscriptReasoningRecord
  | TranscriptActivityRecord;

interface TranscriptPresentationItemBase {
  /** Stable identity of the logical display item across persisted revisions. */
  readonly id: string;
  /** Sequence allocated to the item's first appended revision. */
  readonly position: number;
  /** Logical revision of this item. */
  readonly revision: number;
  /** Physical transcript sequence containing this revision. */
  readonly recordSequence: number;
  /** Unix epoch milliseconds from the persisted record envelope: when this revision was written. */
  readonly timestamp: number;
  /** Unix epoch milliseconds when the item's first revision was written. */
  readonly startedAt: number;
  readonly operationId: string;
  readonly transcriptId: string;
  readonly generation: number;
}

export interface TranscriptPresentationMessage extends TranscriptPresentationItemBase {
  readonly kind: "message";
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly providerMessageId?: string;
  readonly status?: string;
  readonly stopReason?: string;
}

export interface TranscriptPresentationReasoning extends TranscriptPresentationItemBase {
  readonly kind: "reasoning";
  readonly text: string;
  readonly status: "in_progress" | "completed";
}

export interface TranscriptPresentationActivity extends TranscriptPresentationItemBase {
  readonly kind: "activity";
  readonly activityId: string;
  readonly activityKind: string;
  readonly reason: TranscriptActivityRecord["reason"];
  readonly status?: string;
  readonly data: JsonObject;
}

/** Folded, display-only transcript projection. It is never continuation authority. */
export type TranscriptPresentationItem =
  | TranscriptPresentationMessage
  | TranscriptPresentationReasoning
  | TranscriptPresentationActivity;

/** `startedAt` is the first revision's time; it defaults to this record's, right for a first revision. */
export function presentationItemFromRecord(
  record: TranscriptPresentationRecord,
  startedAt: number = record.ts,
): TranscriptPresentationItem | null {
  const presentation = record.presentation;
  if (!presentation) return null;
  const base = {
    id: presentation.id,
    position: presentation.position,
    revision: presentation.revision,
    recordSequence: record.seq,
    timestamp: record.ts,
    startedAt,
    operationId: record.operationId,
    transcriptId: record.transcriptId,
    generation: record.generation,
  } as const;
  if (record.t === "message") {
    return Object.freeze({
      ...base,
      kind: "message" as const,
      role: record.role,
      text: record.text,
      ...(record.providerMessageId === undefined ? {} : { providerMessageId: record.providerMessageId }),
      ...(record.status === undefined ? {} : { status: record.status }),
      ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
    });
  }
  if (record.t === "reasoning") {
    return Object.freeze({
      ...base,
      kind: "reasoning" as const,
      text: record.text,
      status: record.status,
    });
  }
  return Object.freeze({
    ...base,
    kind: "activity" as const,
    activityId: record.activityId,
    activityKind: record.kind,
    reason: record.reason,
    ...(record.status === undefined ? {} : { status: record.status }),
    data: structuredClone(record.data) as JsonObject,
  });
}
