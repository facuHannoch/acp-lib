# AgentSession persistence and transcript specification

Status: proposed implementation contract
Date: 2026-09-06
Scope: default persistence, the logical-session registry, transcript capture policy,
restoration checkpoints, crash recovery, and paginated reads

## 1. Purpose

`AgentSession` has a stable identity which is deliberately independent from the current
ACP/harness thread. That stable identity is what lets a consumer retain one reference
while the library performs a handoff, changes provider threads, or eventually switches
adapters.

Persistence must preserve that abstraction. It has three jobs:

1. Discover logical `AgentSession`s created through the library.
2. Reconstruct the routing and continuation state of one logical session.
3. Retain a policy-controlled transcript that consumers can read without starting the
   harness.

The persistence layer does not own live `AgentSession` objects. A consumer continues to
decide how many sessions are live, how they are coordinated, and where production data is
stored.

This specification replaces the accidental coupling between transcript paths, provider
thread selection, and the optional `SessionManager` catalog with one explicit model.

## 2. Terminology and identities

- **Agent session**: the library-level logical conversation. Its `agentSessionId` is stable
  for its entire lifetime.
- **Internal session**: the current harness/provider thread. Its `internalSessionId` can
  change during a handoff, switch, or mode change.
- **Registry**: the authoritative inventory and routing catalog of logical agent sessions.
- **Transcript**: an append-only JSONL history for one logical agent session.
- **Checkpoint**: a versioned, serializable snapshot sufficient to reconstruct the
  library's last known continuation state.
- **Operation boundary**: the durable start or end of an operation which can reach the
  harness or provider.
- **Clean boundary**: the latest operation is durably settled and covered by a checkpoint.
- **In-flight boundary**: an operation was durably recorded as started but was not durably
  recorded as settled.

The registry is authoritative for discovery. A checkpoint is authoritative for the
continuation state at its revision. A transcript is authoritative for the events the
library persisted. None is an invoice, a tamper-resistant audit ledger, or proof that an
external tool side effect did not occur.

## 3. Public configuration

The new configuration is rooted under `persistence`:

```ts
type TranscriptPreset =
  | "conversation"
  | "activity"
  | "detailed"
  | "diagnostic";

interface PersistenceConfig {
  /** Default: ACP_CLIENT_HOME, otherwise ~/.acp-client. */
  root?: string;

  /** Enabled with the default file store when omitted. */
  registry?: false | {
    store?: AgentSessionStore;
  };

  /** Enabled with the activity preset when omitted. */
  transcript?: false | {
    path?: string;
    preset?: TranscriptPreset;
    capture?: Partial<TranscriptCapturePolicy>;
  };

  /** Controls which ACP session-config values enter restoration state. */
  sessionConfiguration?: {
    /** Default: typed. */
    values?: "none" | "typed" | "all";
    /** Explicitly persist these IDs even when their type is unknown. */
    include?: readonly string[];
    /** Never persist these IDs; exclusion wins over inclusion. */
    exclude?: readonly string[];
  };
}

interface AgentSessionConfig {
  // Existing runtime configuration...
  persistence?: false | PersistenceConfig;
}

interface JsonObject {
  [key: string]: JsonValue;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;
```

Defaults:

```ts
{
  root: "~/.acp-client",
  registry: {},
  transcript: {
    preset: "activity",
  },
}
```

`persistence: false` disables both registry and transcript persistence. The two facilities
can otherwise be disabled independently.

Default persistence is intentionally visible in documentation because it writes
conversation content to disk. Applications should normally set an application-specific
root or inject their own store. Directories and files created by the default store must
be owner-only where the platform supports permissions.

The root is resolved in this order:

1. `persistence.root`.
2. `ACP_CLIENT_HOME`.
3. `<home>/.acp-client`.

The root's name is an implementation/product name, not a promise that the package can
never be renamed. A future rename requires an explicit migration rather than silently
creating a competing root.

## 4. Default layout

The default file implementation uses:

```text
~/.acp-client/
  agent-sessions.json
  agent-sessions.json.bak
  transcripts/
    <encoded-agentSessionId>.jsonl
```

There is one central mutable registry and one append-only transcript per logical session.
There must not be a second metadata file beside every transcript.

The default transcript filename is derived from the stable `agentSessionId`, never from
the mutable `internalSessionId`.

## 5. Transcript path resolution

`transcript.path` has one documented filesystem-dependent interpretation:

1. An existing directory means the library derives
   `<encoded-agentSessionId>.jsonl` inside it.
2. An existing regular file is used exactly.
3. A nonexistent path is treated as the exact desired file path.
4. Any other filesystem object is rejected.

No filename-extension heuristic is allowed. A consumer that wants a new directory must
create that directory before session creation. Parent directories of an exact transcript
file may be created by the writer.

The library expands a leading `~`, resolves the result to an absolute path, and stores
that absolute path. Existing symbolic-link destinations are rejected by the default
store; consumers that deliberately need symbolic links provide a custom store. For a
nonexistent file, the nearest existing parent is resolved and checked before creation.
This prevents accidental ambiguity but is not a defense against a malicious actor who can
concurrently replace directories owned by the consumer.

If `path` is omitted, the library creates and uses the default `transcripts` directory.

A transcript path does not, by itself, select or restore a provider thread. Restoration
occurs only through the new persistence/checkpoint startup path described below. Legacy
`transcriptPath` and `transcriptDir` retain their historical history-only behavior during
deprecation.

## 5.1 Creation and restoration are distinct

The public API must not infer startup intent from whichever identifiers happen to be
present. New and restored sessions use discriminated entry points:

```ts
await AgentSession.create({
  // Runtime and persistence configuration.
  agentSessionId: optionalConsumerChosenId,
});

await AgentSession.open({
  agentSessionId: optionalWhenCheckpointOrExactFileIdentifiesIt,
  persistence,
  checkpoint: optionalConsumerCheckpoint,
  resolveAdapter,
});
```

`create()` always requests a new internal harness session. If its chosen
`agentSessionId` already exists in the configured registry, or its resolved transcript
belongs to another logical session, creation fails with `AgentSessionAlreadyExistsError`.
It never silently resumes or appends to an unrelated transcript.

`open()` always reconstructs an existing logical session. It gathers all explicitly
available candidates—the consumer checkpoint, registry checkpoint, and latest valid
transcript checkpoint—and applies the consistency rules in section 10. There is no
“path beats ID” or “internal ID beats transcript” precedence. Consistent newer revisions
win; same-revision disagreement fails.

`open()` requires at least one unambiguous identity source: an `agentSessionId`, an
explicit checkpoint, or an exact existing transcript file configured through
`persistence.transcript.path`. Opening from a directory requires `agentSessionId` so the
filename can be derived. Opening a missing path fails; only `create()` creates a new
logical session.

Built-in adapter IDs use the library's adapter resolver. Reopening a custom adapter
requires a consumer `resolveAdapter(adapterId)` callback. Persisted command lines are not
blindly executed.

