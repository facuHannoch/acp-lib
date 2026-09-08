# AgentSession persistence, transcript, and audit-log specification

Status: proposed implementation contract
Date: 2026-09-06
Last updated: 2026-09-08
Scope: default persistence, the logical-session registry, transcript and audit capture
policy, restoration checkpoints, crash recovery, and paginated reads

## 1. Purpose

`AgentSession` has a stable identity which is deliberately independent from the current
ACP/harness thread. That stable identity is what lets a consumer retain one reference
while the library performs a handoff, changes provider threads, or eventually switches
adapters.

Persistence must preserve that abstraction. It has four jobs:

1. Discover logical `AgentSession`s created through the library.
2. Reconstruct the routing and continuation state of one logical session.
3. Retain a policy-controlled transcript that consumers can read without starting the
   harness.
4. Optionally retain a separately governed operational audit log without requiring the
   conversation itself to be retained there.

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
- **Audit log**: an optional append-only JSONL operational record for one logical agent
  session. It is independently filtered and stored, but is never continuation authority.
- **Session log**: the transcript or audit log associated with one logical session. This
  term excludes the registry, checkpoints, provider threads, billing records, locks,
  temporary files, backups, indexes, and files manipulated by agent tools.
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
events the library actually persisted. An audit log is evidence of the operations the
library observed and successfully persisted; it is not an additional restoration
authority. Neither session log is an invoice, a tamper-resistant ledger, or proof that an
external tool side effect did not occur.

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
  /** Default false; see section 24. */
  includeTruncationDigests?: boolean;
}

interface AuditLogConfig {
  path?: string;
  /** Defaults to the operational audit policy defined in section 6.3. */
  capture?: Partial<AuditLogCapturePolicy>;
  /** Default false; see section 24. */
  includeTruncationDigests?: boolean;
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
  /** Base for a direct session's default transcript and audit paths. */
  root?: string;
  transcript?: false | TranscriptConfig;
  /** Omission or false disables the separate audit log. */
  auditLog?: false | AuditLogConfig;
  sessionConfiguration?: SessionConfigurationPersistenceConfig;
  /** Applies to both JSONL session logs after capture-policy filtering. */
  limits?: Partial<PersistenceLimits>;
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
  /** Registry and default session-log root. */
  root?: string;
  /** Omit for the default central JSON registry. */
  store?: AgentSessionStore;
  /** Defaults only; every create call may override them. */
  sessionDefaults?: ManagedSessionPersistenceOptions;
  /** Manager-wide invariants checked after defaults and per-session overrides resolve. */
  sessionConstraints?: {
    transcript?: "optional" | "required" | "forbidden";
    auditLog?: "optional" | "required" | "forbidden";
  };
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

interface PersistenceLimits {
  maxRecordBytes: number;
  maxCapturedFieldBytes: number;
  maxJsonDepth: number;
  maxCursorBytes: number;
}
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
  auditLog: false,
  sessionConfiguration: { values: "typed" },
  limits: {
    maxRecordBytes: 1_048_576,
    maxCapturedFieldBytes: 262_144,
    maxJsonDepth: 64,
    maxCursorBytes: 4_096,
  },
}
```

For managed creation, precedence from highest to lowest is:

1. The individual `createAgentSession()` option.
2. `SessionManagerConfig.sessionDefaults`.
3. The managed library default above.

Resolution is layer-aware rather than a shallow object spread:

1. Start from the managed library defaults. Direct explicit persistence starts from the
   same `activity` transcript preset and default limits, without enabling a registry.
2. Apply manager defaults, then per-session options.
3. At either overriding layer, `transcript: false` or `auditLog: false` disables that log.
   A higher-priority object after a lower-priority `false` explicitly re-enables it from
   the library default policy rather than merging with a disabled value.
4. A supplied `path` changes only the inherited path. A supplied transcript `preset`
   resets capture to that preset before that layer's member-wise `capture` overrides.
   Without a new preset, `capture` merges member-by-member into the inherited policy.
   Audit capture and `limits` always merge member-by-member.
5. `sessionConfiguration.values` merges as a scalar. Its `include` and `exclude` arrays
   replace inherited arrays rather than concatenating them.
6. Validate the fully resolved result against `sessionConstraints`.

Constraint defaults are `optional`. `required` rejects a resolved disabled log;
`forbidden` rejects a resolved enabled log. Constraints never silently create, disable,
delete, or repair storage. They apply to managed creation and loading before opening a
session-log file or starting a harness. Direct `AgentSession` use is unaffected.

Managed creation does not accept `persistence: false`, because a manager always records
the logical session in its registry. Registry-only managed operation is expressed with
`transcript: false` and `auditLog: false`. Direct `AgentSession` usage retains
`persistence: false` as the complete no-persistence mode.

An explicit per-session `transcript: false` always wins. It disables that session's
transcript without removing the session from the manager registry. `auditLog` is disabled
unless explicitly configured either in manager defaults or for that session; the library
does not create two history files by default.

The manager owns its registry and root. A managed session cannot move either through a
per-session option. It may select arbitrary session-log destinations with `transcript.path`
and `auditLog.path`, or override capture and ACP configuration-persistence policy. This
keeps one manager's inventory coherent while preserving genuinely per-session placement.

The limit block shown in the managed default is also the default whenever any direct
transcript or audit persistence is explicitly enabled. Limits are resolved once with the
rest of the effective policy and recorded in every session-log header.

V0 exposes no buffered durability option. Managed persistence uses durable operation
boundaries; direct sessions with persistence disabled make no durability guarantee. The
rationale and deferred weaker-mode design are recorded in `9-6-NOTE-durability.md`.

Default persistence is intentionally visible in documentation because it writes
conversation content to disk. Applications should normally set an application-specific
root, define manager defaults, or choose transcript behavior for every session.
Directories and files created by the default store must be owner-only where the platform
supports permissions.

The manager root, or a direct session's default session-log root, is resolved in this
order:

1. `SessionManagerConfig.root` or the explicit direct-session session-log root.
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
  audit-logs/                         # present only when an audit log is configured
    <encoded-agentSessionId>.jsonl
  maintenance/                        # transient direct-create transaction markers
    <encoded-agentSessionId>.<creationId>.json
```

There is one central mutable registry, at most one authoritative append-only transcript
per logical session, and at most one optional append-only audit log. There must not be a
second permanent metadata file beside either append-only session log. Prepared maintenance
markers and temporary files are transactional implementation state and are removed on
finalization; they are not per-session metadata stores.

Managed maintenance lives atomically in the registry and does not use this directory.
The `maintenance/` directory exists only for explicitly persistent direct creation, which
has no registry transaction in which to place its prepared marker.

The default transcript filename is derived from the stable `agentSessionId`, never from
the mutable `internalSessionId`.

The audit-log filename follows the same identity rule. Transcript and audit paths must
resolve to different files; configuring both to the same path is rejected.

## 5. Session-log path resolution

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

`auditLog.path` uses the identical existing-directory/existing-file/nonexistent-file
resolution algorithm. When omitted, it resolves under `audit-logs` in the effective root.
An audit path never identifies a logical session and never participates in provider-thread
restoration.

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
  creationId: optionalStableRetryId,
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

Direct `create()` always begins a new logical-session creation transaction. Every resolved
transcript or audit destination must be absent or an existing zero-byte regular file when
its lock is acquired. Any recognized header, legacy content, malformed content, or
unrelated byte rejects creation with `AgentSessionAlreadyExistsError`, even when it names
the requested `agentSessionId`. Only `open()` opens a completed logical session.

Strict multi-log initialization uses the generalized maintenance transaction from section
11. Managed creation reserves `{ kind: "creation" }` in the registry after acquiring all
session-log locks in canonical path order. Direct persistent creation writes an owner-only
prepared-creation marker under the effective root's `maintenance` directory because it
has no registry. The normalized request digest covers identity, resolved paths, policies,
limits, adapter ID and nonsecret runtime intent.

The creator prepares temporary headers for every enabled log, establishes the new internal
session, appends the initial checkpoint to the temporary transcript, synchronizes every
temporary file, installs each destination, and persists the complete staged registry
record (or updates the direct marker) before finalization. It then atomically promotes the
staged record and removes the maintenance entry, or removes the direct marker. A caught
failure removes only temporary/final files whose
creation ID and request digest prove they belong to that attempt. A power-loss survivor is
resumed or cleaned only by the identical creation ID/request; another request conflicts.
Retrying a prepared creation may load the internal thread in its staged record to
finish it; this is completion of the same uncommitted create, not `create()` opening an
already-created logical session.

