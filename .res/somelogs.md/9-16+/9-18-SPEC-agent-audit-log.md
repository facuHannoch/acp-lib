# Agent audit log delivery and rotation specification

Status: proposed. Required before publishing the first stable SQLite-backed `Agent`
release.

## 1. Purpose

SQLite is the canonical online persistence store for an `Agent`. It reconstructs chats,
restores runtime state, supports search, and retains provider history. An audit log has a
different purpose: it is a separately filtered, append-only operational record written to
a caller-selected location.

This specification defines one durable audit stream per `Agent`/`AgentSession`:

- capture independent from canonical conversation capture;
- transactional SQLite outbox creation;
- asynchronous and resumable JSONL delivery;
- size- and age-based rotation;
- one agent-wide order across all of the agent's conversations;
- observable backlog and delivery failures; and
- at-least-once delivery without silent loss after a crash.

The version-2 agent audit stream is separate from the existing version-1 per-session JSONL
audit implementation. The legacy implementation remains available through the legacy
`SessionManager` API.

## 2. Scope and accepted limitations

The first implementation intentionally chooses a small ownership and delivery model.

It supports:

- one SQLite database per agent;
- one active owning `Agent` runtime per SQLite database;
- any number of concurrent `AgentConversation` instances and ACP subprocesses owned by
  that runtime;
- one logical audit stream for all conversations owned by the agent; and
- one configured JSONL destination for that stream.

It does not initially support:

- several independent `Agent` instances concurrently opening the same SQLite database;
- multiple simultaneous audit destinations;
- live audit reconfiguration while an `Agent` is open;
- exactly-once delivery across SQLite and a filesystem;
- automatic backfill for periods in which audit capture was disabled;
- automatic replacement of lost audit history;
- permanent per-entry delivery receipts in SQLite;
- independent removal or archival of individual audit segments;
- automatic deletion or compression of sealed segments;
- cryptographic authenticity, signing, hash chaining, or tamper resistance;
- encryption at rest;
- remote audit sinks; or
- agent audit delivery through custom persistence backends.

These are accepted boundaries, not partially implemented guarantees. Multi-process agent
ownership would require leases, fencing, configuration coordination, and cross-process
worker ownership throughout the agent runtime. Multiple destinations would require
destination-specific delivery state and retention. Both may be added when an actual use
case justifies that system-wide complexity.

## 3. Terminology

- **Canonical state**: typed SQLite conversation records and the other tables used to
  restore the agent.
- **Observation**: one immutable normalized domain occurrence produced by a controller or
  agent runtime.
- **Audit item**: one projected observation waiting in the SQLite audit outbox.
- **Audit entry**: the physical version-2 JSONL representation of an audit item.
- **Audit stream**: all rotated JSONL segments belonging to one stable `auditLogId`.
- **Audit sequence**: a monotonically increasing logical integer scoped to the agent's
  audit stream.
- **Segment**: one numbered JSONL file in the stream.

A bounded contiguous range of audit sequences may appear more than once physically after
a crash, but each repeated sequence must carry the same `outboxId` and payload digest as
its first occurrence. Deduplicating by `outboxId` produces the logical stream.

`agentSessionId` remains the stable `ags-...` agent identity. An entry may carry an
`agentConversationId`, but agent-level observations do not fabricate one.

## 4. Core invariants

1. SQLite remains authoritative for agent state. Audit files are never used to restore a
   conversation.
2. Canonical capture and audit capture are independent.
3. When one observation changes canonical state and is accepted by the audit policy, the
   canonical mutation and audit enqueue commit in the same SQLite transaction.
4. Filesystem I/O never occurs inside a SQLite transaction.
5. Prompt completion never waits for JSONL delivery.
6. Pending audit payloads are immutable.
7. Audit items are delivered in strict sequence order. A failed head item blocks later
   audit delivery but does not block normal agent work.
8. Every segment file touched by a batch is synced before the corresponding outbox rows
   are removed.
9. A crash may duplicate a complete physical entry but must not silently lose an accepted
   audit item.
10. Rotation does not change audit, conversation, or canonical record sequences.
11. Audit delivery mechanics do not recursively create audit entries.
12. Identity continues to consume committed canonical records, not independently captured
    audit projections.