`SessionManager` may expose `createAgentSession()` and `loadAgentSession()` as convenience
factories, but it does not retain the returned live objects. The consumer remains their
owner. Providing a bare `internalSessionId` is a lower-level provider-thread operation,
not restoration of a logical `AgentSession`.

The default manager is externally reachable rather than privately constructed inside
each session:

```ts
const sessions = await SessionManager.open(); // ~/.acp-client
const page = await sessions.listAgentSessions();

const created = await sessions.createAgentSession(config);
const loaded = await sessions.loadAgentSession(agentSessionId, {
  resolveAdapter,
});
```

`SessionManager.open({ root, store })` and `AgentSession` use the same configuration
normalization. A consumer that creates an `AgentSession` directly can pass the manager;
when it omits one, the library uses an equivalent default manager which remains
discoverable later through `SessionManager.open()`.

## 6. Capture policy

Presets are conveniences. The resolved contract is component-based:

```ts
interface TranscriptCapturePolicy {
  messages: "none" | "text";
  reasoning: "none" | "text";
  tools: "none" | "metadata" | "content";
  lifecycle: boolean;
  transitions: "none" | "metadata" | "content";
  permissions: "none" | "decision" | "full";
  usage: boolean;
  configuration: "none" | "selections" | "definitions";
  protocol: "none" | "metadata" | "raw";
}
```

Explicit `capture` members override the selected preset. The library expands the preset
once at session creation and retains the immutable effective policy.

| Component | conversation | activity (default) | detailed | diagnostic |
| --- | --- | --- | --- | --- |
| User/assistant messages | text | text | text | text |
| Reasoning text | none | none | text | text |
| Tool name, status, timing | none | metadata | metadata | metadata |
| Tool arguments and commands | none | none | content | content |
| Tool output and diffs | none | none | content | content |
| Session/operation lifecycle | no | yes | yes | yes |
| Handoff/switch metadata | yes | yes | yes | yes |
| Handoff summary/continuation content | no | no | yes | yes |
| Permission information | none | decision | full | full |
| Usage/context timeline records | no | yes | yes | yes |
| Session configuration | none | selections | selections | definitions |
| Initialization metadata | none | none | none | metadata |
| Raw ACP traffic | none | none | none | raw |

Selecting `diagnostic` explicitly authorizes sensitive protocol capture. No redundant
confirmation boolean is required. Debug logger level and transcript policy remain
independent: enabling debug logs must never enable diagnostic transcript capture.

### 6.1 Filtering boundary

Filtering and redaction happen before a value enters the persistence queue. Disallowed
content must never be serialized and later hidden by a reader.

The `activity` preset uses an allowlist. Its tool metadata excludes:

- command text and raw arguments;
- filesystem paths and locations;
- tool output and raw output;
- diffs and patches;
- ACP titles synthesized from arguments;
- raw error payloads;
- unknown/unclassified payloads.

The current v1 default includes `unknown` activity and therefore cannot be reused as the
safe v2 default.

Capture policy applies to persistence, not live observers. A consumer's live handlers and
listeners continue to receive the data their APIs promise.

For `permissions: "decision"`, the safe record contains only structural identifiers,
the selected outcome, and timestamps. It excludes the request, tool title, command,
paths, and option descriptions because those can be derived from sensitive arguments.

### 6.2 Structural records

When a transcript is enabled, the following content-free structural records are always
written regardless of display capture choices:

- header and format transitions;
- operation start and terminal boundaries;
- restoration checkpoints;
- internal-session transition identifiers;
- recovery and corruption diagnostics.

This is necessary for the transcript to be a continuation artifact. Structural records
must not contain prompts, responses, tool arguments/output, reasoning, environment
values, secrets, or arbitrary harness payloads.

An operational metering checkpoint may be embedded in a restoration checkpoint when
metering is enabled. `capture.usage` controls user-facing usage/context history records;
it does not discard state required to restore metering correctly. Such state is not a
billing ledger.

Likewise, `capture.configuration` controls configuration history shown in transcript
projections. The separately configured restoration values may still occur inside a
structural checkpoint. This is documented because checkpoints are readable JSON rather
than a secret store.

## 7. Registry schema

The default registry is one complete JSON document:

```ts
interface AgentSessionsRegistryFile {
  version: 1;
  revision: number;
  updatedAt: string;
  sessions: Record<string, AgentSessionRecord>;
}

interface AgentSessionRecord {
  agentSessionId: string;
  recordRevision: number;
  checkpoint: AgentSessionCheckpoint;

  adapterId: string;
  mode: "normal" | "degraded";
  internalSessionId: string | null;
  internalSessionActivatedAt: string | null;
  internalSessionHistory: readonly InternalSessionHistoryEntry[];

  cwd?: string;
  title?: string;
  model: string | null;
  sessionConfiguration: SessionConfigurationCheckpoint;
  protocol:
    | { name: "acp"; version: number }
    | { name: "pty" };
  agent?: {
    name?: string;
    title?: string;
    version?: string;
  };

  transcript: null | {
    path: string;
    transcriptId: string;
    generation: number;
    preset: TranscriptPreset;
    effectivePolicy: TranscriptCapturePolicy;
  };

  metadata?: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}
```

`model` and negotiated protocol are first-class because they affect restoration,
metering, compatibility, and diagnostics. The ACP protocol version is the value
negotiated during initialization, not a hardcoded SDK constant. Degraded sessions use
`{ name: "pty" }`.

`metadata` is consumer-owned JSON. Registry updates must preserve it and unknown members
within a recognized registry version. Environment variables, API keys, authorization
headers, and adapter command lines containing credentials must never be stored.

The routing fields duplicated outside `checkpoint` are indexed/materialized projections
for listing. They must equal the corresponding checkpoint fields. A mismatch is registry
corruption, not a last-write-wins choice.

Unknown registry versions are fatal. A library must not partially interpret a newer
document whose invariants it does not understand.

## 8. Internal-session history

The unqualified `internalSessionId` remains the current harness thread. Previous threads
are retained with the context needed to understand a transition:

```ts
interface InternalSessionHistoryEntry {
  internalSessionId: string;
  adapterId: string;
  model: string | null;
  sessionConfiguration: SessionConfigurationCheckpoint;
  protocol:
    | { name: "acp"; version: number }
    | { name: "pty" };
  activatedAt: string;
  deactivatedAt: string;
  transition:
    | { kind: "handoff"; handoffId: string }
    | { kind: "switch"; switchId: string }
    | { kind: "mode_change" }
    | { kind: "replacement"; reason?: string };
}
```

The history is not called “archived”: an old harness session may remain loadable. It is
historical with respect to the logical session's current routing, not necessarily deleted
at the provider.

The current internal session must not also appear as a completed history entry. On a
transition, the old current entry is appended to history and the new current identity is
installed under the same `agentSessionId`.

`internalSessionActivatedAt` records when the current non-null internal session became
active. A null degraded-mode identity has no history entry; its mode transitions remain
represented by transition records.

## 9. Continuation checkpoint

Consumers should not have to independently persist an `internalSessionId` and reconstruct
all related fields. The public, serializable continuation unit is:

```ts
interface AgentSessionCheckpoint {
  version: 1;
  agentSessionId: string;
  stateRevision: number;
  digest: string;

  adapterId: string;
  mode: "normal" | "degraded";
  internalSessionId: string | null;
  internalSessionActivatedAt: string | null;
  internalSessionHistory: readonly InternalSessionHistoryEntry[];
  model: string | null;
  sessionConfiguration: SessionConfigurationCheckpoint;
  protocol:
    | { name: "acp"; version: number }
    | { name: "pty" };

  transcript: null | {
    transcriptId: string;
    generation: number;
    path: string;
    coveredSequence: number;
  };

  metering?: AgentSessionMeteringState;
  boundary:
    | {
        status: "settled";
        lastSettledOperationId: string | null;
      }
    | {
        status: "in_flight";
        lastSettledOperationId: string | null;
        interruptedOperationId: string;
        cause:
          | "operation_started"
          | "transport_error"
          | "harness_exit"
          | "host_interrupt"
          | "restored_after_unclean_exit";
      };

  updatedAt: string;
}
```

The exact metering-state type is defined by the metering specification. The checkpoint
stores bounded continuation state, never unbounded operation history.

`stateRevision` increases whenever resumable state changes. `digest` is lowercase-hex
SHA-256 over RFC 8785 JSON Canonicalization Scheme bytes for every checkpoint member
except `digest`. Unsupported JSON values are rejected before checkpoint creation. The
digest detects accidental corruption and same-revision conflicts; it is not tamper
resistance. No HMAC or library-held secret is part of this version.

Consumers may treat the checkpoint as opaque and store it in their own database. The
library validates version, digest, logical identity, and relevant adapter/internal-session
identity before accepting it.

The resolved transcript path is covered by the digest. Moving a transcript is therefore
an explicit relocation operation which emits a new checkpoint revision and digest; a
consumer must not edit the path inside an existing checkpoint. The portable part of a
handoff is its continuation content, not an arbitrary machine-local checkpoint.

### 9.1 ACP session configuration

ACP session configuration is dynamic: the harness announces options after creating or
loading a session, and `setSessionConfigOption` returns a new complete option set. The
checkpoint preserves selected state without treating yesterday's announcement catalog as
current truth:

```ts
interface PersistedSessionConfigSelection {
  configId: string;
  type: "select" | "boolean" | "unknown";
  value: JsonValue;
  ordinal: number;
  setAt: string;
}

interface SessionConfigurationCheckpoint {
  adapterId: string;
  /** Digest of IDs, types, and selectable values last announced by the harness. */
  schemaDigest: string | null;
  /** Values explicitly applied through this AgentSession, in application order. */
  desired: readonly PersistedSessionConfigSelection[];
  /** Latest persisted current values reported by the harness. */
  effective: Readonly<Record<string, JsonValue>>;
  /** Advertised values deliberately omitted by persistence policy. */
  omittedConfigIds: readonly string[];
  observedAt: string;
}
```

The default `values: "typed"` persists boolean values and select values which match an
advertised choice. It omits `unknown` values unless their IDs are explicitly included.
`all` persists every JSON-compatible value and may retain secrets supplied through a
custom harness option. `none` retains no ACP option values and therefore cannot promise
exact configuration restoration. `exclude` always wins.

The full labels, descriptions, groups, and allowed-value catalog are not required for
restoration and are not stored in the registry/checkpoint. They may appear in transcript
history only under `configuration: "definitions"`. The harness announcement on the next
open is always the current schema.

After a successful `setConfig(configId, value)`, the library uses the returned complete
config-option set to update `desired`, `effective`, the normalized first-class `model`
when applicable, and the schema digest. It then appends any policy-visible configuration
record, creates a checkpoint, and updates the registry before resolving the call.

An unsolicited ACP configuration update refreshes `effective`, normalized `model`, and
the checkpoint, but does not become a consumer `desired` override. `desired` records only
successful explicit selections made through this logical `AgentSession`.

If ACP accepted the setting but persistence fails, the method reports that the runtime
configuration changed while its checkpoint did not and blocks another state-changing
operation until repaired. It must not report an ordinary pre-dispatch failure.

On `open()`, the library loads the internal session, obtains its newly announced options,
and compares them with the checkpoint. Explicit `desired` selections are reapplied in
ordinal order only when they differ, validating the option after every response because
one option can change the remaining schema. Reapplication happens before any prompt or
handoff seed.

If a desired option disappeared, its value is no longer allowed, reapplication is
rejected, or an omitted value prevents exact comparison, restoration enters uncertain
recovery with reason `configuration_mismatch`. The consumer may accept the harness's
current configuration, provide replacement selections, start a new internal session, or
abort.

During same-adapter handoff, desired selections carry to the new internal session and are
applied before continuation seeding. Across an adapter switch they do not transfer unless
the switch request or consumer supplies an explicit mapping; config IDs are not portable
between harnesses. The old configuration snapshot remains in
`internalSessionHistory`.

## 10. Authority and persistence combinations

The supported combinations are:

| Registry | Transcript | Reopen source | Discovery |
| --- | --- | --- | --- |
| enabled | enabled | newest consistent checkpoint | registry |
| enabled | disabled | registry checkpoint | registry |
| disabled | enabled | latest valid transcript checkpoint | consumer-supplied path |
| disabled | disabled | consumer-supplied checkpoint | consumer |

With neither facility enabled:

- creating a new session remains supported;
- reopening requires a consumer-supplied `AgentSessionCheckpoint` and adapter resolution;
- providing only `agentSessionId` is insufficient and must fail before starting a
  harness.

The registry is the inventory source of truth. Transcript-directory scanning is an
explicit recovery/import utility, never implicit session discovery.

Restoration examines `(checkpoint, journal tail)`, not the checkpoint alone. The journal
tail is every structurally valid operation/transition record after
`checkpoint.transcript.coveredSequence`. It determines whether the checkpoint is clean,
has an uncovered terminal operation, or has an operation that only started. A registry-
only session expresses the equivalent tail state by publishing an in-flight checkpoint
before dispatch.

When registry and transcript both contain a checkpoint:

1. Same revision and digest: the state is consistent.
2. Transcript revision newer: use it and repair the registry observably.
3. A newer registry `in_flight` checkpoint matching the transcript's uncovered
   `operation(started)` is the expected dirty write-ahead state; use it and enter
   recovery.
4. Any other newer registry revision is used with an observable transcript persistence
   gap.
5. Same revision with different digest: fail with a checkpoint-conflict error.
6. Different logical identities or transcript generations: fail; never merge them.

These rules acknowledge that two files cannot be atomically committed together. The
writer creates one immutable checkpoint object and writes that exact object to both.

## 11. Registry storage contract

The public storage abstraction uses per-record compare-and-swap rather than leaking the
default implementation's full JSON document:

```ts
interface AgentSessionStore {
  getAgentSessionRecord(agentSessionId: string): Promise<AgentSessionRecord | null>;
  saveAgentSessionRecord(
    record: AgentSessionRecord,
    options: { expectedRecordRevision: number | null },
  ): Promise<AgentSessionRecord>;
  deleteAgentSessionRecord(
    agentSessionId: string,
    options: { expectedRecordRevision: number },
  ): Promise<void>;
  listAgentSessions(
    options?: ListAgentSessionsOptions,
  ): Promise<AgentSessionListPage>;
}
```

