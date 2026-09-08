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
- **Registry**: the authoritative inventory and discovery catalog of managed logical
  agent sessions. In registry-only mode it also holds continuation state.
- **Transcript**: an append-only JSONL history for one logical agent session.
- **Checkpoint**: a versioned, serializable snapshot sufficient to reconstruct the
  library's last known continuation state.
- **Operation boundary**: the durable start or end of an operation which can reach the
  harness or provider.
- **Clean boundary**: the latest operation is durably settled and covered by a checkpoint.
- **In-flight boundary**: an operation was durably recorded as started but was not durably
  recorded as settled.

The registry is authoritative for managed-session discovery. When a transcript is
enabled, its latest valid checkpoint and journal tail are authoritative for continuation;
the registry checkpoint is a materialized projection. In registry-only mode the registry
checkpoint is authoritative for continuation. A transcript is authoritative only for the
events the library actually persisted. None is an invoice, a tamper-resistant audit
ledger, or proof that an external tool side effect did not occur.

## 3. Public configuration and ownership

The registry belongs to `SessionManager`. Transcript and ACP configuration persistence
belong to each individual `AgentSession`. A manager can supply session defaults, but it
does not impose one transcript destination or capture policy on every session.

```ts
type TranscriptPreset =
  | "conversation"
  | "activity"
  | "detailed"
  | "diagnostic";

interface TranscriptConfig {
  path?: string;
  preset?: TranscriptPreset;
  capture?: Partial<TranscriptCapturePolicy>;
}

interface SessionConfigurationPersistenceConfig {
  /** Controls which ACP session-config values enter restoration state. */
  values?: "none" | "typed" | "all";
  /** Explicitly persist these IDs even when their type is unknown. */
  include?: readonly string[];
  /** Never persist these IDs; exclusion wins over inclusion. */
  exclude?: readonly string[];
}

interface AgentSessionPersistenceOptions {
  /** Base for a direct session's default transcript path. */
  root?: string;
  transcript?: false | TranscriptConfig;
  sessionConfiguration?: SessionConfigurationPersistenceConfig;
}

type ManagedSessionPersistenceOptions = Omit<
  AgentSessionPersistenceOptions,
  "root"
>;

interface AgentSessionConfig {
  // Existing runtime configuration...
  /** Direct AgentSession usage defaults to false. */
  persistence?: false | AgentSessionPersistenceOptions;
}

interface SessionManagerConfig {
  /** Registry/default-transcript root. */
  root?: string;
  /** Omit for the default central JSON registry. */
  store?: AgentSessionStore;
  /** Defaults only; every create call may override them. */
  sessionDefaults?: ManagedSessionPersistenceOptions;
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

Direct low-level usage performs no persistence unless explicitly requested:

```ts
await AgentSession.create({
  adapter,
  adapterId,
  persistence: false,
});
```

Managed creation through `SessionManager` always records the logical session in that
manager's registry. Its default per-session persistence is:

```ts
{
  transcript: { preset: "activity" },
  sessionConfiguration: { values: "typed" },
}
```

For managed creation, effective per-session persistence is resolved in this order:

1. The individual `createAgentSession()` option.
2. `SessionManagerConfig.sessionDefaults`.
3. The managed library default above.

An explicit per-session `transcript: false` always wins. It disables that session's
transcript without removing the session from the manager registry.

The manager owns its registry and root. A managed session cannot move either through a
per-session option. It may select an arbitrary transcript destination with
`transcript.path`, or override its transcript preset, capture policy, and ACP
configuration-persistence policy. This keeps one manager's inventory coherent while
preserving genuinely per-session transcript placement.

V0 exposes no buffered durability option. Managed persistence uses durable operation
boundaries; direct sessions with persistence disabled make no durability guarantee. The
rationale and deferred weaker-mode design are recorded in `9-6-NOTE-durability.md`.

Default persistence is intentionally visible in documentation because it writes
conversation content to disk. Applications should normally set an application-specific
root, define manager defaults, or choose transcript behavior for every session.
Directories and files created by the default store must be owner-only where the platform
supports permissions.

The manager root, or a direct session's default-transcript root, is resolved in this
order:

1. `SessionManagerConfig.root` or the explicit direct-session transcript root.
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

If `path` is omitted, the library creates and uses the `transcripts` directory under the
effective root. A managed session uses the manager root; a direct session uses its
explicit persistence root and then the environment/home default.

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

const opened = await AgentSession.open({
  agentSessionId: optionalWhenCheckpointOrExactFileIdentifiesIt,
  persistence,
  checkpoint: optionalConsumerCheckpoint,
  adapter,
  adapterId,
  continuation: {
    // Omit for the default: only try the recorded internal session.
    strategies: optionalOrderedContinuationStrategies,
  },
});
```