13. The library fails closed when a second `Agent` runtime attempts to own the same SQLite
    database.
14. Only one live audit writer may own a resolved `(directory, filePrefix)` namespace.

## 5. SQLite agent ownership

The single-owner rule applies to the complete SQLite-backed agent, not only to audit. One
owner may manage many concurrent conversations and ACP provider processes.

Before opening or migrating a file-backed agent database, `SqliteAgentPersistence` must:

1. resolve a canonical database path, resolving symlink aliases where possible;
2. reject a duplicate path already owned by another `Agent` in the current process;
3. open a small SQLite ownership sidecar at `<database>.agent-owner.sqlite`;
4. set the sidecar to zero busy timeout and exclusive locking mode;
5. execute a write probe that acquires and retains the sidecar's exclusive SQLite file
   lock; and
6. retain that sidecar connection until the main persistence backend closes.

`SQLITE_BUSY` or `SQLITE_LOCKED` during the ownership probe is mapped to
`AgentDatabaseInUseError` before an `Agent` is returned. Ownership acquisition does not
wait for the normal configurable database busy timeout. The error identifies the canonical
database path but does not expose unrelated process details.

The sidecar contains no agent state and its existence is not ownership. Ownership is the
live SQLite file lock held by its connection. Closing or terminating the owner process
releases that lock without PID checks, heartbeats, timeout-based takeover, or stale-file
deletion. The persistent sidecar can be reused on the next open.

The helper uses SQLite's ordinary rollback journal rather than WAL. Its acquisition is a
zero-wait `locking_mode=EXCLUSIVE` write transaction against a singleton probe table; after
commit, the connection retains the exclusive file lock until close. The probe value is
diagnostic only and never participates in stale-owner decisions.

The main agent database remains in ordinary WAL mode. External read-only inspection may
continue subject to SQLite's normal WAL rules. Direct external writes are unsupported
because they bypass library invariants, and another library runtime must always honor the
ownership sidecar.

`:memory:` databases do not share storage and use only the process-local ownership guard.
Custom persistence backends retain responsibility for their own ownership model,
but version-2 agent audit configuration is rejected for custom backends in the first
release.

The ownership sidecar is an implementation detail, not another persistence backend,
lease system, or source of agent truth.

If any later stage of `Agent.open()` fails, every acquired sidecar connection and main
database connection is closed in reverse order before the error is returned. Normal close
uses `finally` semantics so an audit cleanup error cannot silently strand agent ownership.

## 6. Public configuration

`AgentConfig` gains an optional `auditLog` member:

```ts
interface AgentConfig {
  // existing members
  readonly auditLog?: false | AgentAuditLogConfig;
}

interface AgentAuditLogConfig {
  readonly directory: string;
  readonly filePrefix?: string;
  readonly capture?: AgentAuditCaptureConfig;
  readonly rotation?: AuditRotationConfig;
  readonly retry?: AuditRetryConfig;
  readonly shutdownGraceMs?: number;
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

Audit capture and delivery are disabled when `auditLog` is absent or `false`. Disabling
does not delete existing state or pending outbox items, but observations occurring while
disabled are not captured and are never implicitly backfilled.

The resolved directory is caller-selected. Relative paths resolve once against the
process working directory during `Agent.open()`. The library does not invent a home
directory or other default destination.

The directory is created when absent. During open, the agent uses the same SQLite-sidecar
locking helper to acquire `<prefix>.writer-owner.sqlite` with zero wait and holds that
connection for the lifetime of the audit worker. A conflict throws
`AuditLogDestinationInUseError`.

The destination filesystem must therefore support SQLite file locking, exclusive file
creation, file sync, and the ordinary append semantics used by the JSONL writer. Mounts
that do not provide those guarantees are unsupported rather than silently downgraded.

On first enablement, `auditLogId` is committed to the agent database and the first segment
is synchronously reserved with exclusive file creation. Its synced header establishes the
durable identity of the namespace. If a segment already exists, its audit and agent
identities must match SQLite; otherwise open throws `AuditLogIdentityConflictError` before
the worker starts.

`filePrefix` defaults to `audit` and must be a safe filename component rather than a path.
New sidecars and segment files use owner-only permissions where supported. Existing
directory permissions are not silently changed.

The directory must be non-blank. The prefix must be non-empty, at most 128 UTF-8 bytes,
contain only letters, digits, `.`, `_`, and `-`, and must not equal `.` or `..`. Numeric
settings are bounded safe integers; retry delay must not decrease, shutdown grace may be
zero, and at least one rotation trigger must remain enabled. Invalid configuration fails
during `Agent.open()` before runtime work starts.

### 6.1 Defaults

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
```