There is necessarily a narrow external-system boundary between the provider returning a
new internal-session ID and the library durably adding it to the prepared transaction. A
power loss in that interval can leave an unreferenced provider thread, because local
storage and the harness do not share a transaction. The library never invents an ID on
retry; it reports the prepared creation and starts another thread only under the same
explicit retry policy. Once the staged record is durable, retry must reuse its recorded
thread rather than create a second one.

If `creationId` is omitted, the library generates one and includes it in any returned
error. A direct caller that needs recovery after process/power loss should supply both a
stable `agentSessionId` and `creationId`; otherwise it may need explicit maintenance
cleanup because no completed object existed from which to learn generated identities.

Direct `open()` reconstructs from an explicit consumer checkpoint and/or transcript. It
applies the consistency rules in section 10 to those supplied persistence inputs and returns the
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
returned session owns its transcript/audit writers and effective capture policies.

`loadAgentSession(agentSessionId)` reads that session's resolved transcript path and
policy from its registry record and requires an adapter for that load operation. It does
not accept a casual transcript override. Healthy log relocation is deferred in v0.
Providing a bare `internalSessionId` remains a
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
  tools: "none" | "metadata" | "input" | "content";
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
| Tool results, terminal output, and returned file content | none | none | content | content |
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

Tool capture levels are cumulative:

- `metadata` retains structural identity, tool name, lifecycle status, and timing only;
- `input` additionally retains arguments, commands, paths, and edit patches, but excludes
  returned file contents, terminal output, and other tool results;
- `content` additionally retains tool results and output.

The name `input` describes the tool invocation, not model input tokens. Edit patches are
tool input even though they contain potentially large or sensitive source content.

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

This is necessary for the transcript to be a continuation log. Structural records
must not contain prompts, responses, tool arguments/output, reasoning, environment
values, secrets, or arbitrary harness payloads.

The sole configuration exception is the filtered restoration state admitted by
`SessionConfigurationPersistenceConfig`. It may appear in transcript checkpoints and the
canonical transition-history entry required to rebuild history. It is governed exclusively
by `sessionConfiguration`, never by display-oriented `capture.configuration`; excluded
values, environment data, credentials, and arbitrary announcements remain forbidden.
Audit projections never receive this restoration state.

An operational metering checkpoint may be embedded in a restoration checkpoint when
metering is enabled. `capture.usage` controls user-facing usage/context history records;
it does not discard state required to restore metering correctly. Such state is not a
billing ledger.

Likewise, `capture.configuration` controls configuration history shown in transcript
projections. The separately configured restoration values may still occur inside a
structural checkpoint. This is documented because checkpoints are readable JSON rather
than a secret store.

### 6.3 Separate operational audit log

The ordinary transcript can itself be configured as an operations-only log:

```ts
transcript: {
  preset: "activity",
  capture: {
    messages: "none",
    tools: "input",
    reasoning: "none",
  },
}
```

This is the preferred shape when the consumer needs only one retained session log. Message
records are filtered before enqueue and never enter the file. The structural checkpoint
and operation records remain because the transcript is still continuation authority.

An independently configured `auditLog` is justified when conversation/restoration data
and operational evidence require different access, storage, deletion, or retention
policies. Its policy intentionally cannot capture conversation messages or raw ACP
traffic:

```ts
interface AuditLogCapturePolicy {
  reasoning: TranscriptCapturePolicy["reasoning"];
  tools: TranscriptCapturePolicy["tools"];
  lifecycle: boolean;
  /** Audit records transition facts, never summary/continuation content. */
  transitions: "none" | "metadata";
  permissions: TranscriptCapturePolicy["permissions"];
  usage: boolean;
  configuration: TranscriptCapturePolicy["configuration"];
}

const DEFAULT_AUDIT_LOG_CAPTURE: AuditLogCapturePolicy = {
  reasoning: "none",
  tools: "input",
  lifecycle: true,
  transitions: "metadata",
  permissions: "decision",
  usage: true,
  configuration: "selections",
};
```

The audit log contains its own header, operation boundaries, and policy-visible copies of
activity, configuration, permission, transition, metering-reference, and lifecycle
records. It never contains restoration checkpoints, message records, raw protocol
records, handoff summary/seed content, or consumer continuation content. Shared
`agentSessionId`, `operationId`, transition IDs, and activity IDs correlate records across
session logs without making either file depend on physical adjacency in the other.

The audit log is never consulted to select an internal session, restore ACP configuration,
restore metering state, reconcile a dirty transcript boundary, or reconstruct a
conversation. There is no cross-file atomic-commit claim: each file has its own identity,
generation, sequence, lock, and durable append boundary. A gap in one does not authorize
inventing records from the other.

Tool inputs can contain paths, source patches, credentials, and user data. Separating an
audit log from conversation content is a retention and access-control capability, not a
claim that the audit log is nonsensitive.

## 7. Registry schema

The default registry is one complete JSON document:

```ts
interface AgentSessionsRegistryFile {
  version: 1;
  revision: number;
  updatedAt: string;
  sessions: Record<string, AgentSessionRecord>;
  /** At most one prepared maintenance operation per logical identity. */
  maintenance: Record<string, SessionMaintenance>;
}

type SessionMaintenance =
  | {
      kind: "creation";
      operationId: string;
      requestDigest: string;
      status: "prepared";
      startedAt: string;
      details: {
        transcriptPath: string | null;
        auditLogPath: string | null;
        /** Added after the internal thread and initial session logs are durable. */
        stagedRecord?: AgentSessionRecord;
      };
    }
  | {
      kind: "persistence_reconfiguration";
      operationId: string;
      requestDigest: string;
      status: "prepared";
      startedAt: string;
      details: {
        transcript:
          | null
          | { action: "disable"; previousPath: string }
          | { action: "replace"; previousPath: string; replacementPath: string };
        auditLog:
          | null
          | { action: "disable"; previousPath: string }
          | { action: "replace"; previousPath: string; replacementPath: string };
      };
    }
  | {
      kind: "deletion";
      operationId: string;
      requestDigest: string;
      status: "prepared";
      startedAt: string;
      details: {
        deleteTranscript: boolean;
        transcriptPath: string | null;
        deleteAuditLog: boolean;
        auditLogPath: string | null;
        removeRegistryEntry: boolean;
      };
    };

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
    effectiveLimits: PersistenceLimits;
  };

  /** Operational session-log metadata only; never continuation authority. */
  auditLog: null | {
    path: string;
    auditLogId: string;
    generation: number;
    effectivePolicy: AuditLogCapturePolicy;
    effectiveLimits: PersistenceLimits;
  };

  metadata?: Record<string, JsonValue>;
  deletion?: {
    /** Logical tombstone time; its presence prevents accidental ID reuse. */
    deletedAt: string;
    /** Present when transcript deletion was explicitly requested and completed. */
    transcriptDeletedAt?: string;
    /** Present when audit-log deletion was explicitly requested and completed. */
    auditLogDeletedAt?: string;
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

The registry stores audit-log location and identity so managed consumers can discover and
read it. That metadata is not copied into `AgentSessionCheckpoint`: loss, corruption, or
advancement of the audit log cannot change which continuation checkpoint is selected.

Routing fields duplicated outside `checkpoint` are indexed/materialized projections for
listing. Every duplicated field must equal its checkpoint counterpart. Full
`internalSessionHistory` is the exception: it is intentionally not a checkpoint member
and is validated against its revision/digest plus transcript transitions when available.
A mismatch is registry corruption, not a last-write-wins choice.

Unknown registry versions are fatal. A library must not partially interpret a newer
document whose invariants it does not understand.

A logical ID with an entry in `maintenance` is not loadable or mutable through another
maintenance kind. Active session metadata remains unchanged until an existing-session
operation finalizes, while a creation reservation may exist before `sessions` has a row.
The marker reserves the identity and makes interrupted work discoverable and retryable.
The request digest covers the normalized operation without arbitrary content or secrets.
Except for creation's complete `stagedRecord`, `details` contains only the normalized
paths and choices required to finish or roll forward the transaction after a crash. The
staged record may contain the same policy-admitted restoration configuration as an active
registry record. Maintenance never contains captured conversation, credentials,
consumer-authored reason text, or configuration values beyond that staged-record policy.

## 8. Internal-session history

The unqualified `internalSessionId` remains the current harness thread. Previous threads
are retained with the context needed to understand a transition:

```ts
type TransitionKind = "handoff" | "switch" | "mode_change" | "replacement";

interface InternalSessionHistoryTransition {
  kind: TransitionKind;
  transitionId: string;
  /** Stable machine-readable code only; never arbitrary consumer text. */
  reasonCode?: string;
}

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
  transition: InternalSessionHistoryTransition;
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