Direct `create()` always requests a new internal harness session. If its resolved
transcript belongs to another logical session, creation fails with
`AgentSessionAlreadyExistsError`. It never silently resumes or appends to an unrelated
transcript. Direct use has no implicit registry.

Direct `open()` reconstructs from an explicit consumer checkpoint and/or transcript. It
applies the consistency rules in section 10 to those supplied artifacts and returns the
session together with an explicit continuation report; it never hides a failed attempt
to load the prior internal thread.

`open()` requires at least one unambiguous identity source: an `agentSessionId`, an
explicit checkpoint, or an exact existing transcript file configured through
`persistence.transcript.path`. Opening from a directory requires `agentSessionId` so the
filename can be derived. Opening a missing path fails; only `create()` creates a new
logical session.

The consumer supplies the adapter object for every create or open operation. Persistence
stores `adapterId` as routing metadata; neither a checkpoint nor `SessionManager`
constructs, owns, or globally resolves adapter instances. This avoids embedding process
commands or consumer dependency policy in the persistence layer. Persisted command lines
are never blindly executed.

Managed creation and loading go through the manager:

```ts
const sessions = await SessionManager.open({
  root: "/absolute/path/to/acp-data",
  sessionDefaults: {
    transcript: {
      path: "/absolute/path/to/default-transcripts",
      preset: "activity",
    },
  },
});

const page = await sessions.listAgentSessions();

const created = await sessions.createAgentSession({
  adapterId: "claude",
  adapter: claudeAdapter,
  persistence: {
    // Per-session choice overrides manager defaults.
    transcript: {
      path: "/customers/alice/transcripts",
      preset: "detailed",
    },
  },
});

const registryOnly = await sessions.createAgentSession({
  adapterId: "codex",
  adapter: codexAdapter,
  persistence: { transcript: false },
});

const info = await sessions.getAgentSessionInfo(created.agentSessionId);
const loaded = await sessions.loadAgentSession(created.agentSessionId, {
  adapterId: info.adapterId,
  adapter: resolveAdapter(info.adapterId),
});
```

`SessionManager.createAgentSession()` resolves persistence inputs, receives the adapter
for that operation, calls the lower-level constructor, and records the resulting logical
session. It does not retain the live object, resolve future adapters, or proxy session
methods; the consumer remains the owner. The manager owns the registry, while the
returned session owns its transcript writer and effective capture policy.

`loadAgentSession(agentSessionId)` reads that session's resolved transcript path and
policy from its registry record and requires an adapter for that load operation. It does
not accept a casual transcript override. Relocation is an explicit operation which
creates a new checkpoint revision. Providing a bare `internalSessionId` remains a
lower-level provider-thread operation, not restoration of a logical `AgentSession`.

If the supplied `adapterId` equals the persisted `adapterId`, restoration attempts the
normal adapter `loadSession(internalSessionId)` path. A different adapter object or
version under the same stable adapter identity is allowed to try; compatibility is
determined by the load result rather than speculative version checks. If the IDs differ,
ordinary restoration fails before harness startup with `AdapterMismatchError`. Continuing
the same logical session through a different adapter is an explicit switch or transcript
reconstruction operation, never an accidental load.

Both `AgentSession.open()` and `SessionManager.loadAgentSession()` return
`AgentSessionOpenResult`, defined in section 20. Consumers therefore learn whether the
recorded thread loaded, whether it was unavailable, which explicit fallback ran, and
which internal thread became active. When no strategy succeeds, the typed thrown error
carries the same partial continuation report. Opening-time notifications duplicate this
information for observers but are not the sole delivery mechanism: a listener may not
yet be attached to the returned session.

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
  deletion?: {
    /** Logical tombstone time; its presence prevents accidental ID reuse. */
    deletedAt: string;
    /** Present when transcript deletion was explicitly requested and completed. */
    transcriptDeletedAt?: string;
  };
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

