# Agent audit log delivery and rotation specification

Status: proposed. Required before publishing the first stable SQLite-backed `Agent`
release.

## 1. Purpose

SQLite is the canonical online persistence store for an `Agent`, but canonical storage
and audit delivery have different responsibilities. Canonical records reconstruct chats,
restore runtime state, support search, and retain provider history. An audit log is an
independently filtered operational stream delivered to a caller-selected destination.

This specification defines the first agent-wide audit runtime:

- audit projection independent from canonical conversation capture;
- transactional SQLite outbox creation;
- asynchronous, resumable delivery;
- rotated JSONL segments at a caller-selected location;
- stable ordering across all conversations owned by one agent;
- observable failures and explicit drain controls; and
- bounded duplication without silent loss after crashes.

The existing per-session JSONL audit implementation remains a compatibility system. The
new format is version 2 and is not disguised as another generation of the legacy format.

## 2. Goals

The initial runtime must:

1. keep external filesystem I/O outside SQLite transactions and prompt latency;
2. commit canonical state and corresponding audit intent atomically;
3. preserve audit intent while a destination is unavailable or not configured;
4. allow one agent to deliver differently filtered streams to multiple destinations;
5. preserve a monotonic logical agent-wide order within each destination;
6. rotate without splitting or corrupting a JSONL record;
7. recover from process termination during append, sync, rotation, or acknowledgement;
8. expose backlog, failure, delivery, and rotation progress programmatically;
9. avoid retaining a second permanent copy of full delivered payloads in SQLite; and
10. retain the consumer's authority over paths, capture, retention, and deployment.

## 3. Non-goals

The first implementation does not provide:

- cryptographic authenticity, signatures, or tamper-proof storage;
- encryption at rest;
- automatic upload to an external compliance service;
- exactly-once delivery across SQLite and a filesystem;
- compression of sealed segments;
- automatic deletion of sealed audit files;
- a synchronous mode capable of undoing an already executed model or tool operation;
- audit import into canonical conversation history; or
- compatibility between the version-2 agent-wide reader and legacy version-1 files.

External immutable sinks, compression, retention policies, signing, and encryption may be
added behind the same destination abstraction later.

## 4. Terminology

- **Canonical state**: typed SQLite conversation records and the other tables required to
  restore an agent.
- **Audit observation**: a normalized domain observation offered independently to each
  configured audit destination.
- **Audit event**: one immutable projected payload produced for an observation and capture
  fingerprint. Destinations with the same fingerprint may share it.
- **Audit delivery**: durable SQLite outbox and receipt state connecting one audit event
  to one destination.
- **Audit entry**: the physical version-2 JSONL envelope written for one delivery.
- **Destination**: a stable logical audit receiver selected by a consumer-defined ID.
- **Sink**: the implementation that physically delivers entries for a destination.
- **Segment**: one JSONL file in a rotating destination stream.
- **Receipt**: compact SQLite event/delivery state retained after an audit payload is
  delivered.
- **Audit sequence**: a monotonically increasing logical integer scoped to one destination
  and one agent database. It orders accepted entries from all conversations of that agent;
  an at-least-once physical retry may repeat the same integer for the same delivery.

`agentSessionId` remains the stable `ags-...` agent identity. An audit entry may also
carry an `agentConversationId`, but agent-level observations need not belong to an
`agc-...` conversation.

## 5. Core invariants

1. SQLite remains authoritative for agent state. Audit delivery never becomes the source
   used to restore a conversation.
2. Audit capture and canonical capture are independent. Either may retain an observation
   that the other omits.
3. If an observation changes canonical state and is accepted by an audit policy, the
   canonical mutation and outbox enqueue commit in the same SQLite transaction.
4. No SQLite transaction remains open while writing, syncing, rotating, reading, or
   locking external files.
5. Prompt completion does not wait for external audit delivery.
6. Audit event payloads and pending deliveries are immutable. Later policy changes do not
   rewrite them.
7. Each destination is delivered strictly in `auditSequence` order. A failed head entry
   blocks later entries for that destination but never blocks another destination.
8. An external append is acknowledged in SQLite only after the written bytes are synced.
9. A crash may cause a duplicate entry, but it must not cause a silently lost entry.
10. Every physical entry contains a stable `outboxId`, allowing consumers and readers to
    deduplicate retries.
11. Rotation never changes audit, conversation, or canonical record sequence numbers.
12. Missing destination configuration leaves work pending. It never reroutes, drops, or
    marks entries delivered.
13. Audit-delivery observations do not recursively create audit entries.
14. An audit sink cannot make an agent database depend on a home-directory path. All
    destination locations are caller-selected.
15. One normalized observation is produced per domain occurrence. Audit destinations do
    not independently normalize or deep-clone the original provider payload.
16. Projection, serialization, and hashing occur once per unique capture fingerprint for
    an observation, not once per destination when policies are identical.
17. Physical delivery may repeat one sequence only for the same outbox ID and payload
    digest. The deduplicated logical stream is strictly increasing.
18. Reprocessing one stable source observation under the same capture-policy revision is
    idempotent: it resolves to the same event/delivery identities and consumes no new
    audit sequence.

## 6. Public configuration

