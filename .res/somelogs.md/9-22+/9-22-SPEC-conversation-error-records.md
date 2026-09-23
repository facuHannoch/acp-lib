# Conversation error records

Status: implemented except idle process/transport loss and prompt interruption.

Implemented: the `error` record kind and capture policy (canonical `content` default plus an
independent audit level); SQLite schema v12 with `conversation_error_records`, migrating
versions 8 through 11 in place (the `conversation_records` kind CHECK is rebuilt with row
ids preserved and `PRAGMA foreign_key_check` verified before commit); sanitized display
messages and allow-listed raw `details`; attempt identity (`{attemptId}:error`, idempotent
re-append); provider-session load, creation, and recovery failures recorded and published
through `agent.events`; and `ProviderSessionError` for creation/opening failures. Errors
stay out of full-text search.

Not implemented: idle provider-process/transport loss and prompt interruption. The transport
currently swallows an unexpected process exit — it logs `process_exit` and resets the client
(`src/client.ts`) — so the owning conversation receives no signal to record
`provider_process_exited`, `connection_lost`, or `prompt_interrupted`. Closing that gap needs
a crash-observation path from the transport up to the conversation plus root-cause ownership
so an active operation's failure is recorded once rather than twice.

Conversation failures are currently observable through rejected API calls, logger
entries, and, when enabled, raw protocol capture. They are not consistently represented
in the canonical SQLite timeline. A failed `session/load`, for example, may prevent an
`AgentConversation` from opening while leaving no semantic record a consumer can render
after restart. Recovery progress is ephemeral, and the raw ACP error is neither enabled
by default nor an appropriate UI contract.

This specification adds an immutable `error` conversation-record kind. It records a
bounded, sanitized diagnosis at meaningful conversation boundaries. It does not claim
that provider sessions are durable, and it does not turn every thrown exception into
transcript content.

## Goals

- Make important runtime failures visible in the same ordered record stream as messages,
  activities, actions, and metering references.
- Let canonical persistence and the audit destination select their own error capture
  levels, while retaining the existing atomic SQLite/outbox write boundary.
- Give consumers stable machine codes and safe fallback messages without requiring raw
  ACP inspection.
- Correlate an error with the operation, transition, or provider session that encountered
  it.
- Preserve current control flow: recording an error does not itself retry, recover,
  replace a provider session, or replay a prompt.
- Return structured API errors carrying the same durable identity and classification.

## Non-goals

- Guaranteeing that a provider session ID will remain loadable.
- Defining a provisional/confirmed provider-durability state.
- Persisting validation errors rejected before a conversation operation begins.
- Mirroring every failed native action, configuration change, tool call, or other lifecycle
  record into a second error record. Those records already describe their own outcome. An
  error record is added only for a distinct, meaningful operational root cause.
- Storing an error in SQLite when SQLite itself is unavailable.
- Adding error text to FTS5 in v1.
- Adding manager-level retry, recovery, or fresh-session commands in this change. The
  record and structured exception must leave room for those APIs.

## Record model

Add `"error"` to `CONVERSATION_RECORD_KINDS` and the `ConversationRecord` union.

```ts
export type ConversationErrorSource =
  | "provider_session"
  | "transport"
  | "operation"
  | "recovery";

export type ConversationErrorRecoverability =
  | "retryable"
  | "recoverable"
  | "terminal"
  | "unknown";

export interface ConversationErrorDetails {
  readonly providerCode?: string | number;
  readonly rpcCode?: number;
  readonly service?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly transportState?: string;
}

export interface ErrorRecord extends ConversationRecordEnvelope<"error"> {
  readonly source: ConversationErrorSource;
  /** Stable machine-readable value. The type remains open for future codes. */
  readonly code: string;
  readonly recoverability: ConversationErrorRecoverability;
  /** Sanitized fallback text intended for display, not a raw exception dump. */
  readonly message?: string;
  readonly operationId?: string;
  readonly transitionId?: string;
  readonly internalSessionId?: string;
  /** Allow-listed provider detail, retained only at raw capture. */
  readonly details?: ConversationErrorDetails;
}
```

