import {
  ActivityAggregator,
  type ActivitySnapshot,
  type AggregatedRecord,
  type ApplyResult,
} from "./activity.ts";
import type { Logger } from "./logger.ts";
import { persistenceEventFromActivity } from "./persistence/activity-projection.ts";
import {
  presentationItemFromRecord,
  type TranscriptPresentationItem,
} from "./persistence/presentation.ts";
import type {
  PersistenceStateRuntime,
  PresentationPersistenceEvent,
} from "./persistence/state-runtime.ts";
import type { TranscriptActivityLine } from "./transcript.ts";
import type { ActivityEvent, PromptHandlers } from "./types.ts";
import type { TranscriptActivityConfig } from "./agent-conversation-contracts.ts";

// Legacy JSONL v1 exposed these provider updates under its broad `activity`
// contract. Keep that compatibility surface isolated from V2 classification.
const LEGACY_DEFAULT_ACTIVITY_KINDS: ReadonlyArray<ActivityEvent["kind"]> = [
  "tool",
  "thinking",
  "plan",
  "plan_update",
  "plan_removed",
  "usage",
  "mode",
  "unknown",
];

export interface AgentConversationPresentationOptions {
  readonly activity?: boolean | TranscriptActivityConfig;
  readonly logger: Logger;
  /** Current V2 persistence runtime; it can be installed after construction. */
  readonly persistence: () => PersistenceStateRuntime | null;
  /** Legacy JSONL append hook. Omit when no legacy transcript is configured. */
  readonly appendLegacyActivity?: (line: TranscriptActivityLine) => Promise<void>;
  readonly onPresentation: (item: TranscriptPresentationItem) => void;
}

/**
 * Conversation-owned coordination for live activity and durable presentation order.
 * It deliberately does not emit AgentSession lifecycle events or own persistence state.
 */
export class AgentConversationPresentation {
  readonly #aggregator: ActivityAggregator;
  readonly #captureLegacyActivity: boolean;
  readonly #activityKinds: ReadonlySet<string>;
  readonly #includeRawOutput: boolean;
  readonly #maxActivityBytes: number | null;
  readonly #logger: Logger;
  readonly #persistence: () => PersistenceStateRuntime | null;
  readonly #appendLegacyActivity?: (line: TranscriptActivityLine) => Promise<void>;
  readonly #onPresentation: (item: TranscriptPresentationItem) => void;
  #presentationWrite: Promise<void> = Promise.resolve();

  constructor(options: AgentConversationPresentationOptions) {
    const activity = options.activity === true ? {} : options.activity || null;
    this.#captureLegacyActivity = activity !== null;
    this.#activityKinds = new Set(activity?.kinds ?? LEGACY_DEFAULT_ACTIVITY_KINDS);
    this.#includeRawOutput = activity?.rawOutput === true;
    this.#maxActivityBytes =
      activity?.maxBytes != null && activity.maxBytes > 0 ? activity.maxBytes : null;
    this.#aggregator = new ActivityAggregator({ checkpointOnInput: activity?.checkpointOnInput });
    this.#logger = options.logger;
    this.#persistence = options.persistence;
    this.#appendLegacyActivity = options.appendLegacyActivity;
    this.#onPresentation = options.onPresentation;
  }

  snapshot(): ActivitySnapshot {
    return this.#aggregator.snapshot();
  }

  beginTurn(turnId: string): void {
    const leftover = this.#aggregator.startTurn(turnId);
    if (leftover.length === 0) return;
    this.#logger.warn("activity_turn_not_flushed", { records: leftover.length });
    for (const record of leftover) this.#writeActivity(record);
  }

  endTurn(handlers?: PromptHandlers): readonly AggregatedRecord[] {
    const emitted = this.#aggregator.flush();
    if (emitted.length === 0) return emitted;
    for (const record of emitted) this.#writeActivity(record);
    handlers?.onRecord?.({ current: null, delta: null, emitted });
    return emitted;
  }

  closeReasoningBoundary(): AggregatedRecord | null {
    const record = this.#aggregator.closeReasoningBoundary();
    if (record) this.#writeActivity(record);
    return record;
  }