`AgentConfig` gains an optional `auditLog` member:

```ts
interface AgentConfig {
  // existing members
  readonly auditLog?: false | AgentAuditLogConfig;
}

interface AgentAuditLogConfig {
  readonly destinations: readonly AgentAuditDestinationConfig[];
  readonly shutdownGraceMs?: number;
  readonly receiptRetention?: "all" | "none" | { readonly retain: number };
}

interface AgentAuditDestinationConfig {
  /** Stable across process and path changes. */
  readonly id: string;
  readonly sink: JsonlAuditSinkConfig;
  readonly capture?: AgentAuditCaptureConfig;
  readonly rotation?: AuditRotationConfig;
  readonly retry?: AuditRetryConfig;
}

interface JsonlAuditSinkConfig {
  readonly kind: "jsonl";
  readonly directory: string;
  readonly filePrefix?: string;
}

interface AuditRotationConfig {
  readonly maxBytes?: number | false;
  readonly maxAgeMs?: number | false;
}

interface AuditRetryConfig {
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}
```

`auditLog` capture and delivery are disabled when absent or `false`. An enabled
configuration must contain at least one destination. Destination IDs must be unique,
non-empty, at most 128 UTF-8 bytes,
and restricted to letters, digits, `.`, `_`, and `-` so they are safe in diagnostics and
manifest identities.

Disabling a previously used audit runtime never erases its pending work. The agent opens a
lightweight suspended audit-maintenance facade when persisted destination state exists, so
status can report pending/unconfigured work; it starts no delivery worker and captures no
new observations until configuration is supplied again. A database that has never enabled
audit pays no audit-state lookup beyond the persistence-open metadata needed to establish
that fact.

The first implementation supports multiple destinations. This matches the existing
outbox's destination identity and avoids baking a single local file into the agent model.

The resolved `(directory, filePrefix)` namespace must be unique among destinations in one
agent configuration. `filePrefix` is immutable for a destination stream; changing it
requires a new destination ID. Two different agent databases may not concurrently own the
same resolved namespace.

Relative directories resolve once against the process working directory during
`Agent.open()`. The resolved location is exposed by runtime inspection. The database does
not invent a default directory.

### 6.1 Defaults

The JSONL sink defaults are:

```ts
rotation: {
  maxBytes: 64 * 1024 * 1024,
  maxAgeMs: 24 * 60 * 60 * 1000,
}

retry: {
  initialDelayMs: 1_000,
  maxDelayMs: 5 * 60 * 1_000,
}

shutdownGraceMs: 2_000

receiptRetention: { retain: 100_000 }
```

Either rotation trigger may be disabled explicitly with `false`; omission selects its
default. Resolved configuration always has at least one active trigger. `maxBytes`
includes the segment header and newline delimiters. `maxAgeMs` is measured from segment
creation, but an idle destination does not create or rotate empty files.

Retry delay grows exponentially and is capped by `maxDelayMs`. A small randomized jitter
prevents several processes from retrying at one instant. Tests inject deterministic time
and jitter.

Receipt retention is agent-wide and applies only after durable external delivery; it does
not delete audit segments or pending work. `none` removes compact receipts immediately,
`all` keeps them indefinitely, and `{ retain }` keeps the newest completed delivery
receipts per destination. Shared event receipts are removed only when no pending or
retained delivery references remain. Destination high-water state survives receipt
pruning.

## 7. Audit capture

`AgentAuditCaptureConfig` uses the typed conversation vocabulary but remains audit-specific.
It preserves useful legacy distinctions such as tool input without output, permission
decision without request content, and selected configuration without full definitions:

```ts
interface AgentAuditCaptureConfig {
  readonly message?: RecordCaptureLevel;
  readonly tool_call?: "none" | "metadata" | "input" | "content" | "raw";
  readonly permission?: "none" | "metadata" | "decision" | "content" | "raw";
  readonly configuration?:
    | "none" | "metadata" | "selections" | "definitions" | "content" | "raw";
  readonly protocol?: ProtocolRecordCapture;
  readonly native_action?: RecordCaptureLevel;
  readonly agent_action?: RecordCaptureLevel;
  readonly thinking?: RecordCaptureLevel;
  readonly activity?: RecordCaptureLevel;
  readonly metering?: "none" | "metadata" | "summary" | "raw";
  readonly agent_lifecycle?: RecordCaptureLevel;
  readonly identity?: RecordCaptureLevel;
  readonly internal_inference?: RecordCaptureLevel;
  readonly audit_administration?: RecordCaptureLevel;
}
```

The initial default is deliberately operational rather than conversational:

```ts
const DEFAULT_AGENT_AUDIT_CAPTURE = {
  message: "none",
  tool_call: "metadata",
  permission: "decision",
  configuration: "selections",
  protocol: "none",
  native_action: "content",
  agent_action: "content",
  thinking: "none",
  activity: "metadata",
  metering: "summary",
  agent_lifecycle: "metadata",
  identity: "metadata",
  internal_inference: "metadata",
  audit_administration: "metadata",
};
```

The levels mean:

- `none`: do not create an outbox item;
- `metadata`: keep identity, state, correlation, timing, and structural metadata but omit
  potentially sensitive content;