`code` is a non-blank string rather than a closed TypeScript union. The library exports
constants for codes it owns, while readers must tolerate unknown future values. Initial
library codes are:

- `provider_session_create_failed`
- `provider_session_load_failed`
- `provider_session_missing`
- `provider_process_exited`
- `connection_lost`
- `prompt_interrupted`
- `recovery_failed`
- `unknown`

The initial sources and codes are deliberately small. Classification must prefer
`unknown` over guessing from an ambiguous provider error.

## Meaning of recoverability

- `retryable`: repeating the same action may reasonably succeed without a different
  recovery strategy.
- `recoverable`: the same action is not sufficient, but another supported action such as
  checkpoint recovery or starting a fresh provider session may continue the logical
  conversation.
- `terminal`: the library knows of no supported continuation for this failure.
- `unknown`: available evidence is insufficient to select one of the above.

Recoverability describes the failed operation, not a promise that recovery will succeed.

## Capture policy

`error` participates in `ConversationRecordCaptureConfig` and defaults to `"content"`.

- `none`: append no canonical error row.
- `metadata`: retain the envelope, `source`, `code`, `recoverability`, and relationship
  identifiers. Omit `message` and `details`.
- `content`: retain metadata plus the sanitized display `message`. Omit `details`.
- `raw`: retain content plus sanitized, bounded `details` when available.

The ordinary message must not contain stack traces, credentials, prompts, environment
variables, filesystem content, raw request bodies, or arbitrary provider payloads. Raw
capture is not permission to persist secrets. `details` is built only from the allow-listed
fields in `ConversationErrorDetails`; unknown provider fields are discarded rather than
recursively copied or heuristically redacted. Strings remain subject to the ordinary
persistence bounds. Unmodified protocol frames belong to the existing optional protocol
capture.

Audit error capture defaults to `"content"` and is configurable independently of canonical
capture. `capture.error = "none"` on the conversation database must not suppress an audit
observation selected by the audit policy, and disabling audit error capture must not
suppress the canonical row.

This independence is a policy property, not a second durability boundary. The canonical
append and audit-outbox enqueue selected for one observation occur in the existing SQLite
transaction: both commit or both roll back. When canonical capture is `none`, an audit-only
observation may still commit. The audit destination is delivered later from the outbox.

## SQLite representation

Add `conversation_error_records`:

```sql
CREATE TABLE conversation_error_records (
  record_row_id INTEGER PRIMARY KEY
    REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN (
    'provider_session', 'transport', 'operation', 'recovery'
  )),
  code TEXT NOT NULL CHECK (length(trim(code)) > 0),
  recoverability TEXT NOT NULL CHECK (recoverability IN (
    'retryable', 'recoverable', 'terminal', 'unknown'
  )),
  message TEXT,
  transition_id TEXT,
  internal_session_id TEXT,
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json))
);
```

`operationId` is authoritative as a first-class `ErrorRecord` field. It is stored in the
existing `conversation_records.operation_id` column, hydrated directly from that column,
and used directly by audit projection. It is not redundantly encoded into legacy
`metadata`. Add indexes supporting
conversation-local filtering by `(source, code, record_row_id)` where measurement shows
the general conversation/kind/sequence index is insufficient. Do not create an FTS5
table for errors in v1.

The target SQLite agent schema version is 12. Schema version 11 has already been emitted
by the current development implementation, so changing its meaning in place would leave
development and smoke-test databases silently incomplete. Migrate supported versions
8 through 11 transactionally and preserve all existing rows.

## Sequence, recency, identity, and retention

- An error receives the next ordinary conversation sequence at the time it is appended.
- It updates `conversations.updated_at`, so a newly failed conversation may move in a
  recent-conversation list.
- It does not update `last_human_message_at` and does not replace `latestMessage` in
  conversation previews.
- Error records do not automatically enter checkpoint-backed identity context, recovery
  summaries, or AI prompts. They are operational history for the consumer. A future
  identity policy may explicitly select particular codes.