  applyActivity(event: ActivityEvent): ApplyResult {
    const result = this.#aggregator.apply(event);
    for (const record of result.emitted) this.#writeActivity(record);
    return result;
  }

  queuePresentation(event: PresentationPersistenceEvent): void {
    this.#presentationWrite = this.#presentationWrite.then(async () => {
      const persistence = this.#persistence();
      if (!persistence) return;
      const record = await persistence.appendPresentationEvent(event);
      this.emitPersistedRecord(record);
    });
  }

  emitPersistedRecord(
    record: Awaited<ReturnType<PersistenceStateRuntime["appendPresentationEvent"]>>,
  ): void {
    if (!record) return;
    const item = presentationItemFromRecord(record);
    if (item) this.#onPresentation(item);
  }

  async drain(): Promise<void> {
    await this.#presentationWrite;
  }

  #writeActivity(record: AggregatedRecord): void {
    const persistence = this.#persistence();
    if (persistence) {
      const operationId = persistence.checkpoint.boundary.status === "in_flight"
        ? persistence.checkpoint.boundary.interruptedOperationId
        : record.recordId.split(":", 1)[0] ?? record.recordId;
      const projected = persistenceEventFromActivity(record, operationId);
      if (!projected) return;
      this.queuePresentation({
        ...projected,
        presentation: {
          id: `${projected.kind}:${operationId}:${record.recordId}`,
          revision: record.seq,
        },
      });
      return;
    }
    if (!this.#captureLegacyActivity || !this.#appendLegacyActivity) return;
    if (!this.#activityKinds.has(record.event.kind)) return;
    void this.#appendLegacyActivity(this.#toLegacyActivityLine(record));
  }

  #toLegacyActivityLine(record: AggregatedRecord): TranscriptActivityLine {
    let fields: Record<string, unknown> = { ...record.event };
    if (!this.#includeRawOutput) delete fields.rawOutput;

    let truncated = false;
    if (this.#maxActivityBytes != null) {
      const capped = capActivityStrings(fields, this.#maxActivityBytes);
      fields = capped.fields;
      truncated = capped.truncated;
    }

    const line: TranscriptActivityLine = {
      ...fields,
      v: 1,
      t: "activity",
      ts: Date.now(),
      recordId: record.recordId,
      reason: record.reason,
      kind: record.event.kind,
    };
    if (truncated) line.truncated = true;
    return line;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function capActivityStrings(
  fields: Record<string, unknown>,
  maxBytes: number,
): { fields: Record<string, unknown>; truncated: boolean } {
  let truncated = false;
  const cap = (text: string): string => {
    const bytes = encoder.encode(text);
    if (bytes.length <= maxBytes) return text;
    let end = maxBytes;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    truncated = true;
    return `${decoder.decode(bytes.subarray(0, end))}… [truncated ${bytes.length - end} bytes]`;
  };
  const capUnknown = (value: unknown): unknown => {
    if (typeof value === "string") return cap(value);
    const text = JSON.stringify(value) ?? "";
    const capped = cap(text);
    return capped === text ? value : capped;
  };

  const out = { ...fields };
  if (out.rawInput !== undefined) out.rawInput = capUnknown(out.rawInput);
  if (out.rawOutput !== undefined) out.rawOutput = capUnknown(out.rawOutput);
  if (typeof out.text === "string") out.text = cap(out.text);
  if (Array.isArray(out.content)) {
    out.content = (out.content as unknown[]).map((entry) => {
      if (entry === null || typeof entry !== "object") return entry;
      const item = { ...(entry as Record<string, unknown>) };
      if (typeof item.text === "string") item.text = cap(item.text);
      if (typeof item.output === "string") item.output = cap(item.output);
      if (typeof item.oldText === "string") item.oldText = cap(item.oldText);
      if (typeof item.newText === "string") item.newText = cap(item.newText);
      if (item.content !== null && typeof item.content === "object") {
        const block = { ...(item.content as Record<string, unknown>) };
        if (typeof block.text === "string") block.text = cap(block.text);
        item.content = block;
      }
      return item;
    });
  }
  return { fields: out, truncated };
}
