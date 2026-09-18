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
5. preserve a monotonic agent-wide order within each destination;
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
- **Audit entry**: the immutable payload produced when a destination's capture policy
  accepts an observation.
- **Outbox item**: durable SQLite delivery state for one audit entry and destination.
- **Destination**: a stable logical audit receiver selected by a consumer-defined ID.
- **Sink**: the implementation that physically delivers entries for a destination.
- **Segment**: one JSONL file in a rotating destination stream.
- **Receipt**: the compact SQLite state retained after an outbox payload is delivered.
- **Audit sequence**: a monotonically increasing integer scoped to one destination and
  one agent database. It orders accepted entries from all conversations of that agent.

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
6. Outbox payloads are immutable. Later policy changes do not rewrite pending entries.
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

## 6. Public configuration

`AgentConfig` gains an optional `auditLog` member:

```ts
interface AgentConfig {
  // existing members
  readonly auditLog?: false | AgentAuditLogConfig;
}

interface AgentAuditLogConfig {
  readonly destinations: readonly AgentAuditDestinationConfig[];
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
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
}

interface AuditRetryConfig {
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}
```

`auditLog` is disabled when absent or `false`. An enabled configuration must contain at
least one destination. Destination IDs must be unique, non-empty, at most 128 UTF-8 bytes,
and restricted to letters, digits, `.`, `_`, and `-` so they are safe in diagnostics and
manifest identities.

The first implementation supports multiple destinations. This matches the existing
outbox's destination identity and avoids baking a single local file into the agent model.

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
```

Either rotation trigger may be disabled explicitly by omitting it only when the other is
provided. Resolved configuration always has at least one active trigger. `maxBytes`
includes the segment header and newline delimiters. `maxAgeMs` is measured from segment
creation, but an idle destination does not create or rotate empty files.

Retry delay grows exponentially and is capped by `maxDelayMs`. A small randomized jitter
prevents several processes from retrying at one instant. Tests inject deterministic time
and jitter.

## 7. Audit capture

`AgentAuditCaptureConfig` uses the typed conversation record vocabulary and the existing
capture levels where they retain the same meaning:

```ts
type AgentAuditCaptureConfig = ConversationRecordCaptureConfig;
```

The initial default is deliberately operational rather than conversational:

```ts
const DEFAULT_AGENT_AUDIT_CAPTURE = {
  message: "none",
  tool_call: "metadata",
  permission: "content",
  configuration: "content",
  protocol: "none",
  native_action: "content",
  agent_action: "content",
  thinking: "none",
  activity: "metadata",
  metering: "content",
};
```

The levels mean:

- `none`: do not create an outbox item;
- `metadata`: keep identity, state, correlation, timing, and structural metadata but omit
  potentially sensitive content;
- `content`: keep the normalized domain content appropriate to the record kind; and
- `raw`: keep the complete supported domain payload after structural validation and
  configured size limits.

Protocol capture retains its existing `none | metadata | raw` levels and exact method
filters. Raw protocol capture is never enabled by default.

Capture projection occurs from the normalized observation before canonical capture
removes fields. Consequently, an audit destination may retain tool details even when the
canonical conversation policy stores only metadata. The projected audit payload itself
is stored in SQLite until delivery and therefore remains subject to the consumer's data
classification and database-access policy.

Capture is configured per destination. One destination may retain only permission and
configuration decisions while another keeps a more detailed diagnostic stream.

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
- explicit administrative retry, flush, or abandonment operations added in later APIs.

Agent-level kinds use a separate discriminated union rather than fabricating a
conversation ID. The initial implementation may deliver conversation observations first,
but the envelope and schema must not require every entry to belong to a conversation.

Sink delivery attempts, retry timers, leases, and segment housekeeping remain runtime
telemetry and receipts. They do not recursively enter the audit stream.

## 9. Projection and transactional enqueue

For each normalized observation:

1. resolve every configured destination's immutable capture policy;
2. independently project zero or one payload for each destination;
3. allocate the next destination-scoped `auditSequence` for every accepted payload;
4. create a stable outbox item;
5. commit the canonical mutation, destination sequence advancement, and all corresponding
   outbox items in one SQLite transaction; and
6. notify the background delivery runtime only after commit.

If canonical capture rejects the observation but audit accepts it, steps 3–5 still commit
an outbox item. If audit rejects it, no audit sequence is consumed for that destination.
Each destination therefore has a contiguous logical sequence for the entries it accepted.

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
  readonly captureLevel: "metadata" | "content" | "raw";
  readonly payload: PersistenceJsonValue;
}
```

`outboxId` identifies one delivery to one destination. The same observation delivered to
two destinations has two outbox IDs and may have different payloads. `sourceRecordId` and
`sourceSequence` are present when a canonical record exists; their absence for an
audit-only or agent-level observation is valid.