Either rotation trigger may be disabled explicitly with `false`; omission selects its
default. At least one trigger must remain enabled. `maxBytes` includes the segment header,
entry bytes, and newline delimiters. Time-based rotation is lazy and does not create empty
daily segments.

Retry delay grows exponentially up to `maxDelayMs` with small randomized jitter. Tests
inject deterministic time and jitter.

Audit projection uses the same JSON-depth, record-size, captured-field, and truncation
limits as canonical persistence. The first release adds no second limits configuration.
The effective limits and projection schema version participate in the capture fingerprint.

## 7. Audit capture

Audit capture uses the typed conversation vocabulary while preserving useful operational
distinctions:

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
}
```

The operationally conservative default is:

```ts
const DEFAULT_AGENT_AUDIT_CAPTURE = {
  message: "none",
  tool_call: "metadata",
  permission: "decision",
  configuration: "selections",
  protocol: "none",
  native_action: "metadata",
  agent_action: "metadata",
  thinking: "none",
  activity: "metadata",
  metering: "summary",
  agent_lifecycle: "metadata",
  identity: "metadata",
  internal_inference: "metadata",
};
```

The general levels mean:

- `none`: do not enqueue the observation;
- `metadata`: preserve identity, state, correlation, timing, and structural metadata while
  omitting domain content;
- `content`: preserve normalized domain content; and
- `raw`: preserve the complete supported normalized payload, subject to persistence limits.

Specialized levels mean:

- tool `input`: preserve tool identity and input but omit output;
- permission `decision`: preserve the request identity, offered options, outcome, and
  timing without unrelated content;
- configuration `selections`: preserve effective selections but not announced definitions;
- configuration `definitions`: preserve selections and announced definitions;
- metering `summary`: preserve normalized token categories, measurement status,
  provider/model identity, and rated/provider cost summaries; and
- metering `raw`: preserve the validated `OperationMeteringRecord` subject to limits.

Protocol capture retains its existing `none | metadata | raw` levels and exact ACP method
filters. Raw protocol capture is never enabled by default.

The capture fingerprint is a canonical SHA-256 hash of the resolved capture policy,
protocol filters, projection schema version, and effective persistence limits. It is
diagnostic data recorded with each item; it is not an ownership or delivery identity.

Payload digests use the same library-owned canonical JSON encoder. Object-key ordering,
number encoding, and string escaping are therefore stable between outbox creation,
delivery, and reader verification.

Consumer-supplied metadata can itself contain sensitive information. `metadata` means
structural minimization, not a security classification.

## 8. Normalized observation boundary

Independent audit capture requires one internal boundary before canonical capture:

```text
controller/runtime occurrence
  -> immutable normalized observation
       -> canonical projection and persistence
       -> optional audit projection and outbox enqueue
       -> identity update from committed canonical records