Arbitrary consumer-authored explanations are stored, when admitted, as transition-record
`reasonText`. They never enter `InternalSessionHistoryEntry`, its revision, or its digest.
Capture policy therefore cannot change canonical routing history.

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
    kind: TransitionKind;
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

The checkpoint deliberately contains no audit-log cursor or digest. Audit completeness is
validated from the audit log's own header and operation boundaries and is reported
separately from continuation recovery.

The resolved transcript path is covered by the digest. A consumer must not edit the path
inside an existing checkpoint. General in-place relocation is deferred in v0; recovery
replacement uses the explicit offline operation in section 21, a new log identity and
generation, and a new checkpoint revision. The portable part of a handoff is its
continuation content, not an arbitrary machine-local checkpoint.

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
  restorationFidelity: "exact" | "partial";
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
rejected, or a checkpoint claiming exact fidelity lacks a value needed for comparison,
configuration restoration is `mismatch` and the session is non-promptable. A checkpoint
whose fidelity was already explicitly accepted as `partial` instead returns promptable
`partial`; it does not recreate the same mismatch on every open. This is distinct from an
uncertain crash boundary. Resolution has its own API rather than overloading crash
recovery:

```ts
type ConfigurationMismatchResolution =
  | { strategy: "accept_effective" }
  | {
      strategy: "replace_desired";
      selections: readonly {
        configId: string;
        value: JsonValue;
      }[];
    };

interface ConfigurationMismatchResolutionResult {
  configuration: ConfigurationRestoreStatus;
  appliedConfigIds: readonly string[];
}

session.resolveConfigurationMismatch(
  resolution: ConfigurationMismatchResolution,
): Promise<ConfigurationMismatchResolutionResult>;
```

`accept_effective` performs no harness mutation. It makes the policy-admitted effective
values the new ordered desired state, records the resolution, checkpoints it, and unblocks
the current session. Effective values excluded by `sessionConfiguration` do not enter
`desired`; the checkpoint records `restorationFidelity: "partial"`, and future opens report
promptable partial restoration rather than claiming exact equality.

`replace_desired` validates a nonempty, duplicate-free ordered list against the current
announcement. Each selection is one ordinary `set_config` operation with its own durable
start, terminal, returned-schema validation, and checkpoint before the next selection.
After all selections agree, a final configuration-resolution record/checkpoint marks the
status matched and unblocks. If selection N fails, selections 1 through N-1 remain
accurately checkpointed, later selections are not attempted, and mismatch remains active.
This API does not start a new thread; after resolving or accepting configuration, the
consumer may explicitly hand off or switch.

During same-adapter handoff, desired selections carry to the new internal session and are
applied before continuation seeding. Across an adapter switch they do not transfer unless
the switch request or consumer supplies an explicit mapping; config IDs are not portable
between harnesses. The old configuration snapshot remains in the registry history and
the corresponding transcript transition record; it is not copied into every later
checkpoint.

### 9.2 Canonical transcript reducer

One pure reducer is the sole definition of transcript continuation state:

```ts
type TranscriptStructuralRecord =
  | TranscriptCheckpointRecord
  | TranscriptOperationRecord
  | TranscriptConfigurationRecord
  | TranscriptTransitionRecord
  | TranscriptLifecycleRecord;

reduceTranscriptState(
  checkpoint: AgentSessionCheckpoint,
  structuralTail: readonly TranscriptStructuralRecord[],
): TranscriptReductionResult;
```

It validates and folds operation boundaries, aborted compensation, configuration changes,
transition activation/history, recovery resolutions, and subsequent checkpoints in `seq`
order. It either returns the exact derived checkpoint/state plus required deterministic
repairs, or a typed corruption/uncertainty result. It performs no filesystem access,
harness calls, logging, notification delivery, or fresh timestamp generation.

The writer, opener, registry-projection repair, activation/aborted checkpoint repair,
cursor reader, and tests all call this reducer. None independently implements transition
or boundary folding. Persisted checkpoints are materialized reducer snapshots; the
checkpoint plus structural journal tail, not either interpreted independently, determines
continuation.

## 10. Authority and persistence combinations

The supported combinations are:

| Registry | Transcript | Reopen source | Discovery |
| --- | --- | --- | --- |
| enabled | enabled | transcript checkpoint and journal tail | registry |
| enabled | disabled | registry checkpoint | registry |
| disabled | enabled | latest valid transcript checkpoint | consumer-supplied path |
| disabled | disabled | consumer-supplied checkpoint | consumer |

Audit-log enablement does not add rows to this table because it never changes discovery
or reopen authority. It is an independently validated output log layered on any of
the four combinations.

With neither facility enabled:

- creating a new session remains supported;
- reopening requires a consumer-supplied `AgentSessionCheckpoint` and consumer-supplied
  adapter;
- providing only `agentSessionId` is insufficient and must fail before starting a
  harness.

The registry is the managed inventory source of truth. Transcript-directory scanning and
general orphan import are deferred in v0 and never occur as implicit session discovery.
Authority is conditional rather than shared:

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

An unexpectedly missing transcript is rejected during session-log validation, before any
continuation strategy runs. `new_from_consumer_continuation` is not a bypass for that
failure. It is available when the session was intentionally registry-only, when direct
opening uses a consumer checkpoint, or after the explicit offline persistence
reconfiguration in section 21 has acknowledged and replaced the missing transcript
authority. A transcript whose deletion
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
  prepareMaintenance(
    agentSessionId: string,
    maintenance: SessionMaintenance,
    options: { expectedRecordRevision: number | null },
  ): Promise<void>;
  updateMaintenance(
    agentSessionId: string,
    operationId: string,
    update: SessionMaintenance,
  ): Promise<void>;
  finalizeMaintenance(
    agentSessionId: string,
    operationId: string,
    mutation: { save?: AgentSessionRecord; deleteRecord?: true },
  ): Promise<void>;
}
```

`AgentSessionRecord` therefore also contains a monotonically increasing
`recordRevision`. Saving with a stale expected revision produces
`AgentSessionStoreConflictError`; the manager rereads, reapplies non-conflicting changes,
and retries within a bounded policy. Database stores implement this through their native
transaction/CAS facility. The global registry revision belongs only to the default JSON
file format.

`prepareMaintenance` atomically verifies the record revision and absence of another
maintenance operation before reserving the ID. `updateMaintenance` verifies the same
operation ID, kind, and request digest and may only advance fields allowed by that
maintenance kind; for creation, this means adding the complete staged record after its
initial session logs are durable. It may not replace normalized targets or choices.
`finalizeMaintenance` verifies the exact operation ID, applies exactly one save/delete
mutation, and removes the reservation in the same store transaction. Repeating a call
with the identical operation ID and request digest is idempotent; a different operation
conflicts. Store implementations which cannot provide those atomic transitions cannot
advertise managed strict persistence.

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
  recordRevision: number;
  adapterId: string;
  mode: "normal" | "degraded";
  model: string | null;
  title?: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  recovery: "clean" | "required";
  transcriptAvailable: boolean;
  auditLogAvailable: boolean;
  lifecycle: "active" | "maintenance_pending" | "deleted";
  maintenance?: {
    kind: SessionMaintenance["kind"];
    operationId: string;
    startedAt: string;
  };
  deletedAt?: string;
}

sessionManager.listAgentSessions(options?: ListAgentSessionsOptions):
  Promise<AgentSessionListPage>;

sessionManager.getAgentSessionInfo(
  agentSessionId: string,
  options?: { includeDeleted?: boolean },
): Promise<AgentSessionSummary | null>;

sessionManager.getSessionMaintenance(
  agentSessionId: string,
): Promise<SessionMaintenance | null>;
```

Defaults are `limit: 50` and `order: "updated_desc"`; maximum limit is 500. Ordering uses
`agentSessionId` as a deterministic tie-breaker.

Normal listing omits tombstones. `includeDeleted: true` includes them so consumers can
audit or explicitly purge deleted sessions. A prepared deletion is hidden by default and
appears as `lifecycle: "maintenance_pending"` with `includeDeleted: true`; a finalized
tombstone is `deleted`. Other maintenance on an existing record remains visible as
`maintenance_pending` because it still reserves an active logical identity. A creation
reservation without a completed record is exposed through maintenance inspection/retry,
not misrepresented as a created session.

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
  truncation?: readonly PersistedTruncation[];
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
  event: "created" | "upgraded" | "replaced";
  createdAt: string;
  preset: TranscriptPreset;
  effectivePolicy: TranscriptCapturePolicy;
  effectiveLimits: PersistenceLimits;
  upgradedFrom?: { version: 1; boundaryOffset: number };
  reconfigurationId?: string;
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
  event: "announced" | "selected" | "restored" | "restore_failed" | "resolved";
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