Routing fields duplicated outside `checkpoint` are indexed/materialized projections for
listing. Every duplicated field must equal its checkpoint counterpart. Full
`internalSessionHistory` is the exception: it is intentionally not a checkpoint member
and is validated against its revision/digest plus transcript transitions when available.
A mismatch is registry corruption, not a last-write-wins choice.

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

The registry retains this history as a listing/registry-only projection. When transcripts
are enabled, the canonical history is reconstructed from transition records. The complete
history is deliberately excluded from every continuation checkpoint so checkpoint size
and digest work remain bounded as a logical session accumulates transitions.

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
  /** Digest/revision of history, for corruption consistency rather than restoration. */
  internalSessionHistoryRevision: number;
  internalSessionHistoryDigest: string;
  lastTransition?: {
    transitionId: string;
    kind: "handoff" | "switch" | "mode_change" | "replacement";
    at: string;
  };
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

`internalSessionHistoryRevision` and `internalSessionHistoryDigest` detect disagreement
with the registry projection or transcript-derived transition history. They are not a
recovery input and do not replace transition records. In transcript-enabled mode, history
is rebuilt from those records; in registry-only mode, the registry owns both the history
projection and its checkpoint consistency fields.

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
  /** Last announced IDs, retained so schema mismatches can identify missing options. */
  announcedConfigIds: readonly string[];
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
one ordinal pass only when they differ, validating the option after every response
because one option can change the remaining schema. Reapplication never iterates toward
a fixed point: if a later selection changes an earlier one, the residual difference is a
configuration mismatch. Reapplication happens before any prompt or handoff seed.

If a desired option disappeared, its value is no longer allowed, reapplication is
rejected, or an omitted value prevents exact comparison, configuration restoration is
`mismatch` and the session is non-promptable. This is distinct from an uncertain crash
boundary. The consumer may accept the harness's current configuration, provide
replacement selections, start a new internal session, or abort.

During same-adapter handoff, desired selections carry to the new internal session and are
applied before continuation seeding. Across an adapter switch they do not transfer unless
the switch request or consumer supplies an explicit mapping; config IDs are not portable
between harnesses. The old configuration snapshot remains in the registry history and
the corresponding transcript transition record; it is not copied into every later
checkpoint.

## 10. Authority and persistence combinations

The supported combinations are:

| Registry | Transcript | Reopen source | Discovery |
| --- | --- | --- | --- |
| enabled | enabled | transcript checkpoint and journal tail | registry |
| enabled | disabled | registry checkpoint | registry |
| disabled | enabled | latest valid transcript checkpoint | consumer-supplied path |
| disabled | disabled | consumer-supplied checkpoint | consumer |

With neither facility enabled:

- creating a new session remains supported;
- reopening requires a consumer-supplied `AgentSessionCheckpoint` and consumer-supplied
  adapter;
- providing only `agentSessionId` is insufficient and must fail before starting a
  harness.

The registry is the managed inventory source of truth. Transcript-directory scanning is
an explicit recovery/import utility, never implicit session discovery. Authority is
conditional rather than shared:

- with both stores, the registry discovers and locates the session while the transcript
  owns continuation;
- with only the registry, its checkpoint owns continuation;
- with only the transcript, the consumer supplies discovery and the transcript owns
  continuation;
- with neither, the consumer supplies both discovery and a checkpoint.

Restoration examines `(checkpoint, journal tail)`, not the checkpoint alone. The journal
tail is every structurally valid operation/transition record after
`checkpoint.transcript.coveredSequence`. It determines whether the checkpoint is clean,
has an uncovered terminal operation, or has an operation that only started. A registry-
only session expresses the equivalent tail state by publishing an in-flight checkpoint
before dispatch.

When both stores contain checkpoints, the transcript checkpoint and journal tail decide
continuation. The registry copy is validated as a projection:

1. Same revision and digest means the projection is current.
2. A transcript-newer revision is used and repairs the registry observably.
3. For a registry-newer in-flight revision, the library deterministically reconstructs
   the expected in-flight checkpoint from the authoritative transcript checkpoint and
   its journal tail. The registry revision is accepted only as a matching projection when
   every reconstructed field and its digest match. Continuation still comes from the
   transcript-derived state.