`AgentSessionRecord` therefore also contains a monotonically increasing
`recordRevision`. Saving with a stale expected revision produces
`AgentSessionStoreConflictError`; the manager rereads, reapplies non-conflicting changes,
and retries within a bounded policy. Database stores implement this through their native
transaction/CAS facility. The global registry revision belongs only to the default JSON
file format.

Existing `SessionStore` implementations receive a documented compatibility adapter. They
cannot claim cross-process-safe checkpoint persistence until migrated to the CAS
contract.

The default full-JSON store updates as follows:

1. Acquire cross-process exclusion.
2. Read and validate the latest primary, or visibly recover the backup.
3. Apply one mutation to the latest revision.
4. Increment the global registry revision.
5. Write a temporary sibling file with owner-only permissions.
6. flush/fsync the temporary file.
7. On updates after the first, copy the still-valid primary to a temporary backup, sync
   it, and atomically replace `agent-sessions.json.bak`; sync the directory.
8. Atomically rename the new temporary file to `agent-sessions.json`.
9. Sync the containing directory where supported.
10. Release the lock.

Two processes updating different sessions must not lose either update. A malformed
primary with a valid backup is a visible recovery. A malformed primary and backup is a
visible error, never an empty registry. Lock recovery must be bounded and tested; a
writer may not delete an apparently stale lock solely from elapsed wall time when it can
still belong to a live process.

On the first write there is no backup. During later updates, either the primary or backup
must remain valid at every crash boundary; the backup may be one or more revisions stale.

## 12. Registry API and pagination

The public listing name is deliberately explicit:

```ts
interface ListAgentSessionsOptions {
  cursor?: AgentSessionListCursor;
  limit?: number;
  order?:
    | "updated_desc"
    | "updated_asc"
    | "created_desc"
    | "created_asc";
}

interface AgentSessionListPage {
  sessions: readonly AgentSessionSummary[];
  nextCursor: AgentSessionListCursor | null;
  hasMore: boolean;
}

interface AgentSessionSummary {
  agentSessionId: string;
  adapterId: string;
  mode: "normal" | "degraded";
  model: string | null;
  title?: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  recovery: "clean" | "required";
  transcriptAvailable: boolean;
}

sessionManager.listAgentSessions(options?: ListAgentSessionsOptions):
  Promise<AgentSessionListPage>;
```

Defaults are `limit: 50` and `order: "updated_desc"`; maximum limit is 500. Ordering uses
`agentSessionId` as a deterministic tie-breaker.

`summary.recovery` reports the registry checkpoint's known status. A transcript-only
dirty tail discovered later can change it when the session is loaded; listing does not
scan every transcript.

The default full-JSON registry cursor contains the registry revision and position. If the
registry changes between pages, that cursor becomes invalid and the consumer restarts the
listing. This is preferable to silently duplicating or omitting sessions whose
`updatedAt` changed. Database-backed stores may offer stronger snapshots behind the same
opaque cursor contract.

A continuously changing registry can repeatedly invalidate `updated_*` pagination.
Consumers needing stable traversal use `created_*`, whose ordering key is immutable; the
cursor captures the newest creation boundary so later insertions do not enter the walk.
Deletion may still remove an unseen item. The API promises no historical snapshot unless
the injected store explicitly supports one.

`SessionManager.list()` may remain deprecated during migration. `AgentSession.listSessions()`
currently means a merged registry plus active harness `session/list`; it must be renamed
or clearly retained as a separate harness-discovery operation so it cannot be confused
with `listAgentSessions()`.

## 13. Transcript v2 envelope

Each v2 line is one complete JSON object:

```ts
interface TranscriptEnvelope {
  v: 2;
  t: TranscriptRecordType;
  transcriptId: string;
  generation: number;
  agentSessionId: string;
  seq: number;
  ts: number;
  operationId?: string;
  stateRevision?: number;
}
```

Invariants:

- `transcriptId` is randomly minted once for the logical transcript.
- `generation` starts at 1 and changes only when a transcript is replaced, rewritten,
  compacted, or imported into a new physical generation.
- `seq` is strictly increasing within one generation and is the canonical order.
- `ts` is display metadata, not a uniqueness or pagination key.
- Every record is immutable after append.
- An append is newline-terminated UTF-8 JSON.

Record types are:

```ts
type TranscriptRecordType =
  | "header"
  | "checkpoint"
  | "operation"
  | "message"
  | "activity"
  | "configuration"
  | "permission"
  | "transition"
  | "metering_reference"
  | "lifecycle"
  | "raw";
```

The header records schema/capture metadata without secrets. `checkpoint` contains the
exact `AgentSessionCheckpoint`. `operation` provides write-ahead and terminal boundaries.
`transition` generalizes handoff, switch, mode change, and replacement. `raw` exists only
under the diagnostic policy.

`lifecycle` in the capture policy controls nonessential, user-facing lifecycle detail.
Mandatory structural operation/checkpoint records remain present even when that capture
component is false and are hidden from non-record projections.

### 13.1 Core record schemas

The core records have concrete, versioned shapes:

```ts
interface TranscriptHeaderRecord extends TranscriptEnvelope {
  t: "header";
  event: "created" | "upgraded";
  createdAt: string;
  preset: TranscriptPreset;
  effectivePolicy: TranscriptCapturePolicy;
  upgradedFrom?: { version: 1; boundaryOffset: number };
}

interface TranscriptCheckpointRecord extends TranscriptEnvelope {
  t: "checkpoint";
  checkpoint: AgentSessionCheckpoint;
}

interface TranscriptMessageRecord extends TranscriptEnvelope {
  t: "message";
  role: "user" | "assistant";
  text: string;
  messages?: JsonValue[];
  status?: string;
  stopReason?: string;
}

interface TranscriptPermissionRecord extends TranscriptEnvelope {
  t: "permission";
  permissionId: string;
  activityId?: string;
  event: "requested" | "resolved";
  outcome?: string;
  details?: JsonValue;
}

interface TranscriptConfigurationRecord extends TranscriptEnvelope {
  t: "configuration";
  event: "announced" | "selected" | "restored" | "restore_failed";
  configId?: string;
  value?: JsonValue;
  definitions?: JsonValue;
  schemaDigest?: string;
}

interface TranscriptMeteringReferenceRecord extends TranscriptEnvelope {
  t: "metering_reference";
  operationId: string;
  meteringRecordId: string;
  status: "available" | "partial" | "unavailable";
  summary?: JsonValue;
}

interface TranscriptLifecycleRecord extends TranscriptEnvelope {
  t: "lifecycle";
  event:
    | "session_opened"
    | "stop_requested"
    | "session_stopped"
    | "transport_exited"
    | "recovery_required"
    | "recovery_resolved";
  detail?: JsonValue;
}

interface TranscriptRawRecord extends TranscriptEnvelope {
  t: "raw";
  protocol: string;
  direction: "client_to_agent" | "agent_to_client";
  event: string;
  data: JsonValue;
}
```