### 13.2 Audit-log envelope

An audit log is a distinct JSONL session log, not a second transcript generation. Its lines
use an independently versioned envelope:

```ts
type AuditLogRecordType =
  | "header"
  | "operation"
  | "activity"
  | "configuration"
  | "permission"
  | "transition"
  | "metering_reference"
  | "lifecycle";

interface AuditLogEnvelope {
  v: 1;
  t: AuditLogRecordType;
  auditLogId: string;
  generation: number;
  agentSessionId: string;
  seq: number;
  ts: number;
  operationId?: string;
  truncation?: readonly PersistedTruncation[];
}

interface AuditLogHeaderRecord extends AuditLogEnvelope {
  t: "header";
  event: "created" | "replaced";
  createdAt: string;
  effectivePolicy: AuditLogCapturePolicy;
  effectiveLimits: PersistenceLimits;
  reconfigurationId?: string;
}

interface AuditLogOperationRecord extends AuditLogEnvelope {
  t: "operation";
  event: "started" | "settled" | "failed" | "cancelled" | "interrupted" | "aborted";
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
  abortReason?: "pre_dispatch_persistence_failure" | "pre_dispatch_cancelled";
}

interface AuditLogActivityRecord extends AuditLogEnvelope {
  t: "activity";
  activityId: string;
  activityRevision: number;
  operationId: string;
  reason: "announced" | "input" | "settled" | "flushed" | "snapshot";
  kind: string;
  status?: string;
  /** Explicit audit allowlist projection, never a transcript payload copy. */
  data: Record<string, JsonValue>;
}

interface AuditLogConfigurationRecord extends AuditLogEnvelope {
  t: "configuration";
  event: "announced" | "selected" | "restored" | "restore_failed" | "resolved";
  configId?: string;
  /** Present only when admitted by the audit configuration policy. */
  value?: JsonValue;
  definitions?: JsonValue;
  schemaDigest?: string;
}

interface AuditLogPermissionRecord extends AuditLogEnvelope {
  t: "permission";
  permissionId: string;
  activityId?: string;
  event: "requested" | "resolved";
  outcome?: string;
  /** Allowlisted by decision/full policy; never copied generically. */
  details?: JsonValue;
}

interface AuditInternalSessionDescriptor {
  internalSessionId: string | null;
  adapterId: string;
  mode: "normal" | "degraded";
  model: string | null;
  protocol:
    | { name: "acp"; version: number }
    | { name: "pty" };
}

interface AuditLogTransitionRecord extends AuditLogEnvelope {
  t: "transition";
  transitionId: string;
  kind: TransitionKind;
  event: "started" | "target_created" | "target_activated" | "completed" | "failed";
  from: AuditInternalSessionDescriptor | null;
  to?: AuditInternalSessionDescriptor;
  failedAfter?: "start" | "target_created" | "target_activated";
  errorCode?: string;
  reasonCode?: string;
}

interface AuditLogMeteringReferenceRecord extends AuditLogEnvelope {
  t: "metering_reference";
  operationId: string;
  meteringRecordId: string;
  status: "available" | "partial" | "unavailable";
  summary?: JsonValue;
}

interface AuditLogLifecycleRecord extends AuditLogEnvelope {
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

type KnownAuditLogRecord =
  | AuditLogHeaderRecord
  | AuditLogOperationRecord
  | AuditLogActivityRecord
  | AuditLogConfigurationRecord
  | AuditLogPermissionRecord
  | AuditLogTransitionRecord
  | AuditLogMeteringReferenceRecord
  | AuditLogLifecycleRecord;

interface UnknownAuditLogRecord {
  v: number;
  t: string;
  auditLogId: string;
  generation: number;
  agentSessionId: string;
  seq: number;
  ts: number;
  value: JsonObject;
}
```

Audit schemas are deliberately concrete. The runtime first creates one normalized
in-memory event and then invokes independent transcript and audit allowlist projections.
No audit schema is mechanically derived from a transcript schema, so adding a transcript
field cannot silently persist it to the audit log. `checkpoint`, `message`, `raw`,
`sessionConfiguration`, canonical `historyEntry`, summary/continuation content, and
consumer `reasonText` are invalid audit content and are treated as corruption in a
recognized audit-log version.

`auditLogId` is random, `generation` begins at 1, and `seq` is strictly increasing within
that generation. Transcript IDs and audit-log IDs are never reused across session logs.
Shared logical and operation identifiers provide correlation; timestamps do not establish
cross-file ordering.

## 14. Operation records and durable boundaries

Before an operation can reach the harness, the writer must append and durably synchronize:

```ts
interface TranscriptOperationRecord extends TranscriptEnvelope {
  t: "operation";
  event:
    | "started"
    | "settled"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "aborted";
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
  /** Present exactly when event is aborted. */
  abortReason?:
    | "pre_dispatch_persistence_failure"
    | "pre_dispatch_cancelled";
}
```

`abortReason` is required exactly for `event: "aborted"` and forbidden for every other
event. Conversely, `aborted` cannot carry an error code that implies provider execution.

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

When an audit log is enabled, its `operation(started)` is synchronized in the same
pre-dispatch phase. Policy-visible audit activity follows, then its terminal operation
record is synchronized before the operation resolves. It receives no checkpoint and does
not participate in registry checkpoint publication. The shared operation ID correlates
the two local sequences without asserting a cross-file total order.

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

Creation resolves paths, validates existing session logs, and acquires writer ownership
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
not sent. The writer tracks every transcript/audit log where `started` became durable,
appends `operation(aborted, abortReason=pre_dispatch_persistence_failure)` to each such
log, and publishes a settled checkpoint to every available continuation store. The
compensation is durably synchronized where possible. If any compensating terminal or
checkpoint write fails, restoration conservatively treats the remaining durable
`started` record as uncertain; in-memory knowledge that dispatch did not occur cannot
repair evidence that was not persisted.

Work cancelled while merely queued receives no start or terminal record. If cancellation
wins after at least one start marker became durable but before dispatch, the identical
compensation uses `abortReason=pre_dispatch_cancelled`. An `aborted` event is therefore a
positive durable assertion that the operation did not reach the harness; it is never used
for a post-dispatch cancellation.

When both continuation stores are disabled, the library provides no durable continuation
or crash-recovery guarantee. An independently enabled audit log may prove that an
operation entered the pre-dispatch phase, but it cannot restore the logical session.
Notifications and post-operation checkpoint access do not let a consumer reproduce the
continuation boundary retroactively. A consumer requiring managed database durability
supplies an `AgentSessionStore` through `SessionManager`; a general direct-session
persistence coordinator is deferred.

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
  /** Inclusive snapshot high-water mark; omit to capture one at call start. */
  at?: TranscriptSnapshotCursor;
  status?: "open" | "terminal" | "all";
  limit?: number;
  order?: "updated_desc" | "updated_asc";
}

interface PersistedActivityStatePage {
  activities: readonly PersistedActivityState[];
  /** Returned even when activities is empty. */
  snapshot: TranscriptSnapshotCursor;
}

transcriptReader.listActivityStates(
  options?: ListTranscriptActivitiesOptions,
): Promise<PersistedActivityStatePage>;
```

The initial offline implementation may scan with bounded memory, retaining only the
latest requested activities. A later disposable index may optimize this. It must not
become a source of truth.

The reducer first folds each activity through the snapshot's inclusive high-water
sequence, then applies `status`, then orders and limits the result. Ordering uses the
sequence of the greatest included activity revision as its primary key and `activityId`
as the deterministic tie-breaker; timestamps never participate. Defaults are
`status: "all"`, `order: "updated_desc"`, and `limit: 50`; maximum limit is 500.

## 17. Handoff and switch transitions

A transition is multi-phase and remains under one stable `agentSessionId`:

```ts
interface TranscriptTransitionRecord extends TranscriptEnvelope {
  t: "transition";
  transitionId: string;
  kind: TransitionKind;
  event:
    | "started"
    | "target_created"
    | "target_activated"
    | "completed"
    | "failed";
  from: InternalSessionDescriptor | null;
  to?: InternalSessionDescriptor;
  /** Present only on target_activated when a non-null prior thread is deactivated. */
  historyEntry?: InternalSessionHistoryEntry;
  /** Required only on target_activated; completes deterministic checkpoint reduction. */
  activationState?: {
    resultingStateRevision: number;
    updatedAt: string;
    transitionAt: string;
    boundary: AgentSessionCheckpoint["boundary"];
  };
  /** Identifies how far a failed transition progressed without inferring from adjacency. */
  failedAfter?: "start" | "target_created" | "target_activated";
  summary?: string;
  reasonCode?: string;
  /** Capture-controlled explanation; excluded from canonical history and its digest. */
  reasonText?: string;
  errorCode?: string;
}