- Error records follow conversation deletion and any future general conversation-record
  retention policy. There is currently no separate automatic error-retention subsystem.
- Each error is an independent timeline item. Reconciliation does not fold unrelated
  errors merely because they share a code.

## Attempt identity and idempotency

Every invocation of a boundary that may emit an error has a stable attempt, operation, or
transition ID allocated before provider dispatch. A provider-load invocation, for example,
mints `provider-load-{uuid}`. The error record ID derives deterministically from that full
ID:

```text
${attemptId}:error
```

All writes made by the same in-memory invocation reuse its attempt ID, and re-appending its
same error record is idempotent. An explicit later invocation is a new attempt and receives
a new error record if it fails. This does not introduce a durable attempt coordinator or
promise to resume attempt identity across a process crash. Errors are immutable: a later
successful retry or recovery references the original attempt where possible but does not
overwrite or mark the historical error as resolved.

## Provider-session load behavior

For `Agent.conversations.open()` with a stored provider mapping:

1. Mint the provider-load attempt ID.
2. Call `session/load` through the selected adapter.
3. On success, return the current `loaded` outcome. No error record is written.
4. On failure, classify the error conservatively.
5. Project the observation through the independently configured canonical and audit
   policies, then commit the selected canonical row and/or audit-outbox item in one
   transaction before beginning automatic recovery or rejecting `open()`.
6. If configured checkpoint recovery applies, continue the existing recovery flow. The
   error remains in the timeline before the recovery action records.
7. Otherwise throw a structured `ProviderSessionError`.

Example canonical record:

```ts
{
  kind: "error",
  recordId: `${attemptId}:error`,
  agentSessionId,
  agentConversationId,
  timestamp,
  source: "provider_session",
  code: "provider_session_missing",
  recoverability: "recoverable",
  message: "The provider session could not be loaded.",
  transitionId: attemptId,
  internalSessionId,
}
```

The failed provider mapping remains evidence and is not silently deleted or replaced by
the error writer. Recovery or an explicit future fresh-session operation is responsible
for superseding it. No uncertain user prompt is automatically replayed.

If recovery is enabled but no usable checkpoint exists, the load error is still recorded
and the structured load error is thrown. Recovery progress callbacks remain ephemeral
progress signals; they are not substitutes for the error record.

## Other persistence boundaries

Persist errors only where a failure has conversation-level operational meaning:

- provider session creation or loading;
- unexpected provider-process or transport loss;
- a prompt interrupted after provider dispatch when no more specific root cause was
  recorded;
- recovery failure that prevents the logical conversation from reopening or continuing.

Do not persist ordinary argument validation, unknown conversation IDs, rejected capture
configuration, or other failures detected before an operation begins.

Failed native actions, configuration records, tool calls, and similar lifecycle records do
not automatically create error records. The lifecycle record describes which operation
failed; an error record describes a distinct operational cause. They correlate through the
same `operationId` or `transitionId` when both are present.

Avoid duplicate root-cause errors. If transport loss interrupts an active prompt, handoff,
switch, or configuration operation, record the transport/process failure once and let the
operation's normal failed lifecycle state refer to the same operation or transition. Do
not also append `prompt_interrupted` or an action-specific error for that root cause.
Recovery is a distinct operation and may emit one `recovery_failed` record if recovery
itself encounters a new root cause.

An unexpected process or transport loss while no operation is active is still meaningful.
The conversation owning that provider attachment records it once and emits the existing
live lifecycle/error notification. When an operation is active, the attachment failure and
the rejected operation must converge on the same root-cause error rather than recording it
twice.

## Structured API error

When the operation cannot return a live conversation, throw a public structured error:

```ts
class ProviderSessionError extends Error {
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId: AgentConversationId;
  readonly attemptId: string;
  readonly internalSessionId?: string;
  readonly code: string;
  readonly source: ConversationErrorSource;
  readonly recoverability: ConversationErrorRecoverability;
  readonly recordId?: string;
  readonly recordingError?: Error;
  readonly cause?: unknown;
}
```