4. Any other registry-newer revision is never selected over the transcript. It reports a
   persistence gap and enters uncertain recovery.
5. Same revision with different digest is a checkpoint conflict.
6. Different logical identities or transcript generations are an identity error; they
   are never merged.

These rules acknowledge that two files cannot be atomically committed together without
turning both into competing authorities. The writer creates one immutable checkpoint
object for publication to both, but a registry projection cannot overwrite or invent
transcript continuation state merely because its numeric revision is greater.

If a registry record declares a non-null transcript, that transcript is required for
managed restoration. A missing file produces `TranscriptNotFoundError` before the
harness starts; an unreadable file produces `TranscriptUnavailableError`, malformed
content produces `TranscriptCorruptionError`, and disagreement in logical identity or
generation produces `TranscriptIdentityError`. The library must not create a replacement
file, fall back to the registry projection, or start a new provider thread. A record with
`transcript: null` is intentionally registry-only and remains loadable from its registry
checkpoint.

An unexpectedly missing transcript is rejected during artifact validation, before any
continuation strategy runs. `new_from_consumer_continuation` is not a bypass for that
failure. It is available when the session was intentionally registry-only, when direct
opening uses a consumer checkpoint, or after an explicit repair/import operation has
acknowledged and replaced the missing transcript authority. A transcript whose deletion
is recorded in a tombstone is expectedly absent, but restoring that tombstone must choose
`transcript: false` or an explicit new transcript destination/generation.

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
  /** Defaults to false. */
  includeDeleted?: boolean;
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
  deletedAt?: string;
}

sessionManager.listAgentSessions(options?: ListAgentSessionsOptions):
  Promise<AgentSessionListPage>;

sessionManager.getAgentSessionInfo(
  agentSessionId: string,
  options?: { includeDeleted?: boolean },
): Promise<AgentSessionSummary | null>;
```

Defaults are `limit: 50` and `order: "updated_desc"`; maximum limit is 500. Ordering uses
`agentSessionId` as a deterministic tie-breaker.

Normal listing omits tombstones. `includeDeleted: true` includes them so consumers can
audit or explicitly purge deleted sessions.

`getAgentSessionInfo()` is a metadata lookup, not a live-session lookup. It lets a
consumer read the persisted `adapterId` and then supply the appropriate adapter to
`loadAgentSession()`. It returns `null` for an unknown ID and, by default, for a tombstone;
`includeDeleted: true` exposes the latter. `SessionManager` never maintains or returns a
map of live `AgentSession` objects.

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

`SessionManager.list()` is deprecated in favor of `listAgentSessions()`.
`AgentSession.listSessions()` is deprecated in favor of
`AgentSession.listInternalSessions()`, which means only the active adapter's ACP
`session/list` capability. It never merges registry sessions with harness sessions.

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
  structured?: TranscriptStructuredMessagesV1;
  status?: string;
  stopReason?: string;
}

interface TranscriptStructuredMessagesV1 {
  version: 1;
  messages: readonly TranscriptResponseMessageV1[];
}

interface TranscriptResponseMessageV1 {
  messageId?: string;
  text: string;
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

`types` is valid with `view: "records"` and with `view: "timeline"` when every requested
type belongs to the timeline union. It is rejected for `conversation`, and a timeline
request containing a structural/non-timeline type is rejected. V0 does not introduce a
second `include` vocabulary while the projection categories are the same physical record
types. The validated type filter remains part of the cursor fingerprint.

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
      kind: "uncertain";
      operationId: string;
      boundary:
        | "started_without_terminal"
        | "terminal_without_checkpoint"
        | "in_flight_checkpoint";
    };

type ConfigurationRestoreStatus =
  | { kind: "matched" }
  | {
      kind: "mismatch";
      configIds: readonly string[];
      reasons: readonly string[];
    };
```

V0 does not automatically reconcile a dirty boundary from replay. ACP `loadSession` may
emit useful historical updates, while `resumeSession` does not replay, but ACP does not
guarantee completeness or stable comparable identities. A successful load therefore
cannot prove that the local transcript and harness agree. Any replayed evidence permitted
by capture policy may be recorded with recovery provenance, but status remains
`uncertain`.