interface InternalSessionDescriptor {
  internalSessionId: string | null;
  adapterId: string;
  mode: "normal" | "degraded";
  model: string | null;
  sessionConfiguration: SessionConfigurationCheckpoint;
  activatedAt: string | null;
  protocol:
    | { name: "acp"; version: number }
    | { name: "pty" };
}
```

Summary and continuation content is persisted only when the effective transition policy
is `content`. Identifiers and state changes remain structural.

Canonical history reconstruction folds transition records in transcript `seq` order:

1. `started` and `target_created` never change current routing or history.
2. Exactly one `target_activated` may occur per transition. It requires `to` and
   `activationState`. When `from`
   has a non-null internal ID, it also requires an exact `historyEntry` whose identity,
   adapter, model, configuration, protocol, and activation time equal `from`, whose
   `deactivatedAt` is explicit, and whose transition member matches the transition ID and
   kind. When `from` has no internal ID, `historyEntry` is absent.
3. `target_activated` appends that exact entry, increments the history revision, and makes
   `to` current. `internalSessionActivatedAt` comes from `to.activatedAt`;
   `stateRevision`, `updatedAt`, `lastTransition.at`, and boundary come from
   `activationState`; transcript `coveredSequence` is the activation record's `seq`.
   History digest is recomputed from the exact folded entries. No reader generates a fresh
   timestamp or derives activation/deactivation times from envelope timestamps.
4. `completed` never mutates history; it records orchestration completion after activation.
5. `failed` requires `failedAfter`. Failure before activation leaves routing/history
   unchanged. Failure after activation leaves the target current and preserves the already
   committed history entry.
6. A second activation for the same transition, disagreement between descriptors and the
   history entry, or a history digest inconsistent with this fold is corruption.

The writer may install the target in memory only after `target_activated` is durable, and
then publishes the checkpoint which first names it as current. If a crash occurs between
those writes, the reducer deterministically synthesizes that checkpoint from the previous
checkpoint plus the activation record, appends it, and repairs the registry projection.
This is reported in `AgentSessionOpenResult.repairs`; it is not provider-call uncertainty.
If the recorded target thread later cannot load, that is a separate continuation outcome.
This ordering makes every crash phase deterministic without treating creation of a
not-yet-installed provider thread as a logical-session transition.

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
type TranscriptCursor = string & { readonly __transcriptCursor: unique symbol };
type TranscriptSnapshotCursor = string & {
  readonly __transcriptSnapshotCursor: unique symbol;
};
type AuditLogCursor = string & { readonly __auditLogCursor: unique symbol };
type AuditLogSnapshotCursor = string & {
  readonly __auditLogSnapshotCursor: unique symbol;
};

interface ReadTranscriptPageOptions {
  cursor?: TranscriptCursor;
  limit?: number;
  view?: TranscriptView;
  types?: readonly TranscriptRecordType[];
}

interface TranscriptPage<
  T,
  C = TranscriptCursor,
  S = TranscriptSnapshotCursor,
> {
  items: readonly T[];
  olderCursor: C | null;
  newerCursor: C | null;
  hasOlder: boolean;
  hasNewer: boolean;
  /** Stable high-water identity shared by every navigation cursor in this walk. */
  snapshot: S;
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

interface ReadAuditLogPageOptions {
  cursor?: AuditLogCursor;
  limit?: number;
  types?: readonly AuditLogRecordType[];
}

interface AuditLogReader {
  readPage(options?: ReadAuditLogPageOptions):
    Promise<TranscriptPage<
      KnownAuditLogRecord | UnknownAuditLogRecord,
      AuditLogCursor,
      AuditLogSnapshotCursor
    >>;
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

The audit reader has one records/timeline-shaped projection because audit logs contain no
conversation or restoration-only records. It otherwise uses the same limit, display
ordering, bounded scanning, snapshot, and filter rules. Audit cursors are log-specific
and cannot be supplied to a transcript reader.

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

Every page returns the corresponding opaque snapshot cursor, including an empty page.
The high-water sequence is inclusive. `olderCursor` and `newerCursor` embed or reference
the identical snapshot identity, so navigation cannot drift to a later append boundary.
`listActivityStates({ at })` accepts only a snapshot cursor for the same transcript and
generation—not a page-navigation cursor whose view/filter fingerprint happens to be
compatible. This keeps the folded-state query independent from a prior projection.

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

A snapshot cursor contains only the cursor version, log identity/generation, inclusive
high-water sequence/offset, and boundary digest. It carries no view/filter fingerprint.
A navigation cursor additionally carries its current boundary and projection fingerprint
and is bound to that snapshot. Audit-log snapshot and navigation cursors use distinct
brands and cannot be supplied to transcript APIs.

A cursor is invalid when:

- used with a different transcript, generation, view, or filter;
- the file was truncated, replaced, compacted, or rewritten;
- content at or before its boundary was modified;
- its version is unsupported or its payload malformed.

The reader throws `TranscriptCursorInvalidError`; it never silently restarts at the newest
page.

For an audit cursor, the corresponding fields are the audit-log ID and generation. The
cursor schema also identifies the log kind, so coincidentally equal generation and
sequence values cannot cross the transcript/audit boundary.

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

The same append-only, generation, torn-tail, and exclusive-writer rules apply independently
to an audit log. Audit-log corruption is reported as `AuditLogCorruptionError`; it does
not cause the reader to reinterpret the audit file as a continuation transcript.

The default writer acquires a transcript-lifetime lock before starting the harness and
holds it until all final writes are synchronized. Failure to acquire it fails session
creation/opening before provider work. Lock ownership records a random nonce and process
identity; recovery requires evidence the owner is gone and follows the same non-time-only
stale-lock rule as the registry.

A corruption diagnostic cannot be appended to the generation declared corrupt. It is
emitted through the logger/listener and, if the consumer performs the explicit offline
replacement from section 21, recorded in the new generation created by that operation.

## 20. Recovery after an unclean boundary

Opening a clean settled checkpoint requires no reconciliation. Either an
`operation(started)` without a terminal record or a terminal record not covered by a
later checkpoint is a dirty boundary. The library and harness may have diverged: the
harness may have persisted a response or executed tool side effects after the last
library fsync.

`operation(aborted)` is a terminal record and a durable assertion that dispatch did not
occur. When a later settled checkpoint covers it, the operation is clean. If the abort is
durable but its settled checkpoint/registry publication is missing, restoration
deterministically derives the unchanged continuation state from the preceding checkpoint,
advances only the boundary metadata, and repairs the settled checkpoint observably. It
does not enter provider-call uncertainty. Failure to persist `aborted` itself leaves only
`started` and therefore remains conservatively uncertain.

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
      /** Promptable, but policy omitted values needed for exact future restoration. */
      kind: "partial";
      omittedConfigIds: readonly string[];
    }
  | {
      kind: "mismatch";
      configIds: readonly string[];
      reasons: readonly string[];
    };

type PromptBlocker =
  | "continuation_unavailable"
  | "recovery_required"
  | "configuration_mismatch"
  | "persistence_unhealthy"
  | "maintenance_pending"
  | "session_stopped";

type AgentSessionPromptability =
  | { promptable: true; blockers: readonly [] }
  | { promptable: false; blockers: readonly PromptBlocker[] };
```

Promptability is one derived composition, not a separate mutable state machine:

```text
promptable =
  continuation acquired
  AND recovery clean or explicitly resolved
  AND configuration matched or accepted-partial
  AND every configured persistence sink healthy
  AND no maintenance transaction pending
  AND session not stopped
```

`blockers` contains every currently applicable reason in the order shown above; consumers
must not have to infer one blocker by polling unrelated properties. `partial`
configuration is promptable. A continuation-unavailable open normally throws before
returning a session, but its result/error still reports that blocker. Manager maintenance
is checked before harness startup and therefore normally blocks loading rather than a live
object; it remains in the common vocabulary so state inspection is complete.

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
  recordedConversationAvailability:
    | "available"
    | "partial"
    | "not_captured"
    | "transcript_unavailable";
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

type PersistenceRepair =
  | {
      kind: "aborted_checkpoint_rebuilt";
      operationId: string;
      stateRevision: number;
    }
  | {
      kind: "activation_checkpoint_rebuilt";
      transitionId: string;
      stateRevision: number;
    }
  | {
      kind: "registry_projection_repaired";
      fromRevision: number;
      toRevision: number;
    };