- `content`: keep the normalized domain content appropriate to the record kind; and
- `raw`: keep the complete supported domain payload after structural validation and
  configured size limits.

The specialized levels mean:

- tool `input`: keep tool identity and normalized input but omit output;
- permission `decision`: keep permission identity, options, selected outcome, and timing
  but omit content not needed to explain the decision;
- configuration `selections`: keep effective selections but omit announced definitions;
- configuration `definitions`: keep selections and announced definitions;
- metering `summary`: keep normalized token categories, measurement status, provider/model
  identity, and rated/provider cost summaries; and
- metering `raw`: keep the complete validated `OperationMeteringRecord`, subject to limits.

For kinds without a specialized vocabulary, `RecordCaptureLevel` retains its canonical
meaning. `metadata` is structural minimization, not a guarantee that consumer-supplied
metadata is non-sensitive.

Protocol capture retains its existing `none | metadata | raw` levels and exact method
filters. Raw protocol capture is never enabled by default.

Capture projection occurs from the normalized observation before canonical capture
removes fields. Consequently, an audit destination may retain tool details even when the
canonical conversation policy stores only metadata. The projected audit payload itself
is stored in SQLite until delivery and therefore remains subject to the consumer's data
classification and database-access policy.

Capture is configured per destination. One destination may retain only permission and
configuration decisions while another keeps a more detailed diagnostic stream. Agent-level
capture keys apply to observations that have no conversation ID; they are not fabricated
conversation records.

The capture fingerprint is a canonical hash of every projection-affecting input: resolved
capture policy, protocol filters, projection schema version, and truncation/size policy.
The destination policy revision increments only when that resolved projection contract
changes; reopening with an equivalent configuration preserves the revision. Two
destinations share an event payload only when this fingerprint is identical.

## 8. Auditable observations

The first implementation accepts all current typed conversation record kinds:

- messages;
- tool-call lifecycle events;
- permission requests and resolutions;
- configuration announcements and selections;
- protocol records;
- conversation-native actions such as handoff, switch, reset, and recovery;
- future agent-initiated actions;
- thinking blocks;
- model activity; and
- metering references and their permitted projected summary.

It also accepts agent-level lifecycle observations needed to interpret the stream:

- agent audit runtime opened and closed;
- destination configuration became available or unavailable;
- identity snapshot publication;
- internal-inference lifecycle when its purpose is auditable; and
- explicit consumer-invoked audit configuration, retry, and flush requests, plus future
  abandonment operations.

Agent-level kinds use a separate discriminated union rather than fabricating a
conversation ID. The initial implementation may deliver conversation observations first,
but the envelope and schema must not require every entry to belong to a conversation.

Sink delivery attempts, retry timers, leases, and segment housekeeping remain runtime
telemetry and receipts. They do not recursively enter the audit stream.

### 8.1 Normalized observation boundary

Independent audit capture requires one ephemeral boundary before canonical capture:

```text
controller/runtime occurrence
  -> immutable normalized domain observation
       -> canonical projection and persistence
       -> zero or more audit projections and deliveries
       -> identity update from committed canonical records
```

`NormalizedAgentObservation` is a discriminated union of conversation and agent-level
observations. It is not a public event log, database table, background queue, or second
copy of provider traffic. It owns or references the already-normalized values needed by
projectors. Large content is not deep-cloned merely because more than one projector may
inspect it.

The current canonical pipeline applies capture while constructing records. Implementation
must move that decision after normalization so audit can independently accept an
observation that canonical capture rejects. This refactor must not silently broaden
identity input: identity continues to receive committed canonical records unless the
identity contract is separately changed.

When audit is disabled, the compiled audit plan is absent and the observation takes the
canonical path without audit projection, serialization, hashing, allocation, or worker
startup. When enabled, policies are compiled during `Agent.open()` and observations are
projected lazily only for unique accepting capture fingerprints.

This boundary is internal. It does not replace `AgentConversation` notifications or the
canonical `ConversationRecord` API.

## 9. Projection and transactional enqueue

For each normalized observation:

1. evaluate the compiled policy for every configured destination;
2. group accepting destinations by capture fingerprint;
3. project, serialize, and hash one immutable audit event per unique fingerprint;
4. allocate the next destination-scoped `auditSequence` and stable outbox ID for every
   accepted destination;
5. create delivery rows referencing the shared projected events;
6. commit the canonical mutation, projected events, destination sequence advancement, and
   all corresponding deliveries in one SQLite transaction; and
7. notify the background delivery runtime only after commit.

Every observation has a stable `sourceObservationId` minted before its durable operation.
For canonical records this normally derives from the canonical record ID; agent-level
operations persist or derive an equally stable operation/event ID. Event and outbox
idempotency keys derive from source observation, capture fingerprint/revision, and
destination. Repeating an ambiguously completed transaction therefore finds the same rows
and verifies the same payload digest instead of allocating a second sequence. Same-key
different-payload reuse is a persistence conflict.

Once an event/delivery linkage has committed, replaying that source observation resolves
the persisted linkage rather than reevaluating it under a newer policy. A rejected
observation creates no audit state and is not later replayed as a backfill. Historical
backfill, if introduced, is a distinct explicit operation with its own source identity.

