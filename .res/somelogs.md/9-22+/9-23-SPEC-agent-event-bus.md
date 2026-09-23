# Agent committed-record event bus

Status: proposed.

The library currently exposes several independent live-observation mechanisms:

- `AgentConversation.subscribe()` publishes runtime lifecycle changes such as busy state,
  turn start/completion, handoff progress, and metering state.
- prompt handlers publish provisional response chunks and model activity.
- internal inference and audit delivery expose their own runtime subscriptions.
- canonical conversation records can be reconstructed only by reading persistence.

These mechanisms serve different purposes. In particular, none gives an Agent consumer one
live stream of the canonical records that will later be returned by
`persistence.records.list()`. That gap is especially visible for conversation error records:
an API call can reject immediately and later leave a durable error row, but a UI should not
have to poll SQLite to discover that row.

This specification adds an Agent-owned event bus for committed canonical conversation
records. It reuses the existing `Subscribable` and `SubscriptionHub` primitives; it does not
introduce a second general-purpose observation framework.

## Goals

- Publish every canonical conversation record produced by Agent-owned operations after its
  persistence transaction commits.
- Deliver the exact record shape, stable record ID, conversation sequence, sender data, and
  payload that a later persistence read returns.
- Let each subscriber select conversation IDs and record kinds independently.
- Preserve transaction ordering and make rolled-back records unobservable.
- Isolate listener failures from conversation operations and other listeners.
- Give consumers a clear reconciliation pattern between live delivery and paged history.
- Provide the delivery mechanism later used by semantic `error` records without making
  errors a special side channel.

## Non-goals and accepted limitations

- This is not a durable queue. It has no replay buffer, acknowledgement, retry, offset
  storage, or delivery guarantee across process restarts.
- It does not replace `AgentConversation.subscribe()`, prompt streaming handlers, internal
  inference subscriptions, or audit-delivery notifications.
- It does not publish provisional response chunks or records whose persistence transaction
  rolled back.
- It does not emit an independent full-content copy when canonical capture selected
  metadata or `none`.
- It does not provide a durable total order across different conversations. Durable record
  sequence is conversation-local.
- It does not observe records appended by a consumer directly through
  `agent.persistence.records`. Only writes coordinated through Agent-owned library
  operations are published.
- It does not execute subscriber callbacks asynchronously, wait for them, or apply
  subscriber backpressure to producers.
- It does not add an Agent-level durable timeline for identity, internal inference, audit
  delivery, or process lifecycle events.

These limits are intentional. Consumers needing replay read canonical persistence;
consumers needing an independently captured compliance stream use the audit log.

## Relationship to existing streams

The streams have separate meanings:

| API | Meaning | Durable/reloadable |
|---|---|---|
| Prompt handlers | Provider chunks and live model activity | No |
| `conversation.subscribe()` | Runtime control-plane and operation lifecycle | Usually no |
| `agent.events.subscribe()` | Canonical conversation records after commit | Yes, through record reads |
| `agent.audit.subscribe()` | Audit writer health and delivery progress | Audit entries are durable separately |
| `internalInferences.subscribe()` | Internal inference runtime progress | Its repository owns recovery |

One occurrence may appear in more than one stream at different abstraction levels. For
example, a tool update may first arrive provisionally through a prompt handler, then appear
as a committed `tool_call` record through `agent.events`. Consumers reconcile the latter by
its canonical identity rather than treating both as two independent actions.

The new bus does not forward existing `AgentSessionEvent` values into a larger union. Doing
so would conflate provisional process state with durable timeline data and make restart
semantics unclear.

## Public API

Every opened `Agent` exposes one bus spanning all of its conversations:

```ts
export interface AgentEventSubscriptionOptions {
  /** Undefined means every Agent-owned conversation. */
  readonly conversationIds?: readonly AgentConversationId[];
  /** Undefined means every canonical conversation-record kind. */
  readonly recordKinds?: readonly ConversationRecordKind[];
}

export interface ConversationRecordCommittedEvent {
  readonly kind: "conversation_record_committed";
  readonly record: ConversationRecord;
}

export type AgentEvent = ConversationRecordCommittedEvent;

export interface AgentEventNotification {
  /** Process-local order assigned before subscriber filtering. */
  readonly deliverySequence: number;
  /** Time at which the committed record was offered to listeners. */
  readonly emittedAt: string;
  readonly agentSessionId: AgentSessionId;
  readonly event: AgentEvent;
}

export type AgentEventListener = (notification: AgentEventNotification) => void;

export interface AgentEventBus extends Subscribable<AgentEventNotification> {
  subscribe(
    listener: AgentEventListener,
    options?: AgentEventSubscriptionOptions,
  ): Unsubscribe;
}
```