interface AgentSessionOpenResult {
  session: AgentSession;
  continuation: ContinuationReport;
  recovery: SessionRecoveryStatus;
  configuration: ConfigurationRestoreStatus;
  promptability: AgentSessionPromptability;
  /** Ordered durable repairs performed before the result was returned. */
  repairs: readonly PersistenceRepair[];
}
```

The live session exposes the same derived value as
`session.promptability: AgentSessionPromptability` and emits a state notification whenever
its value changes. Prompt-like methods reject with a typed error carrying the complete
blocker list rather than selecting an arbitrary first failure.

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

`recordedConversationAvailability` is derived from the authoritative transcript and its
effective capture policy. In particular, `messages: "none"` reports `not_captured`; the
library never implies that a transcript can reconstruct the conversation merely because
structural or audit-like records exist. An explicit `new_from_transcript` builder may still
choose to use retained transition or tool content, but that is consumer policy and does
not change the reported absence of conversation messages. `partial` means message capture
was enabled but at least one retained message was truncated or omitted by a persistence
limit; a builder decides whether the remaining content is usable.

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

When an audit log is configured, its operation-start record is also a required
pre-dispatch boundary. Failure to synchronize it prevents dispatch. Failure to persist an
audit terminal/activity boundary after provider work does not change continuation
recovery status—the audit log is not continuation authority—but it creates an observable
audit gap and blocks later state-changing operations on that live session until the sink
is repaired or the session is explicitly reopened without that audit log. A transcript
write and an audit write are not claimed to commit atomically.

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
- `AuditLogNotFoundError`, `AuditLogUnavailableError`, `AuditLogCorruptionError`, and
  `AuditLogIdentityError`: the corresponding explicitly configured audit log cannot
  safely continue;
- `PersistenceRecordTooLargeError` and `PersistenceValueDepthError`: a nontruncatable
  structural value violates an effective/hard storage limit;
- `SessionMaintenanceConflictError`: the registry revision, operation ID, or request
  digest conflicts with a prepared creation, reconfiguration, or deletion;
- `SessionMaintenanceInProgressError`: load or another mutation was attempted while a
  prepared maintenance transaction still requires completion or retry;
- `AdapterMismatchError`: ordinary restoration was attempted with another adapter
  identity;
- `InternalSessionNotFoundError`: the same-identity adapter cannot load the recorded
  harness thread.

Only an explicit continuation strategy may turn the latter two continuation failures into a
new internal session. `create()` may create an absent transcript; `open()` and managed
load never do.

For managed loading, a registry-declared audit log is part of the requested persistence
contract even though it is not restoration authority. A missing or unusable audit log
fails before harness startup with its typed audit error unless the consumer performs an
explicit persistence reconfiguration that disables or replaces it. It must never be
silently recreated at the old identity, because that would hide an audit gap.

V0 has no live persistence-repair method. A post-dispatch persistence failure leaves that
`AgentSession` blocked; the consumer stops it and performs the following offline managed
operation before loading again:

```ts
interface ReconfigureAgentSessionPersistenceOptions {
  /** Consumer-minted stable ID; retrying the same interrupted repair reuses it. */
  reconfigurationId: string;
  expectedRecordRevision: number;

  transcript?:
    | {
        action: "disable";
        checkpoint: AgentSessionCheckpoint;
        /** The operation deletes the currently recorded file if it still exists. */
        deleteExistingLog: true;
        acknowledgeContinuationLoss: true;
      }
    | {
        action: "replace";
        config: TranscriptConfig;
        checkpoint: AgentSessionCheckpoint;
        acknowledgeContinuationLoss: true;
      };

  auditLog?:
    | {
        action: "disable";
        /** The operation deletes the currently recorded file if it still exists. */
        deleteExistingLog: true;
        acknowledgeAuditGap: true;
      }
    | {
        action: "replace";
        config: AuditLogConfig;
        acknowledgeAuditGap: true;
      };
}

sessionManager.reconfigureAgentSessionPersistence(
  agentSessionId: string,
  options: ReconfigureAgentSessionPersistenceOptions,
): Promise<AgentSessionSummary>;

sessionManager.getAgentSessionCheckpoint(
  agentSessionId: string,
  options?: {
    includeDeleted?: boolean;
    source?: "resolved" | "registry_projection";
  },
): Promise<{
  checkpoint: AgentSessionCheckpoint;
  source: "transcript" | "registry_projection";
  authoritative: boolean;
} | null>;
```

By default, `getAgentSessionCheckpoint()` resolves the same authority rules as opening
without starting a harness: it returns the latest valid transcript/journal-derived
checkpoint when a transcript is authoritative, otherwise the registry checkpoint. It
throws the same session-log/conflict errors rather than silently returning a stale registry
projection. Explicit `source: "registry_projection"` is the audited escape hatch needed
to inspect a projection after transcript loss; the result says `authoritative: false` when
the configured transcript would normally own continuation. Supplying that checkpoint to
reconfiguration still requires `acknowledgeContinuationLoss: true`.

The operation requires a stopped session, at least one requested session-log change, every
applicable exclusive lock, and the exact registry revision. It never starts a harness.
The supplied checkpoint is validated for version, digest, logical identity, and against
the expected registry projection; explicitly acknowledging loss permits that validated
projection to become continuation authority after a missing transcript. Reconfiguration
cannot resolve an independently dirty operation boundary or metering/configuration
mismatch.

After acquiring all affected session-log locks in canonical path order and rereading the
expected record revision, the manager calls `prepareMaintenance()` with
`kind: "persistence_reconfiguration"`, the ID, normalized nonsecret details, and a
canonical digest of the request while leaving active session-log metadata unchanged.
Loading is blocked while that marker exists. For replacement, `config.path` must resolve
to the recorded path:
v0 replacement is not relocation. The manager creates a sibling temporary generation
containing the new identity, `reconfigurationId`, and effective policy. For a transcript,
it treats the validated supplied checkpoint as the base, installs the replacement
transcript identity/path, increments its state revision, recomputes its digest, and writes
that derived checkpoint as the generation's initial checkpoint.

The replacement is synchronized and atomically installed, or the explicitly acknowledged
disable target is removed and its parent synchronized. Only afterward does a final CAS
publish the new session-log/checkpoint metadata (or `null`) and remove the prepared marker.
If interruption occurs at any point, a retry with the same ID and request digest resumes
or finalizes the exact prepared operation; another ID or request receives a conflict. The
registry never presents an undurable replacement as active, and a destructive disable is
never made undiscoverable before its prepared intent is durable.

Arbitrary new destinations, healthy-log relocation, general orphan import, and
in-place continuation of a log with an acknowledged gap are deferred.

## 22. Lifecycle and deletion

Detailed retention, export, and import policy is deferred, but destructive boundaries are
defined now. The managed API is explicit about all independently destructive targets:

```ts
sessionManager.deleteAgentSession(agentSessionId, {
  /** Consumer-minted stable ID used to resume the same deletion after interruption. */
  deletionId: string;
  expectedRecordRevision: number;
  deleteTranscript?: boolean;     // default false
  deleteAuditLog?: boolean;       // default false
  removeRegistryEntry?: boolean; // default false
}): Promise<void>;