If canonical capture rejects the observation but audit accepts it, steps 3–6 still commit
audit events and deliveries. If audit rejects it, no audit sequence is consumed for that
destination.
Each destination therefore has a contiguous logical sequence for the entries it accepted.

Several destinations with the same capture fingerprint share one event payload and digest
but retain independent outbox IDs, sequences, retry state, and receipts. Different
fingerprints produce different projected events. Event payloads are removed only after
every referencing delivery is durably acknowledged.

An outbox enqueue failure aborts the SQLite transaction. If the provider already
performed an external action, the library cannot undo it; the operation surfaces a
persistence failure and must not falsely report that all durable bookkeeping succeeded.
This is the same unavoidable boundary as other post-provider canonical persistence.

Persistence extension `recordsCommitted` hooks are not sufficient for audit creation
because they run after a canonical commit and cannot provide atomicity. The SQLite write
path needs a transaction-aware audit projector/enqueue participant.

## 10. Version-2 audit envelope

Every delivered entry uses an envelope independent of its projected payload:

```ts
interface AgentAuditEntryV2 {
  readonly v: 2;
  readonly t: "audit";
  readonly eventId: string;
  readonly outboxId: string;
  readonly destinationId: string;
  readonly auditSequence: number;
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId?: AgentConversationId;
  readonly sourceRecordId?: string;
  readonly sourceSequence?: number;
  readonly operationId?: string;
  readonly timestamp: string;
  readonly kind: string;
  readonly captureLevel:
    | "metadata" | "input" | "decision" | "selections" | "definitions"
    | "content" | "summary" | "raw";
  readonly capturePolicyRevision: number;
  readonly captureFingerprint: string;
  readonly payloadSha256: string;
  readonly payload: PersistenceJsonValue;
}
```

`outboxId` identifies one delivery to one destination. The same observation delivered to
two destinations has two outbox IDs and may have different payloads. Destinations with an
identical capture fingerprint may reference the same event ID, payload, and digest.
`sourceRecordId` and `sourceSequence` are present when a canonical record exists; their
absence for an audit-only or agent-level observation is valid.

Timestamps are ISO-8601 UTC strings in the new format. Readers must not use timestamps to
establish order; `auditSequence` is authoritative within a destination.

## 11. SQLite schema and migration

This feature changes the pre-release SQLite schema from version 7 to version 8. Version 8
is intended to be the first published durable SQLite schema.

The schema must represent:

### 11.1 Destination state

- destination ID;
- stable stream ID once the destination is first materialized;
- last allocated audit sequence;
- last completed sequence;
- current retry/error summary;
- resolved delivery-configuration fingerprint and revision;
- capture fingerprint and capture-policy revision;
- update timestamps; and
- optional worker lease/fencing state.

The resolved filesystem directory is consumer configuration and is not authoritative
database identity. A container may mount the same destination at a different path while
retaining its destination ID.

### 11.2 Projected audit events

One event row contains:

- event ID;
- normalized source identity and kind;
- stable source-observation ID and idempotency key;
- capture level and capture fingerprint;
- immutable projected payload and SHA-256 digest;
- creation time; and
- the number/state of referencing deliveries.

The payload is serialized and hashed once. Destinations share the row only when their
capture fingerprints and resulting projection are identical. The payload remains until
all referencing deliveries are acknowledged, after which the event becomes a compact
source/digest receipt.

### 11.3 Outbox deliveries and receipts

Each delivery row contains:

- outbox ID;
- referenced event ID;
- destination ID and audit sequence, unique together;
- destination capture-policy revision;
- stable delivery idempotency key, unique per destination/source/policy revision;
- creation time;
- retry count, next-attempt time, and last error;
- lease owner, fencing token, and lease expiry while claimed;
- delivered time;
- segment generation and segment record sequence;
- optional byte offset/length for diagnostics; and
- delivery receipt state.

After durable delivery, the delivery row becomes a compact receipt. The event/digest,
source identity, destination sequence, segment location, and delivery time remain. Once
every delivery referencing an event is complete, its full payload is removed. The first
release applies the configured bounded receipt policy transactionally after delivery.
Pruning receipts never deletes external audit evidence or changes destination high-water
state.

The current `audit_outbox` table is development-only and may be migrated or replaced as
part of schema version 8 before publication.

### 11.4 Backend contract

The current four-method `AuditOutboxPersistence` CRUD surface is insufficient. The v2
contract must expose transaction-scoped batch enqueue/sequence allocation, destination
state, ordered claiming with leases/fencing, retry transitions, and atomic delivery
receipt compaction. These operations remain backend-domain methods rather than public SQL.

`PersistenceCapabilities.auditOutbox: boolean` is replaced or supplemented by a
structured audit capability that explicitly advertises transactional enqueue, leasing,
and receipts. A custom backend is eligible only when those guarantees participate in its
`PersistenceBackend.transaction()` boundary. Merely storing arbitrary outbox rows is not
enough.

## 12. Delivery worker

`Agent.open()` starts one audit coordinator when audit is enabled. It discovers pending
destinations and schedules delivery without delaying conversation startup.

Delivery is serialized per destination and may run concurrently across destinations.
For a destination, the worker:

1. finds the lowest undelivered audit sequence;
2. atomically acquires or renews its SQLite lease with a fencing token;
3. validates destination configuration and filesystem identity;
4. opens or recovers the active segment;
5. appends one or more contiguous entries;
6. syncs the file bytes;
7. transactionally marks those deliveries complete, creates their receipts, and compacts
   any shared event whose deliveries are now all complete; and
8. continues with the next contiguous batch.

Rows are never acknowledged before the sync in step 6. A crash between steps 6 and 7 may
cause the same stable outbox ID to be appended again. This is the accepted at-least-once
boundary.

### 12.1 Cross-process ownership

SQLite leases fence multiple processes using the same agent database. A lease has a
bounded expiry and monotonically increasing fencing token. An expired worker may not mark
delivery after another worker acquires a newer token.

A destination namespace also contains a filesystem lock and manifest identity. The
namespace is `(resolved directory, filePrefix)`, not the whole directory, so intentionally
different prefixes may coexist. It prevents two different agent databases from writing
the same stream concurrently. The identity binds a stable random `streamId` to agent ID,
destination ID, prefix, and format version. An identity mismatch fails closed and leaves
outbox rows pending.

### 12.2 Retry behavior

Retryable I/O failures increment `attemptCount`, store a bounded diagnostic string, and
schedule exponential backoff. Configuration absence and identity mismatch are blocked
states rather than hot retries. Authentication-style failures for future remote sinks may
define their own retry classification.

A failed destination never stalls prompts or another destination. It remains visible
through status and subscriptions until repaired, retried, or explicitly handled by a
future abandonment API.

## 13. JSONL destination layout

A destination directory contains:

```text
<prefix>.manifest.json
<prefix>.lock
<prefix>.000001.jsonl
<prefix>.000002.jsonl
...
```

`filePrefix` defaults to `audit`. A prefix is a filename component, not a path. Generation
numbers have a minimum six-digit padding for lexical order but are not capped at 999999;
readers use the numeric manifest value.

Each segment starts with exactly one header:

```ts
interface AgentAuditSegmentHeaderV2 {
  readonly v: 2;
  readonly t: "header";
  readonly streamId: string;
  readonly agentSessionId: AgentSessionId;
  readonly destinationId: string;
  readonly generation: number;
  readonly createdAt: string;
  readonly firstAuditSequence: number;
  readonly capturePolicyRevision: number;
  readonly captureFingerprint: string;
}
```

The manifest records destination identity, active generation, and sealed segment metadata
including first/last audit sequence, byte length, creation/seal times, and SHA-256 digest.
The digest detects accidental corruption but is not proof against an attacker who can
rewrite both segment and manifest.

Manifest replacement uses write-temporary, sync, atomic rename, and parent-directory sync
where supported. A reader can reconstruct segment ordering from validated headers if the
manifest is missing or interrupted; reconstruction is explicit and reported, not silent.

Files created by the library use owner-only permissions where supported. Existing
directory permissions are never silently changed.

The first segment of a destination creates its stream ID. Once any sequence has been
delivered, an empty directory is not accepted as a transparent relocation: the consumer
must restore the matching manifest/segments or configure a new destination ID. A future
explicit audit-epoch operation may acknowledge a lost/unavailable prior stream. This
prevents a mount mistake from silently splitting one destination across unrelated files.

## 14. Rotation algorithm

Before appending the next entry, rotate when:

- the active segment has entries and adding the next complete line would exceed
  `maxBytes`; or
- the active segment has entries and its age has reached `maxAgeMs`; or
- the next entry's capture fingerprint or destination policy revision differs from the
  active segment header.

Rotation performs:

1. stop accepting appends for that destination;
2. sync and close the active segment;
3. compute its byte length and SHA-256 digest;
4. atomically record it as sealed in the manifest;
5. allocate the next generation;
6. create, sync, and validate the next segment header;
7. atomically update the active generation; and
8. resume delivery.

A single entry larger than `maxBytes` is written intact to an otherwise empty segment and
that segment is rotated before another entry. Normal configured record limits should make
this exceptional. No entry is split or truncated merely to satisfy rotation.

Time-based rotation is lazy: an idle destination creates no empty daily files. The next
append rotates an expired non-empty segment before writing the entry.

Compression and sealed-file deletion are intentionally outside this algorithm.

## 15. Crash recovery

When opening an existing destination, the writer validates:

- lock/identity ownership;
- manifest structure and destination identity;
- segment header identity and generation;
- non-decreasing physical audit sequences;
- any repeated sequence has the same outbox ID and payload digest;
- complete newline-delimited records; and
- sealed-segment size and digest where present.

An incomplete final line in the active segment is a torn append. Recovery may truncate
only that incomplete suffix after recording a recovery notification. It must never remove
a complete line merely because SQLite has not acknowledged it.

If a complete final entry is present but its outbox row is still pending, the worker may
append it again under the basic at-least-once contract. A later optimization may recognize
the tail's matching outbox ID and acknowledge it without duplication, but correctness
must not depend on that optimization.

The physical stream may therefore contain adjacent duplicates in one segment or across a
rotation boundary. After deduplication by outbox ID, sequences must be strictly increasing
without an unexplained gap. Reusing one sequence for a different outbox ID or digest is
corruption.