Timestamps are ISO-8601 UTC strings in the new format. Readers must not use timestamps to
establish order; `auditSequence` is authoritative within a destination.

## 11. SQLite schema and migration

This feature changes the pre-release SQLite schema from version 7 to version 8. Version 8
is intended to be the first published durable SQLite schema.

The schema must represent:

### 11.1 Destination state

- destination ID;
- last allocated audit sequence;
- last completed sequence;
- current retry/error summary;
- configuration/capture fingerprint and revision;
- update timestamps; and
- optional worker lease/fencing state.

The resolved filesystem directory is consumer configuration and is not authoritative
database identity. A container may mount the same destination at a different path while
retaining its destination ID.

### 11.2 Outbox and receipts

Each delivery row contains:

- outbox ID;
- destination ID and audit sequence, unique together;
- source agent, conversation, record, sequence, operation, and kind identifiers;
- immutable projected payload and its SHA-256 digest;
- creation time;
- retry count, next-attempt time, and last error;
- lease owner, fencing token, and lease expiry while claimed;
- delivered time;
- segment generation and segment record sequence;
- optional byte offset/length for diagnostics; and
- delivery receipt state.

After durable delivery, the full payload is removed and the row becomes a compact receipt.
The digest, source identity, destination sequence, segment location, and delivery time
remain. The first release retains compact receipts indefinitely. A future explicit
receipt-retention policy may bound them without deleting the external audit evidence.

The current `audit_outbox` table is development-only and may be migrated or replaced as
part of schema version 8 before publication.

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
7. transactionally marks those rows delivered and compacts them to receipts; and
8. continues with the next contiguous batch.

Rows are never acknowledged before the sync in step 6. A crash between steps 6 and 7 may
cause the same stable outbox ID to be appended again. This is the accepted at-least-once
boundary.

### 12.1 Cross-process ownership

SQLite leases fence multiple processes using the same agent database. A lease has a
bounded expiry and monotonically increasing fencing token. An expired worker may not mark
delivery after another worker acquires a newer token.

A destination directory also contains a filesystem lock/identity file. This prevents two
different agent databases from accidentally writing the same destination concurrently.
The identity binds the directory to agent ID, destination ID, and format version. An
identity mismatch fails closed and leaves outbox rows pending.

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
numbers are zero-padded for lexical order but readers use the numeric manifest value.

Each segment starts with exactly one header:

```ts
interface AgentAuditSegmentHeaderV2 {
  readonly v: 2;
  readonly t: "header";
  readonly agentSessionId: AgentSessionId;
  readonly destinationId: string;
  readonly generation: number;
  readonly createdAt: string;
  readonly firstAuditSequence: number;
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

## 14. Rotation algorithm

Before appending the next entry, rotate when:

- the active segment has entries and adding the next complete line would exceed
  `maxBytes`; or
- the active segment has entries and its age has reached `maxAgeMs`.

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
- monotonically increasing audit sequences;
- complete newline-delimited records; and
- sealed-segment size and digest where present.

An incomplete final line in the active segment is a torn append. Recovery may truncate
only that incomplete suffix after recording a recovery notification. It must never remove
a complete line merely because SQLite has not acknowledged it.

If a complete final entry is present but its outbox row is still pending, the worker may
append it again under the basic at-least-once contract. A later optimization may recognize
the tail's matching outbox ID and acknowledge it without duplication, but correctness
must not depend on that optimization.

Corruption before the active segment's final incomplete line, a sealed digest mismatch,
or an identity mismatch fails closed. The worker exposes the destination as blocked and
does not skip ahead or create an unrelated replacement stream.

## 16. Runtime API and observability

An enabled agent exposes an audit runtime:

```ts
interface AgentAuditRuntime
  extends StatefulSubscribable<AgentAuditSnapshot, AgentAuditNotification> {
  status(destinationId?: string): Promise<AgentAuditStatus>;
  flush(options?: AgentAuditFlushOptions): Promise<AgentAuditFlushResult>;
  retry(destinationId?: string): Promise<void>;
}
```

`status()` reports, per destination:

- state: `idle | delivering | backoff | unconfigured | blocked | stopped`;
- pending count and oldest pending timestamp;
- last allocated and delivered sequences;
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
call begins. It waits only for those boundaries, not for observations created later.
It accepts a timeout and returns a structured result for delivered, pending, blocked, and
timed-out destinations. It does not silently wait forever.

### 16.2 Retry

`retry()` clears retry delay for selected retryable destinations and wakes the worker. It
does not bypass identity/corruption blocks and does not fabricate missing configuration.

## 17. Agent shutdown

Normal `agent.close()`:

1. stops accepting new canonical work;
2. allows an in-progress audit append/sync/acknowledgement critical section to settle;
3. releases leases and file locks; and
4. returns without waiting indefinitely for the complete backlog.

Pending rows remain durable for the next open. A consumer that requires a drained local
sink calls `agent.audit.flush({ timeoutMs })` before `agent.close()` and handles the
result explicitly.

Process termination at any point relies on the outbox, lease, and segment recovery rules;
shutdown hooks are an optimization, not the correctness boundary.

## 18. Configuration changes

Destination ID is stable identity. Reopening the same ID at a different mounted path is
allowed only when the directory identity matches the same agent and destination. Pointing
an existing ID at an unrelated directory fails closed.

Capture and rotation changes affect only new audit observations and new segment metadata.
Pending payloads retain the projection created under their original policy. A capture
fingerprint in each entry/segment makes the boundary visible.

If a destination is absent on reopen:

- its pending rows remain unchanged;
- it is reported as `unconfigured`;
- no attempt count is consumed; and
- configuring the same destination ID later resumes delivery.

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

## 21. Security and privacy

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

## 22. Compatibility and release boundary

- Existing `SessionManager`/legacy JSONL audit behavior is unchanged.
- `AgentConfig.auditLog` is additive.
- Version-1 and version-2 readers are separate and explicit.
- The pre-release version-7 SQLite schema may be upgraded or recreated during development.
- Version 8 becomes the first published durable SQLite schema; later releases require
  forward migrations rather than a recreate instruction.
- Audit disabled remains zero external files and no outbox growth.
- Custom persistence backends advertise `auditOutbox` capability. Enabling audit on a
  backend without transactional audit enqueue support fails during `Agent.open()` rather
  than degrading silently.

## 23. Required tests

### 23.1 Configuration

- rejects duplicate/invalid destination IDs and invalid bounds;
- resolves caller-selected directories predictably;
- preserves independent destination capture policies; and
- rejects audit enablement on an incapable custom backend.

### 23.2 Transactionality and ordering

- canonical mutation and outbox enqueue both commit or both roll back;
- audit accepts an observation canonical capture omitted;
- concurrent conversations produce one monotonic sequence per destination;
- multiple destinations receive their own contiguous sequences and projections; and
- delivery never advances past a failed head item.

### 23.3 Delivery and recovery

- resumes a durable backlog after close/reopen;
- retries with bounded backoff;
- fences competing processes and expired workers;
- tolerates append-before-ack crashes through stable duplicate IDs;
- never acknowledges before sync;
- leaves missing destinations pending without burning retries; and
- compacts delivered payloads into receipts.

### 23.4 Rotation

- rotates on size and age independently;
- never splits a record;
- handles one oversized entry;
- maintains generation and sequence continuity;
- atomically recovers interrupted manifest replacement;
- truncates only an incomplete active tail;
- rejects sealed-segment corruption and directory identity mismatch; and
- emits rotation/recovery notifications.

### 23.5 API and reader

- status reflects idle, delivery, backoff, unconfigured, and blocked states;
- flush uses a captured high-water mark and respects timeout;
- close settles the active critical section without requiring backlog drain;
- reader paginates across segments;
- logical reading deduplicates stable outbox IDs; and
- forensic reading preserves physical duplicates and reports gaps.

### 23.6 End-to-end smoke test

The SQLite end-to-end smoke scenario must enable a small size threshold, generate enough
auditable operations to create at least two segments, close and reopen the agent, flush,
and independently assert:

- the canonical SQLite conversation remains reconstructable;
- pending outbox rows resume and become compact receipts;
- every expected logical audit entry is present;
- segment generations and audit sequences are monotonic;
- the reader crosses the rotation boundary; and
- normal chat and recovery behavior remain unchanged.

## 24. Implementation order

1. Finalize/export configuration, status, notification, and reader contracts.
2. Migrate SQLite to schema version 8 with destination state, leases, outbox delivery
   fields, and compact receipts.
3. Add transaction-aware audit projection and enqueue to canonical write paths.
4. Implement the fenced coordinator and JSONL sink without rotation.
5. Add sync-before-ack batching, retry, status, subscriptions, flush, and shutdown.
6. Add manifests, locking, rotation, sealing metadata, and crash recovery.
7. Add the version-2 segmented reader.
8. Add contract, concurrency, crash-boundary, and end-to-end tests.
9. Update the consumer guide and release notes.
10. Publish schema version 8 with the new minor library release.

## 25. Deferred extensions

- gzip/zstd compression of sealed segments;
- automatic file retention and consumer retention hooks;
- receipt retention/compaction policy;
- signed manifests and hash chaining;
- encrypted JSONL sinks;
- object-storage, HTTP, queue, and compliance-vendor sinks;
- synchronous required-delivery mode;
- administrative abandonment with an explicit durable gap record; and
- cross-database centralized audit aggregation.