sessionManager.restoreAgentSession(agentSessionId, {
  adapterId: string;
  adapter: Adapter;
  continuation?: OpenContinuationOptions;
  /** Required when the tombstone says its former transcript was deleted. */
  replacementTranscript?: false | TranscriptConfig;
  /** Required to resume audited operation after its former audit log was deleted. */
  replacementAuditLog?: false | AuditLogConfig;
}): Promise<AgentSessionOpenResult>;
```

With all options omitted or false, deletion tombstones the registry entry, retains the
transcript and audit log, prevents accidental ID reuse, and hides the session from normal
listing.
`includeDeleted: true` exposes tombstones. `deleteTranscript: true` removes the transcript
and `deleteAuditLog: true` independently removes the audit log; either retains the
tombstone unless hard removal is also explicitly requested.
`removeRegistryEntry: true` is accepted only when the same call also requests deletion of
every configured transcript and audit log. Otherwise it fails before mutation. The valid
combination permanently removes discovery metadata and every library-known identity
session log; CLI surfaces require confirmation.

Deletion uses the same prepared maintenance transaction as creation and persistence
reconfiguration. Its normative order is:

```text
resolve and normalize every target
→ acquire all configured session-log locks in canonical absolute-path order
→ reread the registry and validate the record revision/lifecycle
→ CAS-publish maintenance(kind=deletion, operationId=deletionId)
→ delete requested logs and synchronize each parent directory
→ CAS-finalize the tombstone or remove the registry record and maintenance marker
→ release locks
```

Publishing the prepared deletion makes the identity non-loadable and hides it from normal
listing before any log disappears. It happens only after locks are owned, so a live writer
cannot leave an indefinitely hidden session merely by refusing a later lock acquisition.
If the process stops after preparation, `includeDeleted: true` reports
`lifecycle: "maintenance_pending"`; retrying the same `deletionId` and request digest
idempotently completes the remaining deletes and final CAS. A different request conflicts.
This order applies even when only one log is deleted and the registry row will remain, so
an unexplained missing transcript cannot be produced by a crash between unlink and
tombstone metadata publication.

`loadAgentSession()` rejects tombstones with `AgentSessionDeletedError`.
`restoreAgentSession()` is the only managed open operation that accepts one. If the
transcript was retained, it applies ordinary authority and continuation rules. If the
tombstone records transcript deletion, restoration requires an explicit replacement
transcript configuration or `replacementTranscript: false`; it never recreates the old
path implicitly. The tombstone is cleared only after continuation acquisition succeeds,
a restoration transition/checkpoint is durable, and the registry update succeeds. A
failure leaves the tombstone in place and returns or throws the full continuation report.

If the tombstone records audit-log deletion, restoration must explicitly replace or
disable the audit log. This choice does not influence continuation selection, but it
prevents the managed API from silently presenting a newly created partial audit log
as the old one.

Deletion is a compare-and-swap mutation and is valid only after the consumer has stopped
the corresponding live `AgentSession`. When a transcript or audit log exists, failure to
acquire every applicable exclusive writer lock produces `AgentSessionInUseError`.
Deletion rejects any different prepared maintenance operation; the consumer must retry or
resolve that exact transaction first. Registry-only mode cannot prove that another
process holds a live in-memory object; if deletion races a later checkpoint
publication, CAS prevents resurrection and that live session becomes persistence-blocked.
This limitation is explicit because `SessionManager` deliberately does not retain the
consumer's live-session map.

A retained tombstone prevents reuse of its stable ID. The managed API never creates an
undiscoverable orphan by removing the registry while retaining a session log. Only the
validated fully destructive combination forgets the managed identity sufficiently for
later reuse. Externally copied or consumer-managed files are outside that guarantee.

Additional boundaries:

- Removing a registry entry is prohibited unless every configured session log is explicitly
  deleted in the same request.
- Deleting a transcript never silently removes its registry entry.
- Deleting an audit log never deletes its transcript or registry entry.
- Handoff and switch update one registry entry; they never create a new logical session.
- A session with transcripts disabled remains discoverable when its registry is enabled.
- Unregistered transcript import is deferred in v0 and never automatic.

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

The effective defaults from section 3 are part of the file header and registry session-log
metadata. Configuration is validated against implementation safety ceilings:

```ts
interface PersistedTruncation {
  /** Schema-relative field path; never a filesystem path extracted from content. */
  field: string;
  reason: "field_limit" | "record_limit";
  originalBytes: number;
  /** Present only when includeTruncationDigests was explicitly enabled. */
  originalSha256?: string;
}