Obtaining a usable continuation and reconciling an unclean operation are separate state
machines. Continuation acquisition runs on every open; `SessionRecoveryStatus` describes
whether the resulting logical session is safe to prompt after its durable boundary is
examined. Successfully loading or reconstructing a thread never turns a dirty operation
boundary into a clean one.

Continuation acquisition is an ordered, extensible pipeline rather than hardcoded
fallback inside `open()`:

```ts
type ContinuationStrategy =
  | { kind: "load_internal_session" }
  | {
      kind: "new_from_transcript";
      buildContinuation: TranscriptContinuationBuilder;
    }
  | {
      kind: "new_from_consumer_continuation";
      continuation: string;
    };

interface OpenContinuationOptions {
  /** Defaults to [{ kind: "load_internal_session" }]. */
  strategies?: readonly ContinuationStrategy[];
}

interface TranscriptContinuationBuilderContext {
  agentSessionId: string;
  checkpoint: AgentSessionCheckpoint;
  transcript: TranscriptReader;
  targetAdapterId: string;
}

type TranscriptContinuationBuilder = (
  context: TranscriptContinuationBuilderContext,
) => Promise<{ continuation: string; metadata?: Record<string, JsonValue> }>;

interface ContinuationAttempt {
  strategy: ContinuationStrategy["kind"];
  status: "succeeded" | "failed" | "skipped";
  errorCode?: string;
  reason?: string;
}

interface ContinuationReport {
  recordedAdapterId: string;
  recordedInternalSessionId: string | null;
  requestedAdapterId: string;
  recordedThreadAvailability: "available" | "unavailable" | "not_checked";
  attempts: readonly ContinuationAttempt[];
  outcome:
    | {
        kind: "loaded";
        activeInternalSessionId: string;
      }
    | {
        kind: "reconstructed";
        source: "transcript" | "consumer";
        activeInternalSessionId: string;
        transitionId: string;
      }
    | { kind: "unavailable" };
}

interface AgentSessionOpenResult {
  session: AgentSession;
  continuation: ContinuationReport;
  recovery: SessionRecoveryStatus;
  configuration: ConfigurationRestoreStatus;
}
```

`AgentSession.open({ continuation?: OpenContinuationOptions, ... })` and
`SessionManager.loadAgentSession(id, { continuation?: OpenContinuationOptions, ... })`
use this identical contract. An empty strategy array is invalid because it can never
produce a live session.

The library first resolves and validates the authoritative checkpoint. It then evaluates
explicit strategies in order, stopping at the first success. The default strategy list
contains only `load_internal_session`; this uses the persisted internal ID with the
supplied same-identity adapter. A missing harness thread is a typed failure by default—it
does not inherit the legacy `providerSession.onFailure: "new"` behavior.

Every strategy attempt is appended to the report, including locally skipped attempts.
If `load_internal_session` reaches the adapter and the recorded thread is missing, the
report marks `recordedThreadAvailability: "unavailable"` before any fallback begins. A
successful fallback does not erase that fact. If no strategy succeeds,
`ContinuationUnavailableError` (or the more specific terminal cause, such as
`InternalSessionNotFoundError`) exposes the partial report on its `continuation` member.

`new_from_transcript` is opt-in because it creates a provider thread, consumes tokens,
sends retained content to a harness, may be impossible under a restrictive capture
policy, and cannot undo prior tool side effects. V0 requires an explicit builder rather
than silently choosing truncation, summarization, or raw replay semantics. It may reuse
handoff summary/seed machinery, but is recorded as reconstruction rather than ordinary
handoff. Consumer continuation is a final explicit alternative when the transcript was
never the required authority or the consumer has explicitly repaired/replaced it.
Exhausting all configured strategies leaves the session unopened; the library never
silently creates an empty thread.

The strategy interface is intentionally separable from checkpoint selection and dirty-
boundary recovery so future adapter-certified replay, alternate transcript summarizers,
or consumer continuation modules can be added without changing either state machine.