`details`, `summary`, and `detail` contain only information admitted by the effective
capture policy. Their presence is not permission to bypass pre-persistence filtering.
Provider usage records are referenced through the shared `operationId`; the transcript
does not become the consumer's durable billing ledger.

After the activity, operation, and transition shapes in the following sections are
included, the known-record union is:

```ts
type KnownTranscriptRecord =
  | TranscriptHeaderRecord
  | TranscriptCheckpointRecord
  | TranscriptOperationRecord
  | TranscriptMessageRecord
  | TranscriptActivityRecord
  | TranscriptConfigurationRecord
  | TranscriptPermissionRecord
  | TranscriptTransitionRecord
  | TranscriptMeteringReferenceRecord
  | TranscriptLifecycleRecord
  | TranscriptRawRecord;

interface UnknownTranscriptRecord {
  v: number;
  t: string;
  transcriptId: string;
  generation: number;
  agentSessionId: string;
  seq: number;
  ts: number;
  value: JsonObject;
}
```

An unknown record preserves the complete decoded JSON object in `value`; it is returned
only by the `records` view.

## 14. Operation records and durable boundaries

Before an operation can reach the harness, the writer must append and durably synchronize:

```ts
interface TranscriptOperationRecord extends TranscriptEnvelope {
  t: "operation";
  event: "started" | "settled" | "failed" | "cancelled" | "interrupted";
  operationId: string;
  operationKind:
    | "prompt"
    | "set_config"
    | "internal_session_command"
    | "handoff_summary"
    | "handoff_seed"
    | "switch_seed"
    | "other";
  errorCode?: string;
}
```

Normal ordering is:

```text
operation(started)
→ captured input/message records
→ durable sync
→ publish checkpoint(in_flight, cause=operation_started) to registry
→ send work to harness
→ messages/activity/etc.
→ operation(settled|failed|cancelled)
→ checkpoint(settled)
→ durable sync
→ publish the same checkpoint to the registry
```

If a transport failure, harness exit, or host interrupt is observed:

```text
partial events
→ operation(interrupted), best effort
→ checkpoint(in_flight), best effort
→ durable sync, best effort
→ publish checkpoint to registry, best effort
```

The initial checkpoint is written immediately after the internal session is established.
Every operation that reaches a stateful harness receives a terminal boundary and a later
settled checkpoint, regardless of whether the response appears to have changed state. A
checkpoint is also written after handoff, switch, mode/model change, and reconciliation.

Creation resolves paths, validates existing artifacts, and acquires writer ownership
before spawning the harness. If the harness creates an internal session but the initial
checkpoint or registry record cannot be committed, creation fails, stops the harness
best effort, and does not publish a usable logical session. The error may report the
orphaned internal-session ID for explicit cleanup; the library does not pretend it never
existed.

An idle `stop()` first rejects work not yet dispatched, flushes transcript state, makes the
latest checkpoint durable, and only then starts transport teardown. An active `stop()`
requests interruption, waits for the operation to settle or the transport to exit,
writes an interrupted or terminal boundary and checkpoint, synchronizes it, and then
finishes teardown. Work removed from the queue without dispatch never receives a
write-ahead start record. A separate force-stop API may skip waiting, but necessarily
leaves an in-flight recovery boundary.

A duplicate checkpoint is unnecessary when nothing changed. Session-affecting caught
errors attempt the failure boundary; consumer-listener exceptions do not create fake
recovery records.

The durability requirement is stronger than `appendFile`: the implementation requests
file synchronization at operation boundaries. It must not send provider work if the
write-ahead marker could not be made durable under the configured persistence contract.

Every enabled continuation store receives the write-ahead fact before dispatch. When
transcripts are disabled but the registry is enabled, it exists only as the `in_flight`
registry checkpoint. When the registry is disabled, it exists only as the transcript
operation record. If one required pre-dispatch persistence write fails, provider work is
not sent; the writer best-effort closes any already-written marker as not dispatched.

When both library stores are disabled, the library cannot promise crash recovery; a
consumer requiring it must durably store emitted checkpoints before permitting dispatch
through its own integration.

No process can write after `SIGKILL`, sudden power loss, kernel failure, or storage loss.
The write-ahead record makes the last durable state interpretable after those events; it
does not create exactly-once execution.

## 15. Messages and turns

Messages retain structured assistant boundaries when available. Every message record is
associated with an `operationId`; internal summary and seeding prompts are not presented
as user-authored conversation messages.

The operation records, rather than adjacency of user and assistant lines, delimit the
durable turn. This supports partial responses and interleaved activity without inventing
an assistant message after a crash.

Here, a checkpoint boundary of `settled` means the operation's persistence boundary is
fully recorded. The operation itself may have succeeded, failed, or been cancelled.

Capture policy may remove message content entirely. Structural operation/checkpoint
records remain valid in that case.

## 16. Activity lifecycle

The current useful lifecycle is preserved. A tool normally produces two or three
full-state records under one stable `activityId`:

```text
announced → input/in-progress checkpoint(s) → settled
                                      \------→ flushed while still open
```

V2 does not reduce this to terminal calls. Within one ACP prompt/operation, a tool may
remain active for a long time while response chunks and unrelated activity records are
appended between its revisions. Ending that operation flushes the activity under the
current implementation; this version does not claim that one activity continues across
separate prompts.

```ts
interface TranscriptActivityRecord extends TranscriptEnvelope {
  t: "activity";
  activityId: string;
  activityRevision: number;
  operationId: string;
  reason: "announced" | "input" | "settled" | "flushed" | "snapshot";
  kind: string;
  status?: string;
  data: Record<string, JsonValue>;
  truncated?: boolean;
}
```

Rules:

- Revisions increase monotonically per `activityId`.
- Every persisted revision is a complete policy-filtered snapshot, never a patch that
  requires an earlier page.
- The greatest revision observed is the known state.
- `flushed` means the turn ended while the activity was still open. It is not a fabricated
  completion or failure.
- Missing terminal state remains meaningful evidence that completion was not observed.
- Repeated progress checkpoints are allowed.
- `settled` is emitted only for a terminal status recognized by the normalizer. V1
  recognizes `completed` and `failed`. A cancellation becomes settled only when ACP or a
  certified adapter explicitly reports it as terminal; a locally interrupted open tool
  is `flushed`, not silently recast as cancelled.
- Raw high-frequency deltas, including thinking chunks, are retained only when the
  diagnostic policy explicitly captures them.

Consumers apply activity records as upserts. They must not assume lifecycle revisions are
adjacent or present on the same transcript page.

### 16.1 Live and historical state

A persisted open activity is not proof that a tool is still executing after restoration.
The library distinguishes:

```ts
type ActivityExecutionState =
  | "observed_live"
  | "historically_open"
  | "terminal";
```

The existing live `AgentSession.activitySnapshot()` continues to expose the current
in-memory turn as `ActivitySnapshot`. An offline reader uses a distinct type and folds the
latest revision of each activity at a transcript cursor:

```ts
interface PersistedActivityState {
  activityId: string;
  activityRevision: number;
  operationId: string;
  reason: TranscriptActivityRecord["reason"];
  kind: string;
  status?: string;
  data: JsonObject;
  execution: ActivityExecutionState;
}

interface ListTranscriptActivitiesOptions {
  at?: TranscriptCursor;
  status?: "open" | "terminal" | "all";
  limit?: number;
}

transcriptReader.listActivityStates(
  options?: ListTranscriptActivitiesOptions,
): Promise<readonly PersistedActivityState[]>;
```

The initial offline implementation may scan with bounded memory, retaining only the
latest requested activities. A later disposable index may optimize this. It must not
become a source of truth.

## 17. Handoff and switch transitions

A transition is multi-phase and remains under one stable `agentSessionId`:

```ts
interface TranscriptTransitionRecord extends TranscriptEnvelope {
  t: "transition";
  transitionId: string;
  kind: "handoff" | "switch" | "mode_change" | "replacement";
  event: "started" | "target_created" | "completed" | "failed";
  from: InternalSessionDescriptor | null;
  to?: InternalSessionDescriptor;
  summary?: string;
  errorCode?: string;
}

interface InternalSessionDescriptor {
  internalSessionId: string | null;
  adapterId: string;
  mode: "normal" | "degraded";
  model: string | null;
  protocol:
    | { name: "acp"; version: number }
    | { name: "pty" };
}
```

Summary and continuation content is persisted only when the effective transition policy
is `content`. Identifiers and state changes remain structural.

The checkpoint must reflect the thread the object would actually use next. If a handoff
creates and installs a new internal session but continuation seeding fails, the new
internal session remains current and the failed checkpoint records that partial
transition. It must not silently roll back to the old ID.

`transitionId` is the public `handoffId` or `switchId`. Each physical reached-harness
child has its own operation ID, deterministically `${transitionId}:summary` and
`${transitionId}:seed` for handoff. A transition record is the parent orchestration
boundary; it is not itself counted as a provider operation. Every child that reaches the
harness receives its own start, terminal, metering record, and subsequent checkpoint.
This makes a crash between target creation and seeding reconstructable without pretending
the compound transition was atomic.

## 18. Transcript pagination

The public reader uses opaque cursors rather than timestamps:

```ts
type TranscriptView = "conversation" | "timeline" | "records";

interface ReadTranscriptPageOptions {
  cursor?: TranscriptCursor;
  limit?: number;
  view?: TranscriptView;
  types?: readonly TranscriptRecordType[];
}

interface TranscriptPage<T> {
  items: readonly T[];
  olderCursor: TranscriptCursor | null;
  newerCursor: TranscriptCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
}

type TranscriptConversationItem = TranscriptMessageRecord;

type TranscriptTimelineItem =
  | TranscriptMessageRecord
  | TranscriptActivityRecord
  | TranscriptConfigurationRecord
  | TranscriptPermissionRecord
  | TranscriptTransitionRecord
  | TranscriptMeteringReferenceRecord
  | TranscriptLifecycleRecord;

interface TranscriptReader {
  readPage(options?: ReadTranscriptPageOptions & { view?: "timeline" }):
    Promise<TranscriptPage<TranscriptTimelineItem>>;
  readPage(options: ReadTranscriptPageOptions & { view: "conversation" }):
    Promise<TranscriptPage<TranscriptConversationItem>>;
  readPage(options: ReadTranscriptPageOptions & { view: "records" }):
    Promise<TranscriptPage<KnownTranscriptRecord | UnknownTranscriptRecord>>;
}
```

Defaults are `limit: 50` and `view: "timeline"`; maximum limit is 500. The first request
selects the newest matching items. Items within every page are returned oldest-to-newest
for direct rendering. `olderCursor` pages backward; `newerCursor` navigates forward
within the same snapshot.

Views:

- `conversation`: user and assistant message projections.
- `timeline`: messages, every captured activity lifecycle revision, permissions,
  transitions, failures, and usage summaries.
- `records`: every structurally readable stored record, including
  checkpoints and control records. The name avoids confusing persisted records with raw
  ACP traffic.

The limit counts returned projected items, not physical JSONL lines. Readers may scan
additional records to satisfy a filtered page.

`types` is valid only with `view: "records"`. Supplying it with `conversation` or
`timeline` is rejected rather than producing a cursor whose projection is ambiguous.

`limit` must be an integer from 1 through 500. Zero, negative, fractional, non-finite,
and oversized values are rejected rather than silently clamped.

For a returned page, `hasOlder` means at least one matching item exists before the first
item and `olderCursor` is non-null exactly in that case. `hasNewer` means at least one
matching item exists after the last item but at or before the snapshot high-water mark;
`newerCursor` is non-null exactly in that case. Reverse navigation must not overlap the
boundary item with the prior page.

### 18.1 Snapshot behavior

The first page captures the byte position and sequence of the last complete record.
Subsequent cursors retain that high-water mark. Concurrent appends do not unexpectedly
appear while paging through the snapshot.

Live additions are delivered through `AgentSession` listeners. A later
`readTranscriptSince(cursor)` may support catch-up/polling, but it is distinct from
historical pagination.

### 18.2 Cursor contract

Cursors are opaque, validated, bounded-size tokens. An implementation cursor may encode:

- cursor schema version;
- transcript ID and generation;
- snapshot high-water sequence and byte offset;
- current boundary sequence and byte offset;
- view/filter fingerprint;
- boundary digest.

Base64url is encoding, not secrecy. Cursors must never contain a filesystem path, prompt,
or other sensitive content. All decoded offsets, lengths, versions, and identities are
validated before filesystem access.

A cursor is invalid when:

- used with a different transcript, generation, view, or filter;
- the file was truncated, replaced, compacted, or rewritten;
- content at or before its boundary was modified;
- its version is unsupported or its payload malformed.

The reader throws `TranscriptCursorInvalidError`; it never silently restarts at the newest
page.

## 19. Transcript mutation, corruption, and generations

The active transcript is append-only. A complete malformed v2 line in the middle of the
file is a visible `TranscriptCorruptionError`. An incomplete trailing line is ignored for
reads and may be truncated to the last complete newline before the next append under an
exclusive writer lock.

A missing or unreadable v2 transcript is a typed not-found or I/O error. Returning an
empty array remains only a legacy v1-reader compatibility behavior.

Unknown future record types with a valid envelope are skipped by projected views and can
be returned as unknown records by the `records` view. Unsupported envelope versions are
reported, not interpreted as a known type.

Rewriting, compaction, redaction, or importing creates a new generation. It may preserve
the logical `transcriptId`, but it increments `generation`, resets physical sequence
according to the rewrite contract, and invalidates old cursors. In-place editing without
a generation transition is corruption.

The writer enforces one active append owner per transcript. Two live `AgentSession`
objects must not append independently to the same generation.