```

`NormalizedAgentObservation` is an internal discriminated union of conversation and
agent-level occurrences. It is not a public event bus, database table, durable queue, or
second copy of provider traffic. It owns or references the already-normalized values
needed by projectors, and projectors do not deep-clone large values merely to inspect them.

The boundary covers current conversation record kinds:

- message;
- tool-call lifecycle;
- permission request and resolution;
- configuration announcement and selection;
- protocol traffic;
- native actions such as handoff, switch, reset, and recovery;
- future agent-initiated actions;
- thinking;
- model activity; and
- metering.

It also permits agent-level observations for agent open/close, identity publication, and
internal-inference lifecycle. Agent-level observations use their own union members and do
not fabricate a conversation ID.

Runtime delivery attempts, retry timers, rotation, flushes, and manual retry requests are
telemetry rather than auditable domain observations. They never enter the outbox.

When audit is disabled, no audit policy evaluation, projection, serialization, hashing,
outbox write, or audit worker scheduling occurs. The normalization needed by canonical
persistence remains shared rather than duplicated.

## 9. Transactional enqueue and idempotency

For an accepted observation, the persistence path:

1. projects the audit payload from the normalized observation;
2. serializes and hashes that payload once;
3. allocates the next audit sequence;
4. creates a stable outbox ID; and
5. commits the canonical mutation, sequence advancement, and outbox row in one SQLite
   transaction.

If canonical capture rejects an observation but audit accepts it, the audit item commits
in its own short SQLite transaction. If audit rejects it, no sequence is consumed.

Every accepted observation has a stable `sourceObservationId` minted before the durable
operation. Canonical records normally use their stable record ID. Agent-level observations
use their stable operation/event ID. While an item is pending, `sourceObservationId` is
unique in the outbox. Repeating an ambiguously completed enqueue finds the same row and
verifies the same digest rather than allocating a second sequence. Same-source,
different-payload reuse is a persistence conflict.

Delivered rows are deleted, so the first version does not preserve an indefinite
source-observation deduplication index. The runtime does not replay already committed
domain observations after their delivery. Arbitrary historical replay using the same
source identity is unsupported. Canonical uniqueness continues to protect canonical
records independently.

An enqueue failure aborts the SQLite transaction. If a model or tool already performed an
external action, the library cannot undo it; the owning operation reports persistence
failure rather than claiming that durable bookkeeping succeeded.

Post-commit `recordsCommitted` extension hooks cannot implement this guarantee. Audit
projection and enqueue must participate directly in the SQLite transaction that writes
canonical state.

## 10. SQLite schema

The pre-release SQLite schema advances from version 7 to version 8. Version 8 is intended
to become the first published durable SQLite agent schema.

### 10.1 Audit state

One agent-owned state row contains:

- stable `auditLogId`, generated when audit is first enabled;
- last allocated audit sequence;
- last delivered audit sequence;
- current capture fingerprint; and
- creation/update timestamps.

Filesystem generation and file position are discovered from the destination. SQLite does
not pretend that an external append and a database update can be one atomic transaction.

### 10.2 Pending outbox

Each pending row contains:

- `outboxId`;
- unique audit sequence;
- unique pending `sourceObservationId`;
- optional source record/operation/conversation identities;
- occurrence timestamp;
- observation kind and capture level;
- capture fingerprint;
- immutable projected payload and SHA-256 digest;
- creation time;
- attempt count and next-attempt time; and
- a byte-bounded last error.

The outbox contains pending work only. After a synced batch is acknowledged, one short
SQLite transaction advances the contiguous delivered high-water mark and deletes those
rows. The JSONL stream is the durable delivery history; SQLite retains no permanent
per-entry receipt.

The existing development-only `audit_outbox` schema may be replaced before schema version
8 is published.

## 11. Version-2 JSONL format

The destination contains numbered segments:

```text
<prefix>.000001.jsonl
<prefix>.000002.jsonl
<prefix>.000003.jsonl
...
```

Generation numbers use at least six digits for lexical order but are not capped at
`999999`.

Each segment starts with one header:

```ts
interface AgentAuditSegmentHeaderV2 {
  readonly v: 2;
  readonly t: "header";
  readonly auditLogId: string;
  readonly agentSessionId: AgentSessionId;
  readonly generation: number;
  readonly createdAt: string;
  readonly firstAuditSequence: number;
}
```

Every following complete line is one entry:

```ts
interface AgentAuditEntryV2 {
  readonly v: 2;
  readonly t: "audit";
  readonly auditLogId: string;
  readonly outboxId: string;
  readonly auditSequence: number;
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId?: AgentConversationId;
  readonly sourceRecordId?: string;
  readonly operationId?: string;
  readonly occurredAt: string;
  readonly kind: string;
  readonly captureLevel:
    | "metadata" | "input" | "decision" | "selections" | "definitions"
    | "content" | "summary" | "raw";
  readonly captureFingerprint: string;
  readonly payloadSha256: string;
  readonly payload: PersistenceJsonValue;
}
```

`occurredAt` is the domain occurrence time, not enqueue or delivery time. Outbox creation
and delivery timing remain runtime/SQLite diagnostics.

Readers establish order from generation and physical position, and establish logical
order from `auditSequence`. Timestamps are never ordering keys.

## 12. Delivery worker

An enabled agent owns one audit worker. It starts after `Agent.open()` has validated the
destination and schedules work without delaying conversation startup beyond that
validation.

The worker:

1. selects a bounded contiguous batch beginning with the lowest pending sequence whose
   retry time has arrived;
2. opens or recovers the active segment;
3. rotates before the next entry when required;
4. serializes each complete envelope to one newline-delimited buffer;
5. appends the batch, rotating between entries when necessary;
6. syncs every segment file touched by the batch;
7. transactionally advances the delivered high-water mark and deletes the batch; and
8. yields before taking more work.

A crash between steps 6 and 7 leaves the rows pending and can append the bounded batch
again. The physical sequence can therefore rewind over that batch before continuing. This
is the sole normal duplicate boundary. Stable outbox IDs and payload digests make the
replayed range detectable.

While the process remains alive, a synced-but-unacknowledged batch is retained as worker
state and only its SQLite acknowledgement is retried; its bytes are not deliberately
appended again. On reopen, recovery compares the complete physical tail with the pending
head. An exact same-ID/same-digest suffix is synced again and acknowledged without
rewriting it. If complete physical entries extend beyond SQLite's delivered high-water
mark but do not exactly match a contiguous pending prefix, the destination is blocked;
the writer does not append past unexplained data.

Retryable I/O failure updates the head row's attempt count, bounded error, and next retry
time. Later sequences remain blocked to preserve order. Exponential backoff does not block
canonical agent operations.

The worker reads bounded pages and batches, does not mirror the entire backlog in memory,
and never holds a SQLite transaction while performing filesystem I/O.

## 13. Rotation and crash recovery

Before appending the next entry, the worker rotates when:

- the active segment contains entries and adding the next complete line would exceed
  `maxBytes`; or
- the active segment contains entries and its age has reached `maxAgeMs`.

A single entry larger than `maxBytes` is written intact to an otherwise empty segment and
that segment receives no further entries. Entries are not split to satisfy rotation.

Rotation closes and syncs the current segment. The next generation is created lazily when
the next entry is available. Segment creation is exclusive. Its header is written and
synced before its first entry, and the parent directory is synced where the platform
supports directory sync. Failure of a supported sync operation is a delivery failure.

No manifest is required in version 2. On open, the writer lists files matching the exact
prefix, parses generation numbers, requires a contiguous generation sequence beginning at
one, and validates every segment header against the stored `auditLogId` and agent identity.
It inspects complete entries only as needed to validate the active tail and its continuity
with SQLite state. Full forensic validation belongs to the reader.

An incomplete final entry line in the highest generation is a torn append and may be
truncated. If the highest-generation file contains only an incomplete header and no
complete entry, it may be removed and recreated because the header was never established.
A complete malformed line, complete invalid header, generation gap, identity mismatch, or
sequence conflict fails closed. Recovery never removes a complete valid entry merely
because its outbox row remains pending.

Physical replay ranges are allowed only when every repeated audit sequence matches the
recent original outbox ID and payload digest. The replay range is bounded by the maximum
delivery batch size. After deduplication, logical sequences must be strictly increasing
without an unexplained gap.

The first stream initialization stores `auditLogId` in SQLite before creating its first
segment. The segment materializes that existing identity; it does not mint another one.
This removes an ambiguous database/filesystem identity race.

The first release does not checksum sealed segments. It detects structural corruption
while reading but does not claim protection against undetectable modification.

All generations remain part of one stream and must remain present. Independent archival
or deletion of older segments is unsupported until a manifest/retention contract exists.
Before acknowledging a batch, the writer verifies that every open segment touched by the
batch is still the file named by its expected path and has not been unlinked. A mismatch
blocks acknowledgement. Consumers must not rename, replace, truncate, or delete stream
files while the writer is active; unavoidable external races with hostile filesystem
mutation are outside the guarantee.

## 14. Destination continuity and configuration lifecycle

Audit configuration is immutable for the lifetime of one open `Agent`. To change capture,
rotation, retry, directory, or prefix, the consumer closes and reopens the agent.

Pending rows already contain their projected payload and therefore remain valid after a
capture-policy change. New observations use the newly resolved capture fingerprint. A
single stream may legitimately contain entries created under several capture policies;
each entry declares its fingerprint and level. Policy changes do not force rotation.

On reopen:

- an empty destination is accepted only when no sequence has previously been delivered;
- a non-empty destination must contain a contiguous stream with the same `auditLogId` and
  agent identity;
- changing directory or prefix is allowed only when the matching stream has been moved or
  mounted there; and
- if SQLite says entries were delivered but the matching files are missing, open with
  audit enabled throws `AuditLogHistoryMissingError`.

Version 2 has no reset, abandonment, or “start replacement stream” operation. A consumer
must restore missing history or run with audit disabled. Deliberately acknowledging a lost
stream and beginning a new epoch is deferred because it requires an explicit destructive
contract.

## 15. Runtime API and observability

An agent opened with audit enabled exposes:

```ts
interface AgentAuditRuntime
  extends StatefulSubscribable<AgentAuditSnapshot, AgentAuditNotification> {
  status(): Promise<AgentAuditStatus>;
  flush(options?: AgentAuditFlushOptions): Promise<AgentAuditFlushResult>;
  retry(): Promise<void>;
}
```

`status()` includes:

- state: `idle | delivering | backoff | blocked | stopped`;
- pending item count and approximate pending payload bytes;
- oldest pending timestamp;
- last allocated and delivered audit sequences;
- attempt count and bounded last error for the head item;
- active segment generation and bytes;
- resolved directory and prefix; and
- resolved rotation/retry settings and the current capture fingerprint.

Notifications include pending work, batch start/completion/failure, entering or leaving
backoff, rotation, recovery, blocked state, and flush completion/timeout. Notifications
are observational; a throwing subscriber is isolated from delivery state.

`flush()` captures the last allocated sequence when called and waits only for delivery
through that boundary. It accepts a timeout and returns a structured delivered, pending,
blocked, or timed-out result. The flush request itself is not audited.

`retry()` clears the head item's retry delay and wakes the worker. It cannot bypass a
blocked destination. The retry request and resulting delivery attempt are not audited.

When audit is disabled, `agent.audit` is absent. Existing pending work remains in SQLite
and becomes observable again when the agent is reopened with audit enabled.

## 16. Agent shutdown

Normal `agent.close()`:

1. stops accepting new agent operations;
2. transactionally enqueues the close lifecycle observation when its policy accepts it;
3. asks the audit worker to deliver through that new high-water mark;
4. waits for the worker for at most `shutdownGraceMs`;
5. stops scheduling further batches;
6. waits for any already-started append/sync/acknowledgement critical section to settle;
7. closes local audit resources and the audit-writer ownership sidecar; and
8. closes persistence and its agent-owner sidecar.

`shutdownGraceMs` bounds the attempt to drain through the close observation; it cannot
cancel an operating-system append or sync already in progress. If the timeout expires, no
new batch starts, but `close()` still waits for the active critical section before closing
persistence and releasing ownership. This prevents a replacement owner from overlapping
an old writer. A hung filesystem operation can therefore delay close beyond the grace
period. Any rows not transactionally acknowledged remain pending for the next open. The
close observation is durably retained but is not guaranteed to reach JSONL before close
returns.

Explicit callers that require a drained destination call `agent.audit.flush({ timeoutMs })`
before close and handle the result. That flush does not include the later close observation.

Process termination relies on outbox and torn-tail recovery. Shutdown hooks improve normal
behavior but are not the correctness boundary.

## 17. Reader

The version-2 reader exposes separate logical and physical modes:

```ts
const reader = await AgentAuditLogReader.open({
  directory: "/audit/atlas",
  filePrefix: "audit",
});