Changing adapter identity is outside ordinary restoration. `load_internal_session`
requires the supplied `adapterId` to equal the checkpoint adapter ID. A different ID
records a locally failed/skipped attempt and, with no explicit reconstruction strategy,
raises `AdapterMismatchError` before contacting the harness. Supplying a
`new_from_transcript` or `new_from_consumer_continuation` strategy alongside the different
target ID is the explicit adapter-switch request. It creates a new internal session under
the same stable `agentSessionId`, records a switch/reconstruction transition, and installs
the new adapter ID only after the applicable transition rules are satisfied.

Opening-time continuation attempt/completion notifications carry the same report fields.
The returned result or thrown error remains the authoritative delivery mechanism because
session listeners may not exist until after opening completes.

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

At minimum the persistence/opening error taxonomy distinguishes:

- `TranscriptNotFoundError`: the required resolved file does not exist;
- `TranscriptUnavailableError`: the file exists but cannot be read safely;
- `TranscriptCorruptionError`: its bytes violate the selected transcript contract;
- `TranscriptIdentityError`: its logical identity or generation conflicts with the
  requested session;
- `AdapterMismatchError`: ordinary restoration was attempted with another adapter
  identity;
- `InternalSessionNotFoundError`: the same-identity adapter cannot load the recorded
  harness thread.

Only an explicit continuation strategy may turn the latter two continuation failures into a
new internal session. `create()` may create an absent transcript; `open()` and managed
load never do.

## 22. Lifecycle and deletion

Detailed retention, export, and import policy is deferred, but destructive boundaries are
defined now. The managed API is explicit about both independently destructive targets:

```ts
sessionManager.deleteAgentSession(agentSessionId, {
  deleteTranscript?: boolean;     // default false
  removeRegistryEntry?: boolean; // default false
}): Promise<void>;

sessionManager.restoreAgentSession(agentSessionId, {
  adapterId: string;
  adapter: Adapter;
  continuation?: OpenContinuationOptions;
  /** Required when the tombstone says its former transcript was deleted. */
  replacementTranscript?: false | TranscriptConfig;
}): Promise<AgentSessionOpenResult>;
```

With both options omitted or false, deletion tombstones the registry entry, retains the
transcript, prevents accidental ID reuse, and hides the session from normal listing.
`includeDeleted: true` exposes tombstones. `deleteTranscript: true` removes the transcript
but retains the tombstone unless hard removal is also explicitly requested.
`removeRegistryEntry: true` permanently removes discovery metadata. Requesting both is
the fully destructive operation and CLI surfaces require confirmation.

`loadAgentSession()` rejects tombstones with `AgentSessionDeletedError`.
`restoreAgentSession()` is the only managed open operation that accepts one. If the
transcript was retained, it applies ordinary authority and continuation rules. If the
tombstone records transcript deletion, restoration requires an explicit replacement
transcript configuration or `replacementTranscript: false`; it never recreates the old
path implicitly. The tombstone is cleared only after continuation acquisition succeeds,
a restoration transition/checkpoint is durable, and the registry update succeeds. A
failure leaves the tombstone in place and returns or throws the full continuation report.

Deletion is a compare-and-swap mutation and is valid only after the consumer has stopped
the corresponding live `AgentSession`. When a transcript exists, failure to acquire its
exclusive writer lock produces `AgentSessionInUseError`. Registry-only mode cannot prove
that another process holds a live in-memory object; if deletion races a later checkpoint
publication, CAS prevents resurrection and that live session becomes persistence-blocked.
This limitation is explicit because `SessionManager` deliberately does not retain the
consumer's live-session map.

A retained tombstone prevents reuse of its stable ID. Permanent registry removal while
retaining the transcript leaves an orphan which can be explicitly imported and whose
identity still prevents `create()` from appending to it. Only explicit hard registry
removal together with transcript deletion forgets the identity sufficiently for later
reuse.

Additional boundaries:

- Removing a registry entry never implicitly deletes its transcript.
- Deleting a transcript never silently removes its registry entry.
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
the managed registry is not added implicitly.

Omitted persistence on direct `AgentSession.create()` retains the historical no-write
behavior. Default registry and transcript persistence begins only through the new
`SessionManager.createAgentSession()` managed entry point, whose stateful behavior is part
of that API's contract. Release notes must still make the distinction prominent.

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
- continuation attempt failed, skipped, or completed during opening;
- recovery required;
- continuation strategy attempted/completed;
- recovery explicitly accepted with uncertainty;
- transcript corruption or cursor invalidation when relevant to a live reader.