Corruption before the active segment's final incomplete line, a sealed digest mismatch,
or an identity mismatch fails closed. The worker exposes the destination as blocked and
does not skip ahead or create an unrelated replacement stream.

## 16. Runtime API and observability

An enabled agent, or an agent with persisted prior audit state, exposes an audit runtime:

```ts
interface AgentAuditRuntime
  extends StatefulSubscribable<AgentAuditSnapshot, AgentAuditNotification> {
  status(destinationId?: string): Promise<AgentAuditStatus>;
  flush(options?: AgentAuditFlushOptions): Promise<AgentAuditFlushResult>;
  retry(destinationId?: string): Promise<void>;
  reconfigure(
    destinationId: string,
    config: AgentAuditDestinationConfig,
    expectedConfigurationRevision: number,
  ): Promise<AgentAuditDestinationStatus>;
}
```

`status()` reports, per destination:

- state: `idle | delivering | backoff | unconfigured | blocked | stopped`;
- pending count and oldest pending timestamp;
- last allocated and delivered sequences;
- configuration and capture-policy revisions/fingerprints;
- attempt count and bounded last error;
- active segment generation and bytes; and
- resolved sink location when currently configured.

Notifications include:

- outbox entries became pending;
- delivery batch started/completed/failed;
- destination entered or left backoff;
- destination is missing configuration;
- lease ownership changed;
- segment rotated or recovered;
- destination became blocked by corruption/identity mismatch; and
- flush completed or timed out.

Notifications are observational. A throwing subscriber is isolated and cannot change
delivery state.

### 16.1 Flush

`flush()` captures the highest allocated sequence for each selected destination when the
call begins. When `audit_administration` capture accepts flush requests, the request is
enqueued first and included in that captured boundary. Delivery batches, automatic retry
timers, and flush completion notifications do not recursively create audit entries. The
call waits only for the captured boundaries, not for observations created later.
It accepts a timeout and returns a structured result for delivered, pending, blocked, and
timed-out destinations. It does not silently wait forever.

### 16.2 Retry

`retry()` clears retry delay for selected retryable destinations and wakes the worker. It
does not bypass identity/corruption blocks and does not fabricate missing configuration.
When accepted by `audit_administration` capture, the consumer retry request is enqueued
before the delay is cleared; the resulting automatic delivery attempt is not audited.

## 17. Agent shutdown

Normal `agent.close()`:

1. stops accepting new canonical work;
2. transactionally enqueues the audit-visible close lifecycle observation;
3. stops claiming new delivery batches;
4. allows an in-progress append/sync/acknowledgement critical section to settle for at
   most `shutdownGraceMs`;
5. fences any unresolved SQLite lease so late continuations cannot acknowledge;
6. closes or releases local filesystem resources when safe; and
7. returns without waiting indefinitely for the complete backlog.

An expired/fenced worker may have appended bytes but may never acknowledge them. The
filesystem lock is the external-write fence: a replacement worker does not append until
the prior lock is released or provably stale. Leases are renewed before a batch, batches
are bounded, and the acknowledgement transaction verifies the fencing token.

Pending rows, including an undelivered close observation, remain durable for the next
open. A consumer that requires a drained local
sink calls `agent.audit.flush({ timeoutMs })` before `agent.close()` and handles the
result explicitly. That pre-close flush does not include the close observation; normal
close makes only the bounded delivery attempt described above.

Process termination at any point relies on the outbox, lease, and segment recovery rules;
shutdown hooks are an optimization, not the correctness boundary.

## 18. Configuration changes

Destination ID is stable identity. Reopening the same ID at a different mounted path is
allowed only when the namespace manifest carries the same stream, agent, destination, and
prefix identity. Pointing an existing ID at an unrelated directory fails closed.

`Agent.open()` installs a new destination or validates an equivalent persisted
configuration. It never silently changes an existing destination policy. Different
capture, rotation, or retry settings produce a configuration conflict and require explicit
`reconfigure()` with the expected persisted revision. A different prefix or sink format
is a stream-identity conflict and requires a new destination ID.

Reconfiguration uses compare-and-swap against a destination configuration revision. It
updates resolved delivery configuration atomically. A separate capture-policy revision
increments only when the projection contract/fingerprint changes; capture changes affect
only new audit observations, while rotation/retry changes affect subsequent delivery work.
Pending payloads retain the projection created under their original policy. A capture
fingerprint on each shared event, plus the destination policy revision and fingerprint in
each delivery entry/segment, makes the boundary visible. The writer rotates before the
first entry with a new revision or fingerprint, including when old-policy and new-policy
entries were both queued before delivery.

Every transactional enqueue supplies the capture-policy revision it projected against. A
stale process observing a capture revision conflict stops accepting new operations that
would require that audit destination and reports a configuration conflict; it may not
silently omit or enqueue under the retired policy. A delivery worker supplies the broader
configuration revision when claiming a lease and stops when that revision is stale.
Consumers using one agent database from several processes must coordinate reconfiguration
and reopen/reconfigure stale processes.

Changing capture or rotation policy is allowed under one destination ID. Changing
`filePrefix`, format version, agent identity, or stream ID is not an ordinary policy
change and requires a new destination or a future explicit reconfiguration operation.