Usage:

```ts
const unsubscribe = agent.events.subscribe((notification) => {
  const { record } = notification.event;
  renderOrReconcile(record);
}, {
  conversationIds: [conversation.id],
  recordKinds: ["message", "tool_call", "permission", "error"],
});

// Later:
unsubscribe();
```

`"error"` becomes available when the conversation-error-record specification is
implemented. The event bus itself must work with the exported
`CONVERSATION_RECORD_KINDS` rather than maintaining a second hard-coded kind list.

The ordinary `subscribe(listener)` form receives every committed canonical record for the
Agent. The method remains structurally compatible with `Subscribable` because its options
parameter is optional.

## Filtering contract

Filters are fixed for the lifetime of one subscription:

- `conversationIds: undefined` selects every conversation.
- `recordKinds: undefined` selects every record kind.
- An empty array selects nothing.
- Duplicate values are normalized.
- Unknown conversation IDs are allowed and simply match no records until such a logical
  conversation exists.
- Unknown record kinds fail subscription immediately instead of being silently ignored.

Filtering occurs in memory before invoking the listener. It does not cause additional
database queries and does not affect canonical persistence, audit capture, identity, or
other subscribers.

Deeper conditions—specific participants, operation IDs, tool states, error codes, or
protocol methods—remain ordinary consumer predicates in v1. Adding a query language to the
live bus would duplicate the persistence read API and complicate future record kinds.

## Capture semantics

Event filtering and record capture solve different problems:

- `AgentConfig.capture` decides whether a canonical record exists and how much of it is
  stored.
- `agent.events.subscribe(..., { recordKinds })` decides which existing committed records
  a particular listener receives.
- `auditLog.capture` independently decides what enters the audit stream.

The bus emits the exact post-capture `ConversationRecord` returned by
`PersistenceScope.records.append()`. Therefore:

- canonical `message: "content"` emits message content;
- canonical `message: "metadata"` emits the metadata-shaped message record;
- canonical `message: "none"` emits no message event;
- an audit-only observation emits no committed-record event;
- raw protocol payload is emitted only if canonical protocol capture retained it.

This avoids a hidden second transcript in memory and guarantees that a live event can be
reloaded with the same record ID and sequence. A consumer that needs live message content
must enable canonical message content capture. This is an accepted tradeoff rather than a
second independently projected payload system.

## Commit and ordering semantics

### Emission boundary

A record is emitted only after the transaction that appended it has committed. If one
transaction appends multiple canonical records, they are emitted afterward in ascending
conversation sequence order.

The bus must never invoke user code inside a SQLite transaction. Subscriber latency,
exceptions, re-entrant reads, or process termination must not influence commit outcome.

When a transaction includes canonical records and audit-outbox intent:

```text
append canonical record(s)
→ enqueue selected audit observation(s)
→ commit transaction
→ publish canonical record event(s)
→ notify audit writer
```

If the transaction fails, no corresponding committed-record event is published.

### Ordering

`record.sequence` is the authoritative durable order within a conversation.

`notification.deliverySequence` is a monotonically increasing process-local counter for
the Agent bus. It:

- orders emissions performed by the current Agent owner;
- can contain gaps for a filtered subscriber;
- resets when the Agent is reopened;
- is not stored and must not be used as a replay cursor; and
- does not create a durable cross-conversation order.

Concurrent conversations may commit in either order. Their delivery order reports the
order in which the owning process published the completed commits, not a semantic causal
relationship between conversations.

### Revisions

Every physical canonical record append emits one event. Evolving messages, tool calls,
thinking, and activities may therefore produce multiple records or revisions with the same
logical identity.

Consumers reconstructing chat state must use the same reconciliation keys as persistence:

- message: `logicalMessageId` when present, otherwise `recordId`;
- tool call: `toolCallId`;
- permission: `permissionId`;
- thinking: `thinkingId`;
- activity: `activityId`;
- immutable one-shot records: `recordId`.

Later conversation sequence wins when reconciling revisions. The event bus does not emit a
second synthetic “updated” event or mutate a previously delivered object.

## Listener behavior

Delivery uses the existing synchronous, registration-ordered, exception-isolated
`SubscriptionHub` behavior:

- listeners registered earlier run first;
- the listener set is snapshotted before each emission;
- unsubscribe is idempotent;
- subscribing or unsubscribing during a callback affects later emissions only;
- one listener throwing does not prevent other listeners from running;
- listener failures are logged and never fail the operation that produced the record.

Listeners must return promptly and must not return a promise. Consumers performing network
or expensive work should enqueue it into their own runtime. The bus intentionally has no
unbounded buffer and no producer backpressure.

Notifications and records follow the library’s readonly-value contract. The bus shares one
record value across listeners rather than cloning large raw protocol or content payloads
per subscriber. Mutating received values is unsupported; implementation should freeze the
notification and top-level event/record values consistently with existing public result
objects. Deep cloning or deep freezing every payload is explicitly not required in v1 due
to the cost of large raw protocol records.

Listener exceptions must only produce a logger entry. They must not create conversation
error records, which would recursively generate more bus events.

## Lifecycle

- `agent.events` exists for every `Agent`, regardless of whether the backend is SQLite or a
  custom implementation.
- Subscriptions begin with future records only; subscribing does not read history.
- Closing the Agent prevents further publication and clears its subscriptions after all
  already-authorized Agent shutdown writes finish.
- No synthetic `agent_opened` or `agent_closed` events are added in v1.
- An `AgentConversation` does not own a second record bus. Consumers filter the Agent bus by
  `conversation.id`.
- Detached/direct `AgentConversation` instances without an owning `Agent` retain their
  existing runtime subscription and transcript APIs; they are outside this Agent bus.

An Agent-level bus is necessary because some operations, notably a failed provider load,
can persist a conversation record before an `AgentConversation` is successfully returned to
the caller.

## History bootstrap and reconnection

The bus is deliberately not replayable. A consumer building a UI should subscribe first,
buffer incoming events while reading history, and reconcile by canonical identity:

```ts
const pending: ConversationRecord[] = [];
const unsubscribe = agent.events.subscribe(({ event }) => {
  pending.push(event.record);
}, {
  conversationIds: [conversationId],
});

const page = await agent.persistence.records.listRecent(conversationId, {
  limit: 50,
});

render(reconcileConversationTimeline([...page.records, ...pending]));
```

After bootstrap, apply future events directly through the same reconciliation function.
Duplicate records are harmless because IDs and sequences are stable. For missed events or a
new process, resume from persistence using `afterSequence` or the existing paging cursors.

The implementation need not provide a subscribe-and-snapshot transaction. The
subscribe-first/buffer/read/deduplicate pattern closes the race without coupling database
transactions to listener registration.

## Integration with error records

The later error-record implementation follows the ordinary record path:

1. Classify and sanitize the failure.
2. Attempt to append the selected canonical `ErrorRecord` and audit intent transactionally.
3. After commit, publish `conversation_record_committed` carrying that `ErrorRecord`.
4. Reject or return from the original API using the structured error contract.

The API error remains the control-flow signal. The bus event is an observation for UI and
monitoring. A subscriber may therefore receive the committed error record immediately
before the originating promise rejects.

If canonical error capture is `none`, no bus event is emitted; the structured API error is
still returned and an independently selected audit observation may still be written. If
SQLite itself is unavailable, there is no committed error record and therefore no bus
event.

Native actions, configurations, tools, permissions, and other record types use this same
path. Their existing failed-state records are emitted normally; they are not duplicated as
generic error events unless the error-record specification identifies a distinct
operational root cause.

## Integration point

Publication belongs at the common Agent-owned persistence boundary, not at each activity or
operation call site.

`PersistedConversationLifecycle.persistObservations()` already:

1. applies canonical capture;
2. appends accepted records;
3. enqueues audit intent; and
4. returns the persisted records after transaction completion.