Listener exceptions remain observation failures. They never roll back persistence,
change the session state, or manufacture operation failure records.

## 26. Required tests

### Configuration and capture

- Default root, environment override, and explicit-root precedence.
- Direct `AgentSession.create()` with omitted persistence creates no files.
- Direct `AgentSession.open()` receives an adapter explicitly; persistence never creates
  or globally resolves one.
- Managed creation with omitted per-session options writes the registry and that
  session's default `activity` transcript.
- `SessionManager.createAgentSession()` records the created session; direct
  `AgentSession.create()` never appears in its registry implicitly.
- Manager create/load calls receive their adapter per operation; manager configuration
  contains no adapter resolver or default adapter.
- `getAgentSessionInfo()` returns metadata rather than a live object and exposes the
  adapter ID needed for consumer resolution.
- Per-session transcript settings override manager defaults and explicit
  `transcript: false` produces a registry-only managed session.
- `create()` never restores and `open()` never creates a missing logical session.
- A registry-declared missing transcript fails before harness startup with
  `TranscriptNotFoundError`; registry-only restoration does not require one.
- Consumer continuation cannot bypass an unexpectedly missing authoritative transcript;
  it is allowed after explicit repair or when no transcript was configured.
- Missing, unreadable, corrupt, and identity-mismatched transcripts produce distinct
  typed failures.
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
- Full internal-session history is absent from continuation checkpoints; transcript
  transitions rebuild it and registry-only mode retains it in the registry record.
- Default deletion tombstones and retains the transcript; include-deleted listing and
  every combination of explicit transcript deletion/hard registry removal are tested.
- Ordinary load rejects a tombstone. Explicit restore clears it only after successful
  continuation, durable checkpointing, and CAS registry publication.
- Restoring a tombstone whose transcript was deleted requires an explicit replacement
  transcript or transcript-disabled choice.
- An active transcript writer prevents deletion; a registry-only delete/checkpoint race
  cannot resurrect the record.
- `listAgentSessions()` ordering, limits, ties, and cursor invalidation are deterministic.

### Checkpoints and durability

- Initial session creation writes a checkpoint.
- Every settled operation produces a later durable checkpoint.
- Successful `setConfig()` updates desired/effective selections, normalized model,
  checkpoint, and registry before resolving.
- A post-ACP config persistence failure is reported as changed-but-unpersisted and blocks
  later state mutation.
- Open reapplies desired selections in order; disappeared/rejected options enter
  non-promptable configuration mismatch state without being mislabeled as an uncertain
  operation boundary.
- Same-adapter handoff carries desired selections before seeding; cross-adapter switch
  requires an explicit mapping.
- Same adapter identity attempts `loadSession()` even when the adapter object/version
  differs; another adapter identity fails with `AdapterMismatchError` before startup.
- Reconcile, stop, and reopen retain the same revision and state.
- Transcript and registry copies use the identical checkpoint digest.
- Transcript-newer repairs registry; registry-newer never silently overrides transcript
  continuation and reports an uncertain persistence gap.
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
- ACP replay may import observable evidence but remains uncertain in v0.
- Resume without replay remains uncertain, and successful load alone is not proof of
  reconciliation.
- Default continuation recovery attempts only the recorded internal session. Transcript
  reconstruction and consumer continuation occur only when explicitly configured.
- Successful and failed opens expose ordered attempts, prior-thread availability, active
  thread identity, and reconstruction source through their continuation report.
- Continuation acquisition never clears an independently dirty operation boundary.
- Transcript reconstruction creates and seeds a new thread, records provenance, and
  never claims to undo tool side effects.
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
- Timeline accepts only timeline-record `types`; conversation rejects `types` and records
  accepts all known record types.
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
5. Add checkpoint-based open/restore, per-operation adapter inputs, and the explicit
   continuation-acquisition strategy pipeline.
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
- Adapter-certified automatic replay reconciliation.
- Exactly-once recovery of provider calls or external tool side effects, which neither
  ACP nor local filesystem checkpoints can guarantee.