If a destination is absent on reopen:

- its pending rows remain unchanged;
- it is reported as `unconfigured`;
- no attempt count is consumed; and
- configuring the same destination ID later resumes delivery.

Enabling a new destination captures only observations committed after that destination is
installed. It does not backfill historical canonical records. Historical export/backfill
would be a separate explicit operation because canonical capture may not contain the data
an audit policy would have selected at occurrence time.

Removing or abandoning pending audit work requires a future explicit destructive API with
an acknowledgement of the audit gap. Merely omitting configuration is never abandonment.

## 19. Reader

A new agent-wide reader opens one destination directory as a logical ordered stream:

```ts
const reader = await AgentAuditLogReader.open({
  directory: "/audit/atlas",
});

const page = await reader.readPage({
  limit: 100,
  afterSequence: 500,
  deduplicate: true,
});
```

The reader:

- validates directory, manifest, headers, generations, and line envelopes;
- paginates across segment boundaries;
- orders by audit sequence, never filename timestamp;
- can return the physical at-least-once stream for forensic use;
- can deduplicate stable outbox IDs for a logical projection;
- reports gaps, duplicates, torn tails, and corrupt sealed segments explicitly; and
- never mutates or repairs files unless a separate recovery API is invoked.

Physical pagination cursors encode stream ID, segment generation, and byte/record
position; `auditSequence` alone cannot identify a physical position because a retry may
repeat it. Logical deduplicated cursors additionally bind the last outbox ID and logical
sequence. Cursors are snapshot-bound so later rotation or appends do not silently change
the page traversal they represent.

Legacy `AuditLogReader` remains responsible for version-1 per-session files.

## 20. Failure semantics

There are three distinct failures:

1. **Projection/enqueue failure**: the SQLite transaction fails. The owning operation
   reports persistence failure because durable audit intent was not committed.
2. **Delivery failure**: canonical work and outbox intent remain committed. Normal agent
   work continues; the destination enters retry/backoff or blocked state.
3. **Flush failure/timeout**: the explicit caller request returns a structured incomplete
   result. It does not erase pending work.

The first release supports only durable asynchronous delivery. A future `required`
delivery mode may delay reporting successful finalization until a sink acknowledgement,
but documentation must state that it still cannot undo an already executed provider or
tool side effect.

## 21. Performance requirements

The normalized observation boundary is a logical split, not a second durable stream. The
implementation must satisfy:

- audit capture/delivery disabled performs no per-observation audit projection,
  serialization, hashing, allocation, background scheduling, or outbox queries; a database
  with prior audit state may expose one suspended maintenance snapshot during open;
- kind-level routing may discard an occurrence before materializing expensive content when
  canonical, audit, and identity policies all reject it;
- normalization happens once and large payloads are not deep-cloned per projector;
- destination policies are compiled during open rather than reparsed per observation;
- projection/serialization/hashing happens once per unique accepting capture fingerprint;
- one `audit_events` payload may serve several destination deliveries;
- all event/delivery rows for one occurrence join the canonical transaction rather than
  opening a transaction per destination;
- protocol updates remain excluded by default and filtering occurs before expensive raw
  serialization;
- workers fetch bounded pages and do not mirror a durable backlog in JavaScript memory;
- file appends and syncs are batched within bounded byte/record limits;
- one short SQLite transaction acknowledges a synced batch; and
- delivery workers yield between batches so receipt writes do not starve canonical agent
  writes in SQLite's single-writer path.

Performance cost with one ordinary destination is therefore one compiled-policy decision,
one accepted projection/serialization, and one event plus delivery addition to the
existing SQLite transaction. Cost scales with unique capture projections and accepted
destinations, not merely with the number of configured destinations.

Raw protocol capture is an explicit high-volume mode. The documentation must warn that
streamed `session/update` traffic can dominate database growth and write throughput.

Compact receipt count follows the configured retention policy. `all` remains intentionally
unbounded; the bounded default prevents ordinary delivery history from growing forever.
Status exposes retained receipt count, and database users retain normal SQLite maintenance
responsibility because deleting rows does not itself shrink the database file.

## 22. Security and privacy

- Audit files are plaintext unless the consumer supplies an encrypted filesystem or a
  future encrypted sink.
- Capture defaults omit messages, thinking, and raw protocol traffic.
- Paths, errors, and configuration diagnostics must not include captured payload bodies.
- Error strings persisted in retry state are byte-bounded.
- Payloads pass the same JSON depth, record-size, and captured-field limits used by
  canonical persistence, with explicit truncation metadata where supported.
- Sink configuration and directory permissions remain the consumer's deployment
  responsibility.
- A destination may contain more sensitive data than canonical conversation capture;
  documentation must call this out directly.

## 23. Compatibility and release boundary

- Existing `SessionManager`/legacy JSONL audit behavior is unchanged.
- `AgentConfig.auditLog` is additive.
- Version-1 and version-2 readers are separate and explicit.
- The pre-release version-7 SQLite schema may be upgraded or recreated during development.
- Version 8 becomes the first published durable SQLite schema; later releases require
  forward migrations rather than a recreate instruction.