The immediate exception and durable record use the same code, attempt ID, and
recoverability. `recordId` is present only when canonical capture accepted the record.
The provider error remains the primary cause. If error persistence also fails, report it
through `recordingError` and the logger rather than replacing the provider diagnosis.

`agentConversationId` is mandatory even when `conversations.create()` generated it and
harness activation then failed. This prevents an orphaned durable conversation from
becoming undiscoverable to the caller. When error capture is `none`, the structured
exception still carries the attempt identity and classification.

No live conversation subscription exists when opening fails. The structured exception is
the immediate control-flow result, while an Agent consumer already subscribed through
`agent.events` receives the committed canonical error record before `open()` rejects.
Querying canonical records remains the restart/reload contract. Failures on an already live
conversation continue to reject their operation and emit the existing lifecycle event in
addition to any committed record delivered through the Agent bus. A separate
provider-attachment state/event may be added with the provider-session lifecycle work; it
is not implied by the existence of an error row.

## Consumer presentation

Errors are system timeline items, not assistant or user messages. A consumer may render:

```text
Provider session failed to load
The conversation history is still available locally.
```

The error code and recoverability can drive actions such as retry load, checkpoint
recovery, a fresh provider session for the same logical conversation, or creation of a
different conversation. This specification does not make those actions automatic.

`latestMessage` remains message-specific. A consumer that needs an error badge reads the
recent record page and filters `kind: "error"`. A batched preview error status may be
added later if profiling shows that record reads are insufficient.

## Failure to record a failure

SQLite cannot durably describe its own unavailability. Canonical insertion and selected
audit-outbox enqueue share one transaction. If that transaction fails:

- retain and throw the original structured provider/operation error;
- attach the persistence failure as `recordingError`;
- report it through the logger;
- do not attempt a second outbox write to describe the failed transaction;
- do not claim that a canonical error record exists.

This is an accepted limitation rather than a reason to add another mandatory persistence
layer.

## Verification

Required deterministic coverage:

1. SQLite round-trips every error field at raw capture.
2. `metadata`, `content`, `raw`, and `none` project exactly the specified fields.
3. Canonical and audit capture selection remain independent, including canonical `none`
   with audit enabled and the inverse; selected canonical/outbox writes remain atomic.
4. Schema versions 8, 9, 10, and 11 migrate to version 12 without losing records.
5. A failed `session/load` writes an ordered error before throwing.
6. Automatic checkpoint recovery leaves the load error before recovery action records.
7. Missing checkpoints still leave the load error and return the structured exception.
8. Re-appending an error within one invocation is idempotent; an explicit later invocation
   receives a new attempt ID.
9. A failed generated-ID conversation creation exposes its `agentConversationId` in the
   structured exception.
10. `capture.error = "none"` writes no canonical row but preserves the structured error.
11. An error advances conversation sequence and recency without changing
    `lastHumanMessageAt` or `latestMessage`.
12. Error records are excluded from checkpoint-backed identity delivery.
13. An error-record transaction failure does not replace the primary provider error.
14. Error messages and non-raw records contain no raw ACP body or stack trace.
15. A failed native action does not automatically produce a duplicate error; a distinct
    provider or transport root cause is correlated through its operation or transition ID.
16. Idle provider-process loss is recorded once by the owning conversation.
17. A committed error is published once through `agent.events` before the originating API
    rejects; canonical capture `none` publishes no committed-record event.

## Accepted limitations

- A successful `session/new`, prompt, or `session/load` is only an observation; it is not
  a promise that a provider session will remain available later.
- Provider error classification is limited by the machine-readable information exposed
  by each harness. Ambiguous errors remain `unknown`.
- The initial `source` taxonomy is deliberately closed; adding a new source category
  requires a schema migration, while adding a new code within an existing source does not.
- Errors that occur before an agent conversation exists cannot be conversation records.
- Errors cannot be stored in a database that is itself closed, corrupt, or unavailable.
- Existing history cannot reconstruct failures that were never previously recorded.