The default writer acquires a transcript-lifetime lock before starting the harness and
holds it until all final writes are synchronized. Failure to acquire it fails session
creation/opening before provider work. Lock ownership records a random nonce and process
identity; recovery requires evidence the owner is gone and follows the same non-time-only
stale-lock rule as the registry.

A corruption diagnostic cannot be appended to the generation declared corrupt. It is
emitted through the logger/listener and, if the consumer chooses repair, recorded in the
new generation created by that repair.

## 20. Recovery after an unclean boundary

Opening a clean settled checkpoint requires no reconciliation. Either an
`operation(started)` without a terminal record or a terminal record not covered by a
later checkpoint is a dirty boundary. The library and harness may have diverged: the
harness may have persisted a response or executed tool side effects after the last
library fsync.

Restoration enters a non-promptable recovery state:

```ts
type SessionRecoveryStatus =
  | { kind: "clean" }
  | {
      kind: "reconciled";
      operationId: string;
      recoveredRecords: number;
    }
  | {
      kind: "uncertain";
      operationId: string;
      boundary:
        | "started_without_terminal"
        | "terminal_without_checkpoint"
        | "in_flight_checkpoint";
      reason:
        | "history_unavailable"
        | "history_mismatch"
        | "harness_session_missing"
        | "configuration_mismatch";
    };
```

Replay is evidence only when the adapter declares its recovery grade:

```ts
interface AdapterRecoverySupport {
  replay: "certified" | "observable" | "none";
  certificationId?: string;
}
```

`certified` means the pinned adapter/harness combination has a tested completeness marker,
stable event identities, and a canonical comparison projection defined by that adapter.
The projection includes operation/message/activity identity and normalized content digests
permitted by the capture policy. Certification must account for hidden handoff summary
and seed operations. A generic ACP `loadSession` capability is not certification: ACP does
not guarantee complete replay or comparable stable identifiers.

If the effective capture policy omitted fields required by that certified comparison,
the replay cannot establish equality and recovery remains uncertain. Certification does
not override capture policy or recover data the library deliberately chose not to store.

With certified replay, the library:

1. Loads the recorded current `internalSessionId` using the replay-capable path.
2. Compares replayed history with the last settled transcript boundary.
3. Appends observable missing information as explicitly recovered records.
4. Requires the adapter's replay-complete marker and exact agreement through the last
   settled local fingerprint.
5. Appends a reconciliation transition and a new settled checkpoint.
6. Publishes that checkpoint to the registry.

Recovered records include provenance and must not pretend they were observed live:

```ts
interface TranscriptRecoveryProvenance {
  recoveredAt: string;
  operationId: string;
  source: "harness_history";
}
```

ACP `loadSession` can expose observable replay when supported; `resumeSession` does not
provide equivalent evidence. Without a certified adapter contract, recovered replay may
be appended as useful evidence but the state remains `uncertain`. Successful load or
resume alone cannot prove reconciliation.

If history is missing, mismatched, or unavailable, the session remains uncertain until
the consumer resolves it:

```ts
await session.resolveRecovery({ strategy: "accept_harness_state" });

await session.resolveRecovery({
  strategy: "start_new_internal_session",
  continuation?: string,
});
```

The first strategy records and accepts a known transcript gap. The second starts a new
thread from known context; if capture policy did not retain sufficient context, the
consumer must supply continuation content. Aborting and leaving the session unopened is
always valid.

No strategy claims to undo external side effects. The library must reject prompts,
handoffs, switches, and internal-session commands while recovery is unresolved.

Session recovery is distinct from `reconcileMetering()`. A crash may require both, but
their evidence and audit records remain separate.

## 21. Transcript and registry failures

Default persistence is part of session correctness, not optional logging. Failure to
durably write an operation-start record prevents dispatch. Failure to persist a terminal
checkpoint preserves the already-produced operation result but marks the session
recovery state uncertain and blocks another state-changing operation until persistence is
repaired or explicitly disabled by creating a differently configured session.

Registry publication failure after a durable transcript checkpoint does not invalidate
the checkpoint. It emits a persistence notification and can be repaired from the
transcript. Transcript failure with a successfully published registry checkpoint creates
an observable transcript gap.

Persistence errors use typed errors and notifications. They must not be reduced to debug
logs or silently converted to an empty registry/transcript.

## 22. Lifecycle and deletion

Detailed retention, export, and import policy is deferred, but destructive boundaries are
defined now:

- Removing a registry record does not delete its transcript by default.
- Deleting a transcript does not silently remove its registry record.
- A combined deletion requires an explicit option naming both targets.
- Handoff and switch update one registry entry; they never create a new logical session.
- A session with transcripts disabled remains discoverable when its registry is enabled.
- An unregistered transcript is importable but is not automatically a known session.

## 23. Compatibility and migration

The following existing inputs become deprecated and normalize into the new model where
semantics are equivalent:

- `transcriptPath`;
- `transcriptDir`;
- `transcriptActivity`;
- direct `sessions`/`SessionManager` wiring;
- direct `internalSessionId` in favor of provider-session intent or checkpoint restore.

Important compatibility rules:

1. Legacy transcript path options remain history-only. They must not begin implicitly
   restoring a provider thread during the deprecation period.
2. Existing v1 readers and public types remain available initially.
3. V1 activity remains last-write-wins on `recordId`, including `announced`, `input`,
   `settled`, and nonterminal `flushed` semantics.
4. V1's permissive malformed/unknown-line behavior remains confined to v1. V2 adopts the
   stricter corruption contract.
5. `readTranscript()` remains the legacy message projection. The cursor API is added
   alongside timestamp-based `before` pagination before the latter is removed.
6. The old file-per-session registry under `~/.acp-lib/sessions` is not silently combined
   with the new registry.

An explicit migration utility imports old session records and reports conflicts. When a
v2 writer opens an existing v1 transcript intentionally, it appends a v2 upgrade header
with a new `transcriptId` and generation rather than rewriting old history. V1 records
before that boundary remain readable under v1 rules; all later records use v2 rules and
sequence numbers. A mixed-file cursor uses byte boundaries so older v1 records can still
be paged.

The upgrade header stores the exact byte offset at which v2 begins. The prefix is treated
as generation 0 with a synthetic identity derived from the v2 transcript ID; v1 ordering
inside that prefix is physical-line order, not timestamp order. A cursor may cross from
generation 1 into this explicitly linked legacy prefix. It may not cross between unrelated
v2 generations. Cursor validation therefore carries both the active generation and the
declared legacy-prefix identity.

Before appending the upgrade header, the writer validates that the file has no existing
v2 header for another logical session, truncates only an incomplete final v1 line under
the exclusive writer lock, and synchronizes that repair. A malformed complete line after
the recorded v2 boundary is v2 corruption even when it cannot be parsed far enough to
reveal a `v` member.

Supplying any deprecated transcript/session-store option selects compatibility
normalization: only the facilities explicitly requested by legacy options are enabled;
the new default registry is not added implicitly. Tests and applications relying on no
persistence must adopt `persistence: false` before the new default behavior is released.

Because omitted persistence changes from no disk writes to default persistence, this
configuration change must be prominently called out in release notes and versioned as a
breaking behavioral change if semantic-versioning policy requires it.