- Audit disabled creates no new external files or outbox growth; prior pending state is
  retained and exposed through the suspended maintenance facade.
- Custom persistence backends advertise the structured transactional-audit capability.
  Enabling audit on a backend without batch enqueue, destination sequencing, leasing, and
  receipt guarantees fails during `Agent.open()` rather than degrading silently.

## 24. Required tests

### 24.1 Configuration

- rejects duplicate/invalid destination IDs and invalid bounds;
- rejects colliding `(directory, filePrefix)` namespaces;
- resolves caller-selected directories predictably;
- validates `all`, `none`, and bounded receipt retention;
- preserves independent destination capture policies;
- preserves agent-level capture settings and specialized tool/permission/configuration
  projections;
- requires compare-and-swap for policy changes and rejects stale multi-process capture or
  delivery revisions;
- rejects audit enablement on an incapable custom backend; and
- exposes prior pending state as suspended/unconfigured without capturing new observations
  when audit is reopened disabled.

### 24.2 Transactionality and ordering

- canonical mutation and outbox enqueue both commit or both roll back;
- replaying an ambiguously completed source observation reuses event/delivery IDs and does
  not allocate another sequence;
- audit accepts an observation canonical capture omitted;
- identity still receives only committed canonical records;
- concurrent conversations produce one monotonic sequence per destination;
- destinations sharing a fingerprint reuse one event payload while retaining independent
  contiguous sequences and deliveries;
- different fingerprints produce independent projected events; and
- delivery never advances past a failed head item.

### 24.3 Delivery and recovery

- resumes a durable backlog after close/reopen;
- retries with bounded backoff;
- fences competing processes and expired workers;
- tolerates append-before-ack crashes through stable duplicate IDs;
- accepts only same-ID/same-digest physical duplicate sequences and rejects conflicting
  sequence reuse;
- never acknowledges before sync;
- leaves missing destinations pending without burning retries;
- compacts shared payloads only after every referencing delivery completes;
- prunes compact receipts without deleting pending rows or destination high-water state;
- fences acknowledgement after shutdown timeout; and
- does not backfill a destination enabled after historical observations.

### 24.4 Rotation

- rotates on size and age independently;
- never splits a record;
- handles one oversized entry;
- maintains generation and sequence continuity;
- rotates when destination policy revision or capture fingerprint changes;
- atomically recovers interrupted manifest replacement;
- truncates only an incomplete active tail;
- rejects sealed-segment corruption, namespace identity mismatch, and silent relocation
  to an empty replacement directory; and
- emits rotation/recovery notifications.

### 24.5 API and reader

- status reflects idle, delivery, backoff, unconfigured, and blocked states;
- flush uses a captured high-water mark and respects timeout;
- close settles the active critical section without requiring backlog drain;
- reader paginates across segments;
- physical cursors distinguish duplicate positions sharing one audit sequence;
- logical reading deduplicates stable outbox IDs; and
- forensic reading preserves physical duplicates and reports gaps.

### 24.6 Performance

- audit-disabled observations perform no audit serialization, hashing, or writes;
- one normalization feeds canonical, audit, and identity projections without deep clones;
- identical destination fingerprints serialize one shared event payload;
- enqueue uses one canonical transaction rather than one transaction per destination;
- workers keep only bounded pages/batches in memory; and
- acknowledgement batching does not starve canonical writers under concurrent load.

### 24.7 End-to-end smoke test

The SQLite end-to-end smoke scenario must enable a small size threshold, generate enough
auditable operations to create at least two segments, close and reopen the agent, flush,
and independently assert:

- the canonical SQLite conversation remains reconstructable;
- pending outbox rows resume and become compact receipts;
- every expected logical audit entry is present;
- segment generations are increasing, physical audit sequences are non-decreasing, and
  deduplicated logical sequences are strictly increasing;
- the reader crosses the rotation boundary; and
- normal chat and recovery behavior remain unchanged.

## 25. Implementation order

1. Finalize/export observation, capture, configuration, status, notification, backend,
   and reader contracts.
2. Introduce the normalized observation boundary while proving canonical and identity
   behavior remains unchanged with audit disabled.
3. Migrate SQLite to schema version 8 with shared audit events, destination state, leases,
   delivery rows, and compact receipts.
4. Add transaction-aware audit projection and enqueue to canonical write paths.
5. Implement the fenced coordinator and JSONL sink without rotation.
6. Add sync-before-ack batching, retry, status, subscriptions, flush, and bounded shutdown.
7. Add stream identity, manifests, locking, policy-boundary rotation, sealing metadata,
   relocation checks, and crash recovery.
8. Add the version-2 segmented physical/logical reader.
9. Add contract, performance, concurrency, crash-boundary, and end-to-end tests.
10. Update the consumer guide and release notes.
11. Publish schema version 8 with the new minor library release.

## 26. Deferred extensions

- gzip/zstd compression of sealed segments;
- automatic file retention and consumer retention hooks;
- signed manifests and hash chaining;
- encrypted JSONL sinks;
- object-storage, HTTP, queue, and compliance-vendor sinks;
- synchronous required-delivery mode;
- administrative abandonment with an explicit durable gap record; and
- cross-database centralized audit aggregation.