const page = await reader.readPage({
  mode: "logical", // or "physical"
  limit: 100,
  cursor,
});
```

On the first page, the reader captures a snapshot boundary consisting of the highest
generation and its complete byte offset. Returned cursors bind:

- audit-log identity;
- reader mode;
- snapshot generation and high offset; and
- current generation and byte offset.

Logical cursors additionally retain a bounded recent window of sequence, outbox ID, and
digest tuples. The window is at least the maximum delivery batch size, allowing a complete
replayed batch to be validated and deduplicated across page and segment boundaries. The
delivery batch bound is chosen so this state remains within the existing cursor safety
limit. Duplicate entries do not evict their corresponding logical entries from the
window. Physical mode returns every complete entry for forensic inspection.

The reader validates filenames, contiguous generations, headers, envelopes, JSON, payload
digests, ordering, duplicates, and the active snapshot boundary. It reports torn tails,
gaps, malformed records, and conflicts explicitly. It never repairs or mutates files.

Legacy `AuditLogReader` remains responsible for version-1 per-session audit files.

## 18. Failure semantics

There are four distinct failure classes:

1. **Ownership failure**: another runtime owns the SQLite database. `Agent.open()` throws
   `AgentDatabaseInUseError`; another live writer owns the audit namespace and open throws
   `AuditLogDestinationInUseError`; or a namespace carries another durable identity and
   open throws `AuditLogIdentityConflictError`.
2. **Projection/enqueue failure**: the SQLite transaction rolls back and the owning
   operation reports persistence failure.
3. **Delivery failure**: canonical state and pending audit intent remain committed. Normal
   agent work continues while audit delivery enters backoff or blocked state.
4. **Flush failure/timeout**: the explicit call returns a structured incomplete result and
   leaves pending work intact.

Audit delivery is asynchronous and cannot undo a model or tool side effect. A future
synchronous-required mode would still be unable to reverse an already executed external
action.

## 19. Performance and capacity

The normalized observation boundary is a logical split rather than another durable event
stream. The implementation must ensure:

- audit disabled performs no audit serialization, hashing, writes, or worker scheduling;
- normalization happens once and large values are not deep-cloned per projector;
- the resolved policy is compiled during open;
- each accepted observation is projected, serialized, and hashed once;
- audit enqueue joins the canonical transaction rather than opening an extra transaction;
- workers use bounded pages and byte/record batches;
- acknowledgement uses one short SQLite transaction per synced batch; and
- workers yield between batches so audit acknowledgement does not starve canonical writes
  in SQLite's single-writer path.

Raw protocol capture is an explicit high-volume mode. Streamed `session/update` traffic
can dominate database growth and write throughput.

If the destination remains unavailable, pending audit data grows without a fixed bound.
Dropping data would violate audit durability, while blocking prompts would violate the
asynchronous contract. Version 2 therefore chooses durable growth plus observable pending
count/bytes. Consumers must monitor status and provide adequate database capacity.

Deleting delivered outbox rows does not immediately shrink the SQLite file. Normal SQLite
checkpointing and maintenance behavior still applies.

## 20. Security and privacy

- Audit files and pending payloads are plaintext unless the consumer supplies encrypted
  storage.
- Defaults omit messages, thinking, action contents, and raw protocol traffic.
- Paths, status, errors, and configuration diagnostics never include payload bodies.
- Persisted delivery errors are byte-bounded.
- Audit projection uses established persistence validation and truncation rules.
- Directory ownership and permissions remain the consumer's deployment responsibility.
- A configured audit policy may retain more sensitive data than canonical capture;
  documentation must call this out directly.
- SQLite sidecar locks coordinate library runtimes but are not protection from a hostile
  process that ignores or deletes ownership files.
- Stream files must not be externally rotated, replaced, or deleted while the agent owns
  the destination. Rotation is owned by the library.

## 21. Compatibility and release boundary

- Existing legacy `SessionManager` transcript and audit behavior remains unchanged.
- `AgentConfig.auditLog` is additive for the SQLite-backed `Agent` API.
- Version-1 and version-2 readers are separate and explicit.
- Audit-enabled custom persistence fails during `Agent.open()` with a capability error.
- The development-only schema version 7 may be upgraded or recreated before publication.
- Schema version 8 becomes the first published durable SQLite schema; later releases
  require forward migrations.
- Audit disabled creates no external files or new outbox rows and does not delete pending
  work.

## 22. Required tests

### 22.1 Ownership

- invalid paths, prefixes, numeric bounds, or fully disabled rotation are rejected;
- audit configuration on a custom persistence backend is rejected;
- a second `Agent.open()` for the same canonical path fails immediately;
- path aliases and symlinks cannot bypass process-local or sidecar ownership;
- many concurrent conversations and ACP subprocesses work through one owner;
- normal close and process termination release ownership;
- a remaining sidecar after process termination does not prevent reopen;
- external read-only access to the main database remains possible; and
- two different agent databases cannot concurrently own one audit namespace.

### 22.2 Capture and transactionality

- canonical mutation and accepted audit enqueue commit or roll back together;
- audit may accept an observation canonical capture omits;
- canonical identity input remains unchanged;
- enqueue retry while pending reuses source/outbox identity and sequence;
- same-source, different-payload reuse is rejected;
- all supported observation kinds obey their capture levels; and
- audit-disabled observations perform no audit projection, hash, or write.

### 22.3 Ordering and delivery

- concurrent conversations allocate one contiguous agent-wide sequence;
- delivery never passes a failed head item;
- a synced batch is removed and advances the high-water mark atomically;
- append-before-ack crash produces only bounded same-ID/same-digest replay ranges;
- delivery resumes after close/reopen;
- bounded backoff and manual retry work; and
- an unavailable destination grows an observable durable backlog without blocking prompts.

### 22.4 Rotation and recovery

- rotation works independently by size and age;
- no entry is split;
- oversized entries occupy a segment alone;
- generations remain contiguous;
- headers preserve audit-log and agent identity;
- segment creation is exclusive and persists the directory entry before acknowledgement;
- initialization persists `auditLogId` before file creation;
- an incomplete header-only highest generation is safely recreated;
- only an incomplete highest-segment tail is truncated;
- complete malformed records, generation gaps, identity mismatch, and conflicting
  duplicates fail closed;
- moving/mounting the complete stream permits a directory change;
- an empty or unrelated replacement directory is rejected after delivery began; and
- replacing or unlinking the active segment prevents SQLite acknowledgement.

### 22.5 Runtime and shutdown

- status reports backlog bytes/count, high-water marks, backoff, blocked state, and path;
- flush waits only for its captured high-water mark and respects timeout;
- retry wakes the head item without producing an audit entry;
- close attempts bounded delivery including its accepted close observation;
- a shutdown timeout leaves unacknowledged rows pending and never releases ownership while
  an old critical section remains active; and
- audit-disabled reopen preserves pending rows without delivering or capturing.

### 22.6 Reader

- logical mode deduplicates stable outbox IDs;
- physical mode retains duplicates;
- cursor pagination crosses segment boundaries;
- logical deduplication works when a bounded batch replay crosses page or segment
  boundaries;
- snapshot cursors ignore later appends;
- payload digests and ordering are validated; and
- the reader reports gaps, torn tails, and corrupt complete records without mutation.

### 22.7 End-to-end smoke test

The SQLite smoke scenario must:

1. enable audit with a small rotation threshold;
2. run concurrent conversation operations;
3. create at least two segments;
4. close and reopen the agent;
5. exercise a recoverable delivery failure;
6. flush; and
7. independently verify canonical reconstruction, pending-row recovery, logical audit
   completeness, physical ordering, rotation, and reader pagination.

## 23. Implementation order

1. Implement and test SQLite exclusive runtime ownership.
2. Finalize normalized observation and audit capture contracts.
3. Migrate SQLite to schema version 8 with audit state and pending outbox tables.
4. Integrate audit projection/enqueue into canonical SQLite transactions.
5. Implement the single delivery worker without rotation.
6. Add retry, status, subscriptions, flush, and bounded shutdown.
7. Add numbered-segment rotation and crash recovery.
8. Add the physical/logical version-2 reader.
9. Add concurrency, crash-boundary, performance, and end-to-end tests.
10. Update the consumer guide and release notes.

## 24. Deferred extensions

- multiple destinations and remote sinks;
- multi-process ownership of one agent database;
- live reconfiguration and configuration compare-and-swap;
- compact SQLite delivery receipts and historical replay deduplication;
- explicit lost-stream abandonment and new audit epochs;
- manifests and sealed-segment checksums;
- compression and automatic segment retention;
- signing, hash chaining, and encryption; and
- synchronous required-delivery modes.