## 24. Performance and bounded state

- The active writer serializes appends but does not retain transcript history in memory.
- Activity streaming may remain asynchronous, but every queued activity write must settle
  before its operation terminal/checkpoint is synchronized.
- Reads use backward byte chunks and decode complete UTF-8 lines; they do not load the
  complete transcript merely to return the newest page.
- `listActivityStates()` may retain one latest policy-filtered record per relevant activity;
  this is an explicit potentially-large query, distinct from a normal page read.
- Full export is exposed as an async iterator with bounded memory.
- A sparse sidecar index may be introduced later. It is disposable, rebuildable, and
  never authoritative.
- Transcript segmentation is deferred. Opaque cursors allow a later segmented
  implementation without changing the public pagination API.
- The default JSON registry is appropriate for a local catalog but rewrites the whole
  registry on mutation. Large/multi-tenant consumers should inject a database store.

## 25. Notifications

At minimum, the session-level notification stream gains events for:

- checkpoint persisted;
- persistence failure;
- registry recovered from backup;
- registry repaired from transcript;
- recovery required;
- recovery reconciled;
- recovery explicitly accepted with uncertainty;
- transcript corruption or cursor invalidation when relevant to a live reader.

Listener exceptions remain observation failures. They never roll back persistence,
change the session state, or manufacture operation failure records.

## 26. Required tests

### Configuration and capture

- Default root, environment override, and explicit-root precedence.
- `SessionManager.open()` sees sessions created directly through the equivalent default
  configuration.
- `create()` never restores and `open()` never creates a missing logical session.
- Conflicting identity candidates fail instead of applying identifier/path precedence.
- `persistence: false`, registry-only, transcript-only, and both-enabled behavior.
- Existing directory, existing file, nonexistent file, and invalid filesystem path.
- Absolute normalization, tilde expansion, and default-store symlink rejection.
- Every preset matches the exact matrix.
- Component overrides win over presets.
- `activity` never writes command text, paths, arguments, outputs, diffs, raw errors, or
  unknown payloads.
- Filtering occurs before enqueue/write and not only during reading.
- Debug logging never enables diagnostic capture.
- Typed session-config selections such as model/reasoning are checkpointed by default;
  unknown and excluded values are absent.
- `configuration: "selections"` omits option definitions, while `definitions` preserves
  the policy-filtered announced catalog.

### Registry

- Concurrent promises and separate processes updating distinct IDs lose no records.
- Same-ID updates remain valid and revisions are monotonic.
- Unrelated records, consumer metadata, and recognized-version unknown fields survive.
- Termination during temp write/rename leaves the primary or backup recoverable.
- Malformed primary recovers visibly from a valid backup.
- Malformed primary and backup fail visibly.
- Lock recovery cannot steal a provably live lock.
- Unknown registry versions fail before mutation.
- Handoff/switch update one logical record and preserve internal history.
- `listAgentSessions()` ordering, limits, ties, and cursor invalidation are deterministic.

### Checkpoints and durability

- Initial session creation writes a checkpoint.
- Every settled operation produces a later durable checkpoint.
- Successful `setConfig()` updates desired/effective selections, normalized model,
  checkpoint, and registry before resolving.
- A post-ACP config persistence failure is reported as changed-but-unpersisted and blocks
  later state mutation.
- Open reapplies desired selections in order; disappeared/rejected options enter
  `configuration_mismatch` recovery.
- Same-adapter handoff carries desired selections before seeding; cross-adapter switch
  requires an explicit mapping.
- Reconcile, stop, and reopen retain the same revision and state.
- Transcript and registry copies use the identical checkpoint digest.
- Transcript-newer repairs registry; registry-newer reports a transcript gap.
- Equal revision with unequal digest fails.
- Dispatch never occurs when the start marker cannot be synchronized.
- Registry-only mode persists in-flight state before dispatch; `persistence: false`
  explicitly does not claim a durable crash boundary.
- Terminal checkpoint waits for preceding asynchronous activity writes.
- Clean stop flushes all writes.
- Active stop records the terminal/interrupted boundary before teardown; force stop leaves
  an in-flight boundary.

### Crash and power-loss simulation

- Crash before durable start produces no dispatched operation.
- Crash after start and before dispatch restores as in-flight.
- Crash after harness dispatch and before terminal restores as in-flight.
- Crash after terminal but before checkpoint uses the preceding checkpoint and detects the
  uncovered terminal boundary.
- Crash after transcript checkpoint but before registry publication repairs registry.
- A torn final line is ignored; a malformed complete v2 middle line is corruption.
- Certified replay can reconcile; merely observable replay imports evidence but remains
  uncertain.
- Resume without replay remains uncertain.
- No prompt is accepted until uncertain recovery is resolved.
- Accepting harness state records the gap; starting a new thread records the transition.

### Activity and pagination

- Announced, input/progress, settled, and flushed activity revisions are preserved.
- A long-running activity can span many response/activity events, pages, and byte chunks
  within one operation.
- Each revision renders independently when its announcement is on an older page.
- Folded state uses greatest revision and distinguishes historical-open from live.
- Equal timestamps do not affect ordering.
- First page returns newest matches in oldest-to-newest display order.
- Limit counts projected items, not physical records.
- Concurrent append does not alter an existing pagination snapshot.
- Reusing a cursor with another view/filter/transcript fails.
- Truncation, replacement, rewrite, and generation change invalidate old cursors.
- Cursor validation rejects hostile offsets and oversized payloads.
- Async iteration remains bounded on a very large transcript.
- A second live writer cannot acquire the same transcript generation.

### Migration

- V1 message and structured-message projections remain readable.
- V1 raw activity without fold keys remains non-foldable.
- V1 malformed/unknown lines retain legacy permissive behavior.
- A v2 upgrade header allows continued append without rewriting v1 history.
- Legacy registry import is explicit, idempotent, and conflict-reporting.
- Deprecated configuration retains history-only startup behavior.
- Deprecated options do not implicitly create the new default registry or root.

## 27. Implementation order

1. Introduce the public configuration, preset expansion, v2 schemas, checkpoint digest,
   typed errors, and compatibility normalization.
2. Implement the central atomic registry and `listAgentSessions()` pagination.
3. Implement the v2 writer, pre-persistence filtering, sequencing, and durable flush.
4. Add operation write-ahead records and checkpoint publication ordering.
5. Add checkpoint-based open/restore and adapter-assisted recovery state.
6. Add cursor transcript reads, projections, activity folding, and bounded iteration.
7. Add migration utilities and mixed v1/v2 reading.
8. Integrate CLI presentation only after the consumer-facing APIs are stable.

## 28. Deferred work

- Automatic retention policies and transcript rotation/segmentation.
- Transcript compaction and redaction rewrite tools.
- Tamper-resistant audit storage or HMAC key management.
- Billing truth; the metering specification deliberately assigns durable accounting to
  the consumer.
- General automatic discovery/import of arbitrary harness sessions.
- Exactly-once recovery of provider calls or external tool side effects, which neither
  ACP nor local filesystem checkpoints can guarantee.