interface OmittedPersistedValue {
  omitted: true;
  reason: "field_limit" | "record_limit" | "max_depth";
  originalBytes?: number;
  originalSha256?: string;
}
```

V0 accepts `maxRecordBytes` from 4 KiB through 16 MiB,
`maxCapturedFieldBytes` from 1 KiB through `maxRecordBytes`, `maxJsonDepth` from 1 through
128, and `maxCursorBytes` from 256 bytes through 16 KiB. The implementation may lower a
platform-specific hard ceiling only by failing configuration explicitly; it never silently
changes an effective limit recorded in the header.

Record size is the UTF-8 encoding of the JSON object excluding its trailing newline. All
sizes are encoded UTF-8 byte counts, not JavaScript string lengths. String truncation
ends on a Unicode code-point boundary. Structured values are depth-checked and serialized
deterministically before measurement; an oversized/deep structured value is replaced as a
whole with `OmittedPersistedValue` rather than cut into invalid JSON. When explicitly
enabled, digests cover the complete omitted representation and provide only
correlation/integrity diagnostics, not content recovery or tamper resistance.

Truncation digests default off for every preset, including `diagnostic`. A plain hash of a
low-entropy secret, path, command, or configuration value can enable offline guessing, so
the library emits `originalSha256` only when that individual log's
`includeTruncationDigests` is explicitly true. Enabling digests never authorizes capture
of an otherwise excluded field.

Cyclic values, non-JSON values, and values whose depth cannot be safely established are
rejected or replaced according to whether the containing field is structural or
capturable; they are never passed recursively to an unbounded native serializer.

Capture-policy filtering precedes size enforcement, so hashes and byte counts are never
computed or persisted for content the policy disallows. Within an admitted record, size
reduction removes raw duplicates and tool results before reasoning, tool invocation input,
and message text. Every removal is described in envelope `truncation`. If the record still
exceeds `maxRecordBytes`, the next largest admitted nonstructural field is replaced until
it fits or no truncatable field remains.

Every admitted message keeps a physical `TranscriptMessageRecord`. Its `text` remains a
valid string and is shortened on a code-point boundary when necessary; it is never
replaced by `OmittedPersistedValue`. Optional `structured` content may be omitted as a
whole, with the omission described in the envelope. Consequently, conversation
availability becomes `partial` when retained message text was shortened or optional
structured content was omitted—not because the writer silently dropped an entire message
record. Fields whose declared type is `JsonValue` may contain an
`OmittedPersistedValue`; narrower structural fields may not.

Identity, log/version/generation/sequence fields, operation boundaries, transition
activation/history facts, checkpoint integrity fields, and header policy/limit fields are
never truncated. A structural record which exceeds the hard record or depth limit is a
typed persistence failure and follows the applicable pre/post-dispatch failure contract.
This prevents a truncated checkpoint or operation marker from appearing authoritative.

Readers reject a complete physical line larger than the effective record limit before
JSON decoding. Before base64url decoding a cursor they enforce `maxCursorBytes`; after
decoding they validate JSON depth, schema, integer ranges, identities, offsets, and filter
fingerprints before filesystem access. A header cannot raise a reader above the library's
hard safety ceilings.

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
- audit-log persistence gaps, corruption, replacement, and cursor invalidation.
- creation, offline persistence reconfiguration, and deletion maintenance prepared,
  resumed, completed, or conflicted.
- configuration mismatch resolved or partially resolved.
- promptability changed, carrying the complete blocker list.

Listener exceptions remain observation failures. They never roll back persistence,
change the session state, or manufacture operation failure records.

## 26. Required tests

### Configuration and capture

- Default root, environment override, and explicit-root precedence.
- Direct `AgentSession.create()` with omitted persistence creates no files.
- Direct `AgentSession.open()` receives an adapter explicitly; persistence never creates
  or globally resolves one.
- Managed creation with omitted per-session options writes the registry and that
  session's default `activity` transcript, but no audit log.
- `SessionManager.createAgentSession()` records the created session; direct
  `AgentSession.create()` never appears in its registry implicitly.
- Manager create/load calls receive their adapter per operation; manager configuration
  contains no adapter resolver or default adapter.
- `getAgentSessionInfo()` returns metadata rather than a live object and exposes the
  adapter ID needed for consumer resolution.
- Per-session transcript settings override manager defaults and explicit
  `transcript: false` produces a registry-only managed session.
- Layered persistence merging is field-wise as specified: a per-session log object can
  re-enable a manager-disabled log from library defaults, while a per-session `false`
  remains final. Managed `persistence: false` is rejected.
- Manager `required`/`forbidden` transcript and audit constraints are checked after full
  merge on both create and load, before a log is opened or a harness starts, and never
  silently modify the resolved configuration.
- An operations-only transcript with `messages: "none"` writes no user or assistant
  message content while retaining structural continuation records.
- `tools: "input"` retains commands, arguments, paths, and edit patches but excludes tool
  results, terminal output, and returned file contents.
- Enabling an audit log creates a physically separate session log with a distinct identity,
  generation, sequence, path, and effective policy.
- Audit-only persistence (`transcript: false`, `auditLog: {}`) records operations but does
  not become a continuation source; reopening still requires the registry or a
  consumer-supplied checkpoint.
- The audit log never contains messages, checkpoints, raw ACP traffic, handoff summary
  content, consumer continuation content, session-configuration checkpoints, canonical
  history entries, or consumer reason text. Adding a field to a transcript schema cannot
  enter an audit record without changing its explicit audit projection.
- Transcript and audit destinations resolving to the same file are rejected.
- `create()` never restores and `open()` never creates a missing logical session.
- A registry-declared missing transcript fails before harness startup with
  `TranscriptNotFoundError`; registry-only restoration does not require one.
- Consumer continuation cannot bypass an unexpectedly missing authoritative transcript;
  it is allowed after explicit repair or when no transcript was configured.
- Missing, unreadable, corrupt, and identity-mismatched transcripts produce distinct
  typed failures.
- A registry-declared missing, unreadable, corrupt, or identity-mismatched audit log
  produces its corresponding typed audit failure without being used as continuation
  evidence.
- Conflicting identity candidates fail instead of applying identifier/path precedence.
- `persistence: false`, registry-only, transcript-only, and both-enabled behavior.
- Existing directory, existing file, nonexistent file, and invalid filesystem path.
- Absolute normalization, tilde expansion, and default-store symlink rejection.
- Persistence-limit defaults, override validation, and hard-ceiling rejection.
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
- Any restoration configuration retained by transcript transition/history records obeys
  `sessionConfiguration`; structural classification does not bypass that policy.

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
- Canonical transition folding reconstructs identical history/configuration/timestamps and
  digest across clean, failed-before-activation, and failed-after-activation transitions.
- Canonical history includes stable transition IDs/reason codes but excludes capture-
  controlled reason text, producing the same digest under every capture preset.
- The pure reducer is used by writer/open/repair/read paths and produces byte-identical
  state and repair descriptions for the same checkpoint and structural tail.
- Full internal-session history is absent from continuation checkpoints; transcript
  transitions rebuild it and registry-only mode retains it in the registry record.
- Default deletion tombstones and retains the transcript; include-deleted listing and
  every combination of explicit transcript/audit deletion and hard registry removal are
  tested.
- Ordinary load rejects a tombstone. Explicit restore clears it only after successful
  continuation, durable checkpointing, and CAS registry publication.
- Restoring a tombstone whose transcript was deleted requires an explicit replacement
  transcript or transcript-disabled choice.
- Restoring a tombstone whose audit log was deleted requires an explicit replacement
  audit log or audit-disabled choice, independently from transcript continuation.
- Hard registry removal without deletion of every configured session log is rejected before
  mutation; the fully destructive combination permits later stable-ID reuse.
- Offline persistence reconfiguration requires a stopped session, revision CAS, explicit
  loss acknowledgements, and a validated checkpoint; it never clears dirty recovery or
  metering/configuration mismatch.
- Checkpoint lookup defaults to resolved authority; explicitly requesting the registry
  projection after transcript loss returns `authoritative: false` rather than silently
  promoting it.
- Replacement becomes durable before registry publication, and retrying an interrupted
  replacement recognizes only the same `reconfigurationId`.
- Creation interrupted after preparing one or more logs is resumable only with the same
  creation ID/request digest; an unrelated retry cannot claim an initialized destination.
- Creation failure cleanup removes only files proven to belong to that attempt, and crash
  simulation covers each log installation and registry-finalization boundary.
- Prepared creation, reconfiguration, and deletion are mutually exclusive through one
  maintenance slot and have idempotent same-ID retries.
- Deletion acquires log locks before publishing its prepared marker. Crashes after prepare,
  each unlink, each directory sync, and before final CAS remain visibly
  `maintenance_pending` and are completed by an identical retry.
- An active transcript or audit writer prevents deletion; a registry-only
  delete/checkpoint race cannot resurrect the record.
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
- `accept_effective` persists only policy-admitted values and yields promptable partial
  restoration when values were omitted. Ordered `replace_desired` checkpoints every
  successful selection and leaves mismatch active after a later failure.
- Promptability reports the complete deterministic blocker set and changes only when its
  continuation, recovery, configuration, persistence, maintenance, or lifecycle inputs
  change.
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
- Every permutation where one pre-dispatch store succeeds and a later store fails writes
  `aborted` to each successful log and a settled checkpoint where possible.
- A durable `aborted` record is restored as proven-not-dispatched; failure to persist the
  compensating abort leaves the original `started` boundary uncertain.
- Queue cancellation before persistence writes no operation record; cancellation after a
  durable start but before dispatch writes `aborted(pre_dispatch_cancelled)`.
- With an audit log enabled, dispatch never occurs unless both transcript/registry and
  audit operation-start boundaries required by the configuration are synchronized.
- A post-dispatch audit failure reports an audit gap and blocks subsequent state-changing
  operations without changing continuation recovery status.
- Registry-only mode persists in-flight state before dispatch; `persistence: false`
  explicitly does not claim a durable crash boundary.
- With both continuation stores disabled, no callback or notification is represented as a
  durable pre-dispatch checkpoint integration.
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
- Crash after durable `target_activated` but before its checkpoint deterministically
  rebuilds the exact timestamp/revision/history/checkpoint and reports the repair directly
  in `AgentSessionOpenResult.repairs`.
- A torn final line is ignored; a malformed complete v2 middle line is corruption.
- ACP replay may import observable evidence but remains uncertain in v0.
- Resume without replay remains uncertain, and successful load alone is not proof of
  reconciliation.
- Default continuation recovery attempts only the recorded internal session. Transcript
  reconstruction and consumer continuation occur only when explicitly configured.
- Successful and failed opens expose ordered attempts, prior-thread availability, active
  thread identity, retained-conversation availability, and reconstruction source through
  their continuation report.
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
- Every page, including an empty one, returns its inclusive snapshot cursor; all navigation
  cursors remain bound to it.
- `listActivityStates()` accepts only a same-log snapshot cursor, folds through its
  inclusive high-water sequence, filters after folding, and orders by latest revision
  sequence with `activityId` ties.
- Reusing a cursor with another view/filter/transcript fails.
- Transcript and audit cursors cannot be used across log kinds; audit pagination has
  the same bounded snapshot and generation guarantees.
- Timeline accepts only timeline-record `types`; conversation rejects `types` and records
  accepts all known record types.
- Truncation, replacement, rewrite, and generation change invalidate old cursors.
- Cursor validation rejects hostile offsets and oversized payloads.
- Writers enforce UTF-8 field/record limits, valid code-point truncation, deterministic
  structured omission, max JSON depth, and the specified truncation priority.
- Message records are never physically omitted; text remains a valid possibly-shortened
  string and optional structured content can be omitted without violating its declared
  type.
- Truncation digests are absent by default (including diagnostic preset), appear only after
  explicit per-log opt-in, and never hash capture-policy-excluded content.
- Disallowed capture-policy content is removed before size measurement and never leaves a
  hash or byte-count trace.
- Structural records are never truncated; an oversized structural record produces the
  correct pre- or post-dispatch persistence failure.
- Readers reject oversized lines and cursors before JSON/base64 decoding and never honor a
  header limit above the hard safety ceiling.
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

1. Introduce public configuration and layer merging, manager constraints, preset
   expansion, sink-specific transcript-v2/audit-v1 schemas, persistence limits,
   checkpoint digest, typed errors, and compatibility normalization.
2. Implement the central atomic registry, its generalized maintenance transaction, and
   `listAgentSessions()` pagination. Exercise prepared creation/reconfiguration/deletion
   crash boundaries before exposing managed mutation.
3. Implement independent transcript/audit projections and writers, filtering before
   enqueue, sequencing, truncation policy, canonical lock ordering, and durable flush.
4. Implement the pure transcript reducer and make operation write-ahead/aborted
   compensation, transition activation, checkpoint publication, opening, repair, and
   reader folding consume it rather than duplicating state logic.
5. Add checkpoint-based open/restore, per-operation adapter inputs, configuration-
   mismatch resolution, explicit promptability composition, and the ordered continuation-
   acquisition strategy pipeline.
6. Add snapshot-bound transcript/audit pagination, projections, activity folding, and
   bounded iteration.
7. Add migration utilities and mixed v1/v2 reading.
8. Integrate CLI presentation and manual deletion only after the consumer-facing APIs are
   stable.

## 28. Deferred work

- Automatic retention policies and transcript rotation/segmentation.
- Transcript compaction and redaction rewrite tools.
- Tamper-resistant audit storage or HMAC key management.
- Billing truth; the metering specification deliberately assigns durable accounting to
  the consumer.
- General automatic discovery/import of arbitrary harness sessions.
- Healthy-log relocation, general orphan import, in-place continuation of an audit
  log after an acknowledged gap, and live-session persistence repair.
- A direct-session pre-dispatch persistence coordinator outside `SessionManager`.
- Adapter-certified automatic replay reconciliation.
- Exactly-once recovery of provider calls or external tool side effects, which neither
  ACP nor local filesystem checkpoints can guarantee.