It should publish those returned records immediately after the transaction resolves.
`meteringRecorded()` currently has a separate transaction and must publish its returned
metering reference through the same internal publication method. Future error records must
also use that method.

Use one Agent-internal operation:

```ts
agent.publishCommittedRecords(records);
```

It accepts only fully persisted `ConversationRecord` values. It is not exported as a public
write API. Centralizing publication here avoids scattering raw `events.emit()` calls and
makes it mechanically clear that an event requires an assigned canonical sequence.

Identity updates and checkpoint scheduling happen after canonical commit today. Event
publication also happens after commit and must not be withheld merely because a later
identity update or checkpoint request fails: the canonical record already exists. The exact
relative order between publication and those post-commit projections must be fixed by the
implementation and tested; the recommended order is publish first, then update derived
identity/checkpoint state.

## File organization

Use the existing observation module:

```text
src/observation/
  contracts.ts                 # existing generic Subscribable contracts
  subscription-hub.ts          # existing generic delivery primitive
  agent-event-bus.ts           # Agent event contracts, filters, and bus
  index.ts                     # public exports
```

`agent-event-bus.ts` owns only event delivery and filter normalization. It does not know how
to write persistence, project audit payloads, update identity, or classify errors.

`src/agent.ts` owns the bus instance and invokes it from the Agent persistence boundary.
Do not add event-bus logic to `src/persistence/backend.ts`; persistence backends should not
call application listeners and must remain usable independently.

## Performance characteristics

For each committed record, publication performs:

- one process-local delivery-sequence increment;
- one filter check per active subscription; and
- one synchronous callback for each match.

It performs no database query, JSON serialization, payload projection, or per-subscriber
clone. When there are no subscribers, the check is constant and no notification object need
be allocated beyond what the implementation requires for correctness.

High-volume raw protocol capture can produce high-volume bus traffic. Consumers should
exclude `protocol` unless needed, and canonical protocol capture should normally exclude
`session/update` as already supported. The bus does not coalesce records because doing so
would make live delivery disagree with canonical history.

## Tests

Add deterministic coverage for:

- A committed message emits the exact persisted record and sequence.
- A transaction containing multiple records emits them after commit in conversation order.
- A rolled-back transaction emits nothing.
- Canonical capture `none` emits nothing for that kind.
- Metadata capture emits the persisted metadata projection rather than original content.
- Audit-only observations do not emit canonical-record events.
- Conversation and kind filters are independent per subscriber.
- Empty filters select nothing and unknown record kinds fail immediately.
- Listener registration order is stable.
- One throwing listener does not block another or fail the originating operation.
- Unsubscribe is idempotent and stops future delivery.
- Re-entrant persistence reads from a listener occur outside the write transaction.
- Concurrent conversations preserve each conversation’s sequence order.
- Metering references use the common publication path.
- Message/activity/tool revisions are all emitted and reconcile to the same result as a
  persistence reload.
- Agent close clears subscriptions and emits nothing afterward.
- A consumer-direct `persistence.records.append()` is documented and tested as outside the
  Agent bus.
- Once error records exist, a load failure persists and emits one matching `ErrorRecord`
  before the open promise rejects.

## Implementation sequence

1. `feat: expose committed record event bus`
   - Add `agent-event-bus.ts`, `Agent.events`, filter validation, and public exports.
   - Publish records returned from the common Agent-owned persistence path.
   - Include the separate metering-reference path.
2. `test: verify committed record event delivery`
   - Cover commit boundary, filters, listener isolation, ordering, capture interaction, and
     reconciliation.
3. Update `CONSUMER_GUIDE.md` with live-history bootstrap and the distinction between
   provisional conversation events and committed Agent records.

After this bus is complete, implement conversation error records by routing their committed
rows through the same publication path. Do not build a separate error emitter.

## Acceptance criteria

The event bus is complete when:

- every Agent-owned canonical record kind uses one post-commit publication path;
- emitted records are deeply equal to the corresponding records returned by persistence;
- listener code never runs inside a persistence transaction;
- filtering cannot change capture, audit, persistence, or other subscriptions;
- listener failures cannot affect operations or recursively create error records;
- UIs can subscribe, load pages, and deterministically reconcile live events with history;
- no parallel replay store, capture projection, or durable queue has been introduced; and
- the error-record design can use the bus without adding a special notification mechanism.
