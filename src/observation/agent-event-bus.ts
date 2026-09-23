import type { AgentConversationId, AgentSessionId } from "../agent-ids.ts";
import {
  isConversationRecordKind,
  type ConversationRecord,
  type ConversationRecordKind,
} from "../persistence/backend.ts";
import type { Subscribable, Unsubscribe } from "./contracts.ts";
import { SubscriptionHub, type SubscriptionListenerError } from "./subscription-hub.ts";

/** Declarative selection of committed records. Filters are fixed for one subscription. */
export interface AgentEventSubscriptionOptions {
  /** Undefined means every Agent-owned conversation. An empty array selects nothing. */
  readonly conversationIds?: readonly AgentConversationId[];
  /** Undefined means every canonical conversation-record kind. An empty array selects nothing. */
  readonly recordKinds?: readonly ConversationRecordKind[];
}

export interface ConversationRecordCommittedEvent {
  readonly kind: "conversation_record_committed";
  readonly record: ConversationRecord;
}

export type AgentEvent = ConversationRecordCommittedEvent;

export interface AgentEventNotification {
  /** Process-local order assigned before subscriber filtering. Not a durable cursor. */
  readonly deliverySequence: number;
  /** Time at which the committed record was offered to listeners. */
  readonly emittedAt: string;
  readonly agentSessionId: AgentSessionId;
  readonly event: AgentEvent;
}

export type AgentEventListener = (notification: AgentEventNotification) => void;

export interface AgentEventBus extends Subscribable<AgentEventNotification> {
  subscribe(listener: AgentEventListener, options?: AgentEventSubscriptionOptions): Unsubscribe;
}

export interface AgentEventBusOptions {
  readonly agentSessionId: AgentSessionId;
  readonly onListenerError?: (failure: SubscriptionListenerError<AgentEventNotification>) => void;
}

type RecordFilter = (record: ConversationRecord) => boolean;

function compileFilter(options: AgentEventSubscriptionOptions): RecordFilter {
  const conversationIds = compileConversationIds(options.conversationIds);
  const recordKinds = compileRecordKinds(options.recordKinds);
  return (record) =>
    (conversationIds === null || conversationIds.has(record.agentConversationId))
    && (recordKinds === null || recordKinds.has(record.kind));
}

function compileConversationIds(
  ids: readonly AgentConversationId[] | undefined,
): ReadonlySet<AgentConversationId> | null {
  if (ids === undefined) return null;
  if (!Array.isArray(ids)) {
    throw new TypeError("agent event subscription conversationIds must be an array");
  }
  const normalized = new Set<AgentConversationId>();
  for (const id of ids) {
    if (typeof id !== "string" || id.trim() === "") {
      throw new TypeError("agent event subscription conversationIds must contain non-blank strings");
    }
    normalized.add(id as AgentConversationId);
  }
  return normalized;
}

function compileRecordKinds(
  kinds: readonly ConversationRecordKind[] | undefined,
): ReadonlySet<ConversationRecordKind> | null {
  if (kinds === undefined) return null;
  if (!Array.isArray(kinds)) {
    throw new TypeError("agent event subscription recordKinds must be an array");
  }
  const normalized = new Set<ConversationRecordKind>();
  for (const kind of kinds) {
    if (!isConversationRecordKind(kind)) {
      throw new TypeError(`agent event subscription received an unknown record kind: ${String(kind)}`);
    }
    normalized.add(kind);
  }
  return normalized;
}

/**
 * Process-local observation of committed canonical conversation records.
 *
 * Not durable, not replayable, and never a source of truth: SQLite remains authoritative.
 * A record is published only after the transaction that appended it commits, and every
 * physical append emits one notification, so evolving records produce one event per
 * revision. Consumers reconcile those by canonical identity exactly as a reload would.
 */
export class CommittedRecordEventBus implements AgentEventBus {
  private readonly hub: SubscriptionHub<AgentEventNotification>;
  private deliverySequence = 0;
  private subscriptionCount = 0;
  private closed = false;

  constructor(private readonly options: AgentEventBusOptions) {
    this.hub = new SubscriptionHub(options.onListenerError);
  }

  subscribe(listener: AgentEventListener, options: AgentEventSubscriptionOptions = {}): Unsubscribe {
    if (typeof listener !== "function") {
      throw new TypeError("agent event subscription listener must be a function");
    }
    const matches = compileFilter(options);
    this.subscriptionCount += 1;
    const unsubscribe = this.hub.subscribe((notification) => {
      if (!matches(notification.event.record)) return;
      listener(notification);
    });
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.subscriptionCount -= 1;
      unsubscribe();
    };
  }

  /** @internal Publish records whose persistence transaction has already committed. */
  publish(records: readonly ConversationRecord[]): void {
    // No subscribers means no notification to allocate; the delivery sequence is
    // process-local and never a durable cursor, so skipping it is unobservable.
    if (this.closed || this.subscriptionCount === 0 || records.length === 0) return;
    const ordered = records.length > 1
      ? [...records].sort((left, right) => left.sequence - right.sequence)
      : records;
    for (const record of ordered) {
      const notification: AgentEventNotification = Object.freeze({
        deliverySequence: (this.deliverySequence += 1),
        emittedAt: new Date().toISOString(),
        agentSessionId: this.options.agentSessionId,
        event: Object.freeze({
          kind: "conversation_record_committed" as const,
          record,
        }),
      });
      this.hub.emit(notification);
    }
  }

  /** @internal Prevent further publication and drop every subscription. */
  close(): void {
    this.closed = true;
    this.subscriptionCount = 0;
    this.hub.clear();
  }
}
