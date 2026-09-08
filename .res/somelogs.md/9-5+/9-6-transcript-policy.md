With metering delegated, the remaining roadmap was:

1. Transcript capture/security policy — probably next.

   Current primitives exist (`transcriptActivity`, `kinds`, `rawOutput`, `maxBytes`, wire logging), but there is no coherent policy describing what may be persisted. We wanted explicit profiles such as:

   - `off`
   - `messages` — user/assistant text only
   - `activity` — messages plus selected tool/thinking activity
   - `diagnostic` — full ACP lifecycle/wire information

   This also needs path redaction, tool-call/output exclusion, and a firm rule that excluded information is never written—not merely hidden when reading.





---



I would use a hybrid:

- Modular capture policy as the real contract.
- Named ladder-like presets as convenience configurations.

A pure ladder becomes awkward because sensitivity is not monotonic. A consumer may want tool names without tool input/output, usage without conversation text, or messages without reasoning. “More detail” can suddenly mean “store secrets.”

The underlying model should be component-based:

```ts
transcript: {
  preset?: "conversation" | "operations" | "diagnostic";

  capture: {
    messages?: "none" | "text";
    reasoning?: "none" | "text";
    tools?: "none" | "metadata" | "content";
    lifecycle?: boolean;
    handoffs?: boolean;
    usage?: boolean;
    protocol?: "none" | "metadata" | "raw";
  };
}
```

Presets expand into an explicit policy:

```text
conversation
  messages=text
  everything else=none

operations
  messages=text
  tools=metadata
  lifecycle=true
  handoffs=true
  usage=true

diagnostic
  everything captured
  protocol=raw
```

But callers can override individual components:

```ts
transcript: {
  preset: "operations",
  capture: {
    messages: "none",
    tools: "metadata",
    usage: true,
  },
}
```

That supports a billing/audit consumer which wants operational records but no conversational content.

I would also keep `off` outside the ladder:

```ts
transcript: false
```

This is clearer than a preset because it guarantees no transcript writer is created.

Two important rules:

1. Filtering happens before persistence.

   Excluded data must never enter a transcript record and then be hidden by the reader.

2. Explicit component settings override the preset.

   A preset is only shorthand expanded at session creation. Internally, the library retains one resolved `TranscriptPolicy`, so there is no ambiguity later.

I would not let `diagnostic` casually imply raw protocol capture without a prominent dangerous designation. Raw ACP traffic can contain prompts, tool results, paths, initialization information, and possibly authentication-related data. Something like this would be more honest:

```ts
transcript: {
  preset: "diagnostic",
  allowSensitiveProtocolCapture: true,
}
```

Or keep raw wire capture as a separate explicit component requiring its own destination.

So the answer is: modular underneath, ladder/presets on top. The modular policy is necessary for security; presets preserve usability.



Yes, I agree. An additional `allowSensitiveProtocolCapture` flag would be redundant ceremony if the user explicitly selected a documented diagnostic/raw capture mode.

The important boundary is that debug logging and transcript capture remain separate:

```ts
logger: {
  level: "debug",
}
```

must not implicitly enable:

```ts
transcript: {
  preset: "diagnostic",
}
```

But explicitly selecting `diagnostic` should itself mean:

> Persist full operational and protocol data. This may contain sensitive information.

No second confirmation flag is necessary.

So:

```ts
transcript: false
```

or:

```ts
transcript: {
  preset: "conversation" | "operations" | "diagnostic",
  capture?: {
    // optional per-component overrides
  },
}
```

`diagnostic` includes raw protocol capture by definition. The warning belongs in documentation and type comments, not in another boolean the consumer must mechanically enable.






# 1st shape

Yes, transcript configuration should become one coherent object. Presence enables persistence; absence or `false` disables it.

```ts
type TranscriptConfig =
  | false
  | {
      destination:
        | {
            kind: "file";
            path: string;
          }
        | {
            kind: "directory";
            path: string;
          };

      preset?: "conversation" | "operations" | "diagnostic";
      capture?: Partial<TranscriptCapturePolicy>;
    };
```

Usage:

```ts
// No persistence
AgentSession.create({
  transcript: false,
});
```

```ts
// Consumer chooses the exact filename
AgentSession.create({
  transcript: {
    destination: {
      kind: "file",
      path: "/data/conversations/customer-123.jsonl",
    },
    preset: "conversation",
  },
});
```

```ts
// Library derives the filename from agentSessionId
AgentSession.create({
  agentSessionId: "agent/session:1",
  transcript: {
    destination: {
      kind: "directory",
      path: "/data/conversations",
    },
    preset: "operations",
  },
});
```

The directory result remains deterministic:

```text
/data/conversations/agent%2Fsession%3A1.jsonl
```

No separate `enabled` property is necessary. A transcript object means enabled; `false` or omission means disabled.

The existing `transcriptPath`, `transcriptDir`, and `transcriptActivity` should become compatibility inputs that normalize into this model, then eventually be removed.

## Default location

I would not make the core library write to `~/.library` by default.

Implicit disk persistence would be surprising for:

- server applications;
- ephemeral agents;
- security-conscious consumers;
- tests;
- consumers with their own database;
- applications processing private conversations.

It would also reverse the useful current rule that omitting transcript configuration means no disk writes.

Instead:

- Core library: no persistence by default.
- Single-session CLI: may default to an application data directory.
- Managed CLI: should default to its own persistent data directory.
- Consumer applications: choose their own destination.

The CLI default should also follow platform conventions instead of the vague `~/.library`:

```text
Linux:   $XDG_DATA_HOME/acp-lib/transcripts
         ~/.local/share/acp-lib/transcripts

macOS:   ~/Library/Application Support/acp-lib/transcripts

Windows: %LOCALAPPDATA%\acp-lib\transcripts
```

We can expose a helper so consumers can intentionally choose the same convention:

```ts
defaultTranscriptDirectory("acp-lib")
```

But calling `AgentSession.create()` should never invoke it automatically.

One more semantic rule should remain explicit: selecting a transcript file controls only history persistence. Its existence must not implicitly load or resume an internal ACP session. Provider-thread selection remains controlled by the startup/session options.




That makes sense. I prefer the single `path` too, with one important rule for nonexistent paths.

```ts
transcript: {
  path?: string;
  preset?: "conversation" | "operations" | "diagnostic";
  capture?: Partial<TranscriptCapturePolicy>;
}
```

Resolution would be:

1. Existing directory → derive `<agentSessionId>.jsonl`.
2. Existing regular file → use it exactly.
3. Nonexistent path → treat it as an exact file path.
4. Anything else → reject.

This avoids filename-extension heuristics. If the consumer wants a new directory, it must create it first. The library-owned default directory is created before resolution.

## Persistence model

With a default registry, I think transcript and registry configuration belong under a broader persistence model:

```ts
interface PersistenceConfig {
  /**
   * Default: ~/.acp-client
   * A consumer should override this to isolate its application.
   */
  root?: string;

  registry?:
    | false
    | {
        store?: SessionStore;
      };

  transcript?:
    | false
    | {
        /**
         * Existing directory: library derives filename.
         * Existing file or nonexistent path: exact filename.
         * Omitted: <root>/transcripts directory.
         */
        path?: string;
        preset?: TranscriptPreset;
        capture?: Partial<TranscriptCapturePolicy>;
      };
}
```

Then:

```ts
await AgentSession.create({
  persistence: {
    transcript: {
      path: "/custom/existing-directory",
      preset: "operations",
    },
  },
});
```

And complete opt-out:

```ts
await AgentSession.create({
  persistence: false,
});
```

Selective opt-out remains possible:

```ts
await AgentSession.create({
  persistence: {
    registry: {},      // enabled
    transcript: false, // no conversational persistence
  },
});
```

## Defaults

I accept the argument for default persistence. For this kind of library, behaving like the harnesses is reasonable:

```text
~/.acp-client/
  registry.jsonl
  transcripts/
    <encoded-agentSessionId>.jsonl
```

Exact storage format remains a separate choice; the existing `FileSessionStore` may dictate the registry representation.

Default behavior:

```ts
persistence: {
  root: "~/.acp-client",
  registry: {},
  transcript: {
    preset: "conversation",
  },
}
```

The documentation should prominently show:

```ts
persistence: false
```

because default transcript persistence means user/assistant content is written to disk.

A consumer such as the orchestration library should normally choose its own root:

```ts
persistence: {
  root: "~/.agents",
}
```

That prevents different applications using `acp-lib` from sharing one accidental session namespace.

## Registry responsibility

Yes, I think a registry should be enabled by default and should become the authoritative inventory of logical sessions created through the library.

It should store metadata, not live objects:

```ts
interface AgentSessionRecord {
  agentSessionId: string;
  adapterId: string;
  internalSessionId: string | null;
  transcriptPath: string | null;

  cwd?: string;
  title?: string;

  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  status: "active" | "stopped" | "unavailable";
}
```

The consumer still owns:

```ts
Map<agentSessionId, AgentSession>
```

The registry tells it what exists and how to reconstruct one. It does not keep processes alive.

This also resolves several earlier ambiguities:

- `list()` reads the registry, not the transcript directory.
- Reopening uses registered session metadata.
- A transcript never selects the provider thread.
- Missing transcripts do not erase registered sessions.
- Transcript-directory scanning becomes a recovery/import tool, not normal loading.
- Sessions with `transcript: false` remain listable.
- Custom adapters remain consumer-resolved through `adapterId`; the registry should not blindly execute stored command lines.

The existing `transcriptPath`, `transcriptDir`, `transcriptActivity`, and direct session-manager wiring can be deprecated and normalized into `persistence` during the compatibility period.

So the new default philosophy would be:

> `acp-lib` persistently catalogs sessions and stores conversation transcripts by default, under its application root. Consumers may relocate, customize, or disable either facility independently.


You're right. I conflated “file-per-session catalog” with a registry, but that removes the single authoritative catalog you explicitly want.

The correct default layout is:

```text
~/.acp-client/
  agent-sessions.json
  transcripts/
    <encoded-agentSessionId>.jsonl
```

There are two different kinds of storage:

- `agent-sessions.json`: the authoritative registry of every logical session.
- One transcript file per session: append-only conversation/activity history.

No metadata file beside every transcript.

## Registry shape

A full JSON document is appropriate:

```ts
interface AgentSessionsRegistryFile {
  version: 1;
  revision: number;
  updatedAt: string;

  sessions: Record<string, SessionRecord>;
}
```

Example:

```json
{
  "version": 1,
  "revision": 14,
  "updatedAt": "2026-09-06T18:30:00.000Z",
  "sessions": {
    "agent-session-123": {
      "agentSessionId": "agent-session-123",
      "internalSessionId": "internal-thread-456",
      "adapterId": "opencode",
      "mode": "normal",
      "cwd": "/workspace/project",
      "title": "Refactor authentication",
      "transcriptPath": "/home/user/.acp-client/transcripts/agent-session-123.jsonl",
      "createdAt": "2026-09-06T17:00:00.000Z",
      "updatedAt": "2026-09-06T18:30:00.000Z"
    }
  }
}
```

Using an object keyed by `agentSessionId` makes lookup and replacement explicit. `list()` converts its values to a sorted array.

The filename should be `agent-sessions.json`. It is specific enough, and `acp-client` is already established by the enclosing directory. `registry.json` is vague; `acp-client-agent-sessions.json` is redundant.

## Source-of-truth rule

The registry is authoritative for session existence and routing:

```text
Does this logical session exist?
Which adapter owns it?
What is its current internalSessionId?
Where is its transcript?
How should it be reopened?
```

The transcript is not used to discover sessions. Therefore:

- Missing transcript does not delete the registry entry.
- An unregistered transcript does not automatically create a session.
- Directory scanning is only an explicit recovery/import operation.
- A session with transcripts disabled still exists in the registry.
- Handoff updates the existing registry entry; it does not create another logical session.

## File updates

Because it is mutable shared state, updates should not directly overwrite the file in place.

The write flow should be:

1. Serialize registry mutations inside the process.
2. Read the latest registry.
3. Update one keyed session.
4. Increment `revision`.
5. Write a temporary sibling file.
6. Flush and atomically rename it over `agent-sessions.json`.

Cross-process writers require locking or compare-and-swap semantics. We should either implement that or explicitly declare the default JSON registry single-writer initially. Silent last-writer-wins would be inappropriate for an authoritative registry.

So the corrected defaults are:

```text
root              ~/.acp-client
session registry  ~/.acp-client/agent-sessions.json
transcript dir    ~/.acp-client/transcripts
transcript file   ~/.acp-client/transcripts/<encoded-agentSessionId>.jsonl
preset            operations
```

That preserves one real registry while keeping large append-only transcript content out of the mutable catalog.







Yes. The coherent default layout is:

```text
~/.acp-client/
  agent-sessions.json
  transcripts/
    <encoded-agentSessionId>.jsonl
```

`agent-sessions.json` is the authoritative mutable registry. `transcripts/` contains append-only conversational records keyed by the same stable ID.

## Registry structure

Model, protocol, and implementation identity should be typed first-class fields. A generic metadata field can exist for consumer-specific information:

```ts
interface AgentSessionsRegistryFile {
  version: 1;
  revision: number;
  updatedAt: string;
  sessions: Record<string, SessionRecord>;
}

interface SessionRecord {
  agentSessionId: string;
  internalSessionId: string | null;

  adapterId: string;
  mode: "normal" | "degraded";
  cwd?: string;
  title?: string;

  model: string | null;

  protocol:
    | {
        name: "acp";
        version: number;
      }
    | {
        name: "pty";
      };

  agent?: {
    name?: string;
    title?: string;
    version?: string;
  };

  transcriptPath: string | null;
  transcriptPreset: TranscriptPreset | null;

  meteringCheckpoint?: MeteringCheckpoint;

  metadata?: Record<string, JsonValue>;

  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}
```

The installed SDK currently declares `PROTOCOL_VERSION = 1`, and initialization returns the negotiated protocol version. We should store the negotiated value, not hardcode `1` into the registry schema. That allows a future session to say it was created through ACP v2 without requiring a registry format change.

For degraded mode, there is no ACP protocol version:

```ts
protocol: { name: "pty" }
```

`model` should not live only under `metadata`. It affects pricing, handoff, reopening, diagnostics, and certification, so it deserves a defined field. It should be updated whenever the active model configuration changes.

## Metering checkpoint

Yes, the registry is a reasonable place for the operational metering checkpoint:

```ts
interface MeteringCheckpoint {
  version: number;
  state: AgentSessionMeteringState;
  lastOperationId: string | null;
  updatedAt: string;
}
```

This checkpoint exists so reopening can restore:

- cumulative ACP baselines;
- stable session totals;
- blocking state;
- unallocated usage;
- the last successfully persisted metering transition.

It is not the billing ledger.

```text
OperationMeteringRecords → durable accounting/audit history
meteringCheckpoint       → current resumable state
transcript               → conversation history
```

Editing either the transcript or registry is possible for someone with filesystem access. That is acceptable for the default local store because it is operational persistence, not tamper-resistant financial storage. A production billing consumer should provide its own database-backed `SessionStore`/usage repository and atomically commit the operation record and checkpoint.

The transcript must never be used to reconstruct billing state.

## Registry concurrency

Because the registry is one full JSON document, safe mutation needs to be part of its contract:

1. Acquire an inter-process registry lock.
2. Read and validate the latest complete document.
3. Apply one mutation.
4. Increment `revision`.
5. Write a temporary sibling file.
6. Flush it.
7. Atomically rename it over `agent-sessions.json`.
8. Release the lock.

Without the lock, two processes can both read revision 10, independently write revision 11, and silently lose one session.

I would also retain the previous valid revision as:

```text
agent-sessions.json.bak
```

If the primary file is invalid, loading must not silently return an empty registry. It should either recover from the valid backup while emitting a recovery notification, or fail explicitly if both are invalid.

## Required registry tests

At minimum:

- Many concurrent updates to different sessions lose no records.
- Concurrent updates to the same session never produce invalid JSON.
- Revisions increase monotonically.
- Repeated updates preserve unrelated sessions and consumer metadata.
- Termination during temporary-file writing leaves either the previous or next valid registry.
- A malformed primary recovers from a valid backup with an observable warning.
- Malformed primary and backup fail loudly rather than appearing empty.
- A stale lock has a bounded, tested recovery policy.
- Transcript writes and registry mutations cannot corrupt each other.
- Handoff updates the existing session entry rather than creating another.
- Model/config changes update the corresponding entry.
- Metering operations and reconciliation update `meteringCheckpoint`.
- Reopen restores the latest committed checkpoint.
- Sessions with transcripts disabled remain in the registry.
- Deleting a registry entry does not implicitly delete its transcript unless an explicit destructive option requests both.

One migration issue should be recorded: the current default store is file-per-session under `~/.acp-lib/sessions`. Moving to `~/.acp-client/agent-sessions.json` requires an explicit one-time import/migration path; we should not strand existing sessions or silently maintain two competing registries.





Yes. I would keep `internalSessionId` for the current one—the “current” meaning is already established—and add a structured `internalSessionHistory`.

A plain `pastInternalSessionIds: string[]` loses important information once switching adapters/models is possible.

```ts
interface InternalSessionHistoryEntry {
  internalSessionId: string;
  adapterId: string;
  model: string | null;

  protocol: {
    name: "acp";
    version: number;
  };

  activatedAt: string;
  deactivatedAt: string;

  transition:
    | {
        kind: "handoff";
        handoffId: string;
      }
    | {
        kind: "switch";
        switchId: string;
      }
    | {
        kind: "mode_change";
      }
    | {
        kind: "replacement";
        reason?: string;
      };
}
```

Then:

```ts
interface SessionRecord {
  agentSessionId: string;

  /** Current backing ACP session. */
  internalSessionId: string | null;

  /** Current routing configuration. */
  adapterId: string;
  model: string | null;
  protocol:
    | { name: "acp"; version: number }
    | { name: "pty" };

  /** Previous ACP sessions, oldest to newest. Does not include the current session. */
  internalSessionHistory: InternalSessionHistoryEntry[];

  // ...
}
```

I prefer `internalSessionHistory` over:

- `pastInternalSessionIds`: loses adapter/model/transition information.
- `archivedInternalSessions`: implies the harness session was archived or cannot be resumed.
- `oldInternalSessions`: unclear.
- `previousInternalSessions`: reasonable, but “history” communicates ordering and long-term retention better.

The important invariants would be:

- `internalSessionId` always means the currently active backing session.
- `internalSessionHistory` never contains the current ID.
- Entries are ordered by `activatedAt`.
- A transition atomically appends the former session and changes the current fields.
- A failed transition that keeps the old session active does not append it.
- Historical entries are immutable after being appended.
- No generated handoff summary or conversational content is stored in the registry.

Example:

```json
{
  "agentSessionId": "logical-123",
  "internalSessionId": "codex-thread-9",
  "adapterId": "codex",
  "model": "gpt-5.3-codex",
  "internalSessionHistory": [
    {
      "internalSessionId": "claude-thread-4",
      "adapterId": "claude",
      "model": "claude-opus-4-6",
      "protocol": {
        "name": "acp",
        "version": 1
      },
      "activatedAt": "2026-09-06T10:00:00.000Z",
      "deactivatedAt": "2026-09-06T12:00:00.000Z",
      "transition": {
        "kind": "switch",
        "switchId": "switch-456"
      }
    }
  ]
}
```

This also gives us useful future operations:

```ts
session.internalSessionHistory;
session.getInternalSessionHistory();

await session.revisitInternalSession(historyEntry);
```

The last operation would need careful semantics—it would itself be a switch, not a silent pointer mutation—but the registry would already contain the information needed to offer it.



# 2nd shape


The main shape is defined. Before writing the specification, a few behavioral details remain.

## 1. Exact preset matrix

We should freeze precisely what each preset writes:

| Component | `conversation` | `operations` default | `diagnostic` |
|---|---:|---:|---:|
| User/assistant text | yes | yes | yes |
| Reasoning text | no | no | yes |
| Tool name/status/timing | no | yes | yes |
| Tool arguments/commands/paths | no | no | yes |
| Tool output/diffs | no | no | yes |
| Lifecycle events | no | yes | yes |
| Handoff boundary | metadata | metadata | full |
| Handoff summary | no | no | yes |
| Permission decision | no | metadata | full |
| Usage/context | no | yes | yes |
| Raw ACP traffic | no | no | yes |

“Metadata” must be a strict allowlist. ACP titles and error strings cannot automatically count as metadata because they may contain commands, paths, or output.

## 2. Custom capture overrides

Recommended rule:

```ts
transcript: {
  preset: "operations",
  capture: {
    messages: "none",
    tools: "metadata",
    usage: true,
  },
}
```

Explicit fields override the preset. The resolved immutable policy should be stored in the session registry so historical behavior is explainable.

The policy governs persistence only. It does not filter live `onActivity`/listener events.

## 3. Default-root precedence

I suggest:

```text
persistence.root option
    ↓
ACP_CLIENT_HOME environment variable
    ↓
~/.acp-client
```

Default paths:

```text
<root>/agent-sessions.json
<root>/transcripts/<encoded-agentSessionId>.jsonl
```

The root directory should default to owner-only permissions, and newly created registry/transcript files should not be world-readable.

## 4. Registry concurrency and recovery

We still need to select the precise mechanism:

- Atomic sibling temporary file plus rename.
- One cross-process registry lock.
- Monotonic `revision`.
- Previous valid `agent-sessions.json.bak`.
- Corrupt primary recovers from backup with an observable warning.
- Both invalid means a visible startup error, never an empty registry.

The locking mechanism must include stale-lock recovery and tests involving separate processes, not only concurrent promises.

## 5. Session-creation failure semantics

Recommended:

- Do not register before an `agentSessionId` exists.
- Once provider startup succeeds, write the active record.
- If startup fails before an internal session exists, do not create a normal session entry.
- If the provider session was created but later initialization/persistence fails, retain an `unavailable` registry entry so the created provider thread is not lost.
- Registry failure in default-persistent mode should fail session creation rather than create an untracked session.
- `persistence.registry: false` explicitly permits an unregistered session.

## 6. Transition atomicity

For handoff/switch, one locked registry mutation must:

1. Append the former internal session to `internalSessionHistory`.
2. Replace current `internalSessionId`.
3. Replace current adapter/model/protocol fields.
4. Update the transcript path/policy if necessary.
5. Update `updatedAt` and registry revision.

A failed transition that preserves the previous backing session makes no history change.

## 7. Deletion semantics

We should avoid ambiguous `delete()` behavior:

```ts
await sessions.remove(agentSessionId); // registry entry only

await sessions.purge(agentSessionId);  // registry + library-owned transcript
```

`purge()` must not delete an arbitrary consumer-selected transcript outside the library root unless separately and explicitly authorized.

## 8. Registry metadata rules

Recommended:

```ts
metadata?: Record<string, JsonValue>;
```

- Consumer-owned.
- JSON-compatible only.
- Preserved unchanged by library updates.
- Model, protocol, adapter, metering checkpoint, and transcript policy remain typed fields.
- No credentials in metadata.
- Optionally impose a size limit to prevent the registry becoming a payload database.

## 9. Migration

We need a one-time migration from:

- `transcriptPath`
- `transcriptDir`
- `transcriptActivity`
- injected `sessions`
- current `~/.acp-lib/sessions/<id>.json` records

Recommended behavior:

- Old configuration is normalized with deprecation warnings.
- Existing records are imported into `~/.acp-client/agent-sessions.json`.
- Migration is idempotent.
- Conflicting IDs are reported, not silently overwritten.
- Existing transcript files are referenced in place rather than moved automatically.

## 10. Metering checkpoint boundary

The registry can carry `meteringCheckpoint`, but its precise type should come from the metering work already assigned to the other agent.

The persistence contract should state:

- Registry checkpoint is operational restore state.
- Operation metering records remain the accounting history.
- Transcript data never rebuilds billing state.
- Reconciliation updates the checkpoint even without another prompt.
- Billing consumers may inject a store capable of atomically committing their ledger and checkpoint.

Once these are accepted, we have enough to write the transcript/persistence specification. The most consequential unresolved choice is the exact `diagnostic` behavior; everything else above has a fairly clear recommended answer.












---


We discussed the transcript lines indirectly, but we have not yet redesigned the JSONL contract around capture policies and resumable state. The current v1 format has:

```text
meta
msg
activity
permission
raw
handoff
```

It does not have a durable continuation checkpoint. That should change.

## Preset names

I would rename `operations` to `activity`, matching the library’s existing `ActivityEvent` terminology, and add `detailed`:

| Component | `conversation` | `activity` default | `detailed` | `diagnostic` |
|---|---:|---:|---:|---:|
| Messages | text | text | text | text |
| Reasoning | no | no | text | text |
| Tool name/status/timing | no | yes | yes | yes |
| Tool arguments/commands | no | no | yes | yes |
| Tool output/diffs | no | no | yes | yes |
| Lifecycle | no | yes | yes | yes |
| Handoff/switch metadata | yes | yes | yes | yes |
| Handoff summary | no | no | yes | yes |
| Permission details | no | decision only | full | full |
| Usage/context | no | yes | yes | yes |
| Initialization/configuration | no | no | no | yes |
| Raw ACP traffic | no | no | no | yes |

The ladder becomes:

```text
conversation → activity → detailed → diagnostic
```

`activity` is the default: useful to an end user without recording commands, paths, tool results, or reasoning.

## Moving away from consumer-managed internalSessionId

The consumer should not have to persist isolated fields such as:

```ts
agentSessionId
internalSessionId
adapterId
model
```

Instead, the library should expose one versioned continuation object:

```ts
interface AgentSessionCheckpoint {
  version: 1;
  revision: number;

  agentSessionId: string;

  adapterId: string;
  mode: "normal" | "degraded";
  internalSessionId: string | null;
  internalSessionHistory: InternalSessionHistoryEntry[];

  model: string | null;
  protocol: ProtocolSnapshot;

  transcriptPath: string | null;
  transcriptPolicy: ResolvedTranscriptPolicy | null;

  meteringCheckpoint?: AgentSessionMeteringState;

  updatedAt: string;
}
```

The consumer can treat this mostly as an opaque value:

```ts
const checkpoint = session.checkpoint;
```

or receive it after state-changing operations:

```ts
const result = await session.handoff();
await consumerStore.save(result.checkpoint);
```

Internally it contains `internalSessionId`, but consumers no longer need to build or understand the complete restoration record themselves.

## Persistence combinations

All combinations should work:

| Registry | Transcript | Reopening source |
|---|---|---|
| yes | yes | Latest consistent checkpoint; registry supplies discovery |
| yes | no | Registry checkpoint |
| no | yes | Latest transcript checkpoint |
| no | no | Consumer-supplied checkpoint |
| neither, no checkpoint | — | Cannot reopen; only create a new session |

Creating a new session never requires an internal ID:

```ts
AgentSession.create({
  providerSession: { kind: "new" },
  persistence: false,
});
```

Reopening without library persistence requires:

```ts
AgentSession.create({
  restore: checkpoint,
  persistence: false,
});
```

Passing only an `agentSessionId` with no registry, transcript, or checkpoint must fail. The library cannot derive its harness or backing thread from that logical identifier.

For compatibility, the current explicit form can remain deprecated:

```ts
agentSessionId,
adapter,
providerSession: {
  kind: "load",
  internalSessionId,
}
```

## Transcript as a self-contained recovery artifact

Your last-line idea is good, with one adjustment: it should be a normal versioned checkpoint record, not a special sentinel outside the JSONL model.

```json
{
  "v": 2,
  "t": "checkpoint",
  "ts": 1788720000000,
  "revision": 7,
  "reason": "handoff",
  "checkpoint": {
    "version": 1,
    "revision": 7,
    "agentSessionId": "agent-123",
    "adapterId": "opencode",
    "internalSessionId": "ses-new",
    "model": "anthropic/claude-sonnet",
    "protocol": {
      "name": "acp",
      "version": 1
    }
  },
  "digest": "sha256:..."
}
```

A checkpoint is appended whenever resumable state changes:

- initial provider session created or loaded;
- handoff;
- switch;
- mode change;
- model/configuration change affecting restoration;
- metering checkpoint update;
- reconciliation.

A reader must not blindly parse the physical last line because it may be partial after a crash or followed by normal events. It scans backward for the latest valid checkpoint.

Repeating metadata on every JSONL line would create unnecessary size and inconsistent copies. Ordinary records can reference the active checkpoint revision:

```json
{
  "v": 2,
  "t": "message",
  "ts": 1788720010000,
  "seq": 18,
  "stateRevision": 7,
  "operationId": "turn-8",
  "role": "user",
  "text": "Continue the refactor"
}
```

## Registry and transcript authority

The clean distinction is:

- `agent-sessions.json` is authoritative for inventory and discovery.
- `AgentSessionCheckpoint` is authoritative for continuation state.
- Registry and transcript may both carry the same checkpoint.
- Transcript messages/activity are not authoritative restoration state.
- Transcript content is never an accounting ledger.

When both registry and transcript exist, compare checkpoint revisions:

- Same revision and digest → consistent.
- Transcript newer → recover the registry from the transcript checkpoint.
- Registry newer → continue from the registry.
- Same revision but different digest → corruption/conflict; fail rather than guess.

Because two files cannot be atomically committed together, every state transition should construct one immutable checkpoint and write that exact object to both destinations. Its revision and digest make partial updates detectable and recoverable.

## JSONL v2 envelope

I suggest all new transcript lines share:

```ts
interface TranscriptEnvelope {
  v: 2;
  t: string;
  ts: number;
  seq: number;
  agentSessionId: string;
  stateRevision: number;
  operationId?: string;
}
```

New line types:

```text
header
checkpoint
message
activity
permission
transition
metering-reference
raw
```

`transition` generalizes the current handoff-only line:

```ts
interface TranscriptTransitionLine extends TranscriptEnvelope {
  t: "transition";
  transition: "handoff" | "switch" | "mode_change";
  phase: "started" | "completed" | "failed";
  transitionId: string;
  from: InternalSessionReference | null;
  to?: InternalSessionReference;
  error?: SanitizedError;
}
```

The exact content of `activity`, `permission`, and `raw` is filtered before constructing the persisted line according to the resolved preset.

So the central design becomes:

> The stable checkpoint is the portable continuation state. The registry indexes checkpoints globally; a transcript embeds checkpoints for self-contained recovery; a stateless consumer persists and returns the same checkpoint itself. `internalSessionId` remains internally necessary but stops being the consumer’s primary persistence API.








The architecture is mostly settled. Before writing the transcript spec, I would lock down these remaining behaviors.

1. Pagination consistency

A pagination sequence should represent a snapshot:

- The first request captures the last complete record currently in the file.
- Later pages use that same high-water mark.
- Records appended during pagination do not unexpectedly appear in later pages.
- Live updates remain the responsibility of session listeners.
- A separate `readTranscriptSince(cursor)` could later support polling/catch-up.

2. Cursor semantics

Cursors should be opaque and query-specific. Internally they can identify:

- transcript generation/file identity
- snapshot boundary
- byte offset and sequence number
- selected view and filters
- boundary digest

Changing the view or filter while reusing a cursor should fail. File truncation, replacement, compaction, or editing before the cursor boundary should produce `TranscriptCursorInvalidError`, never silently restart.

I would expose explicit navigation names instead of ambiguous `next` and `previous`:

```ts
interface TranscriptPage<T> {
  items: readonly T[];
  olderCursor: string | null;
  newerCursor: string | null;
  hasOlder: boolean;
  hasNewer: boolean;
}
```

The first page contains the newest records, but `items` are returned chronologically so they can be rendered directly.

3. What constitutes one paginated item

We need three projections:

```ts
type TranscriptView =
  | "conversation"
  | "timeline"
  | "records";
```

- `conversation`: user and assistant messages.
- `timeline`: messages, completed tool activities, permissions, transitions, failures, and metering summaries.
- `records`: physical persisted records allowed by the transcript policy.

`records` is a better public name than `raw`, because `raw` sounds like raw ACP traffic—which may not have been captured.

Checkpoints should not appear in `conversation` or `timeline`; they are persistence machinery.

4. Activity folding

Currently a tool activity can generate multiple JSONL records sharing one ID. That complicates logical pagination.

For v2, I recommend writing a terminal activity record containing the complete safe projection:

```ts
{
  t: "activity",
  phase: "completed",
  activityId: "...",
  name: "...",
  status: "...",
  durationMs: 812
}
```

Earlier progress records may still exist, but `timeline` pagination selects terminal records. This prevents a tool operation from being split across pages and avoids unbounded reconstruction across old records.

5. Ordering and limits

Suggested contract:

- Default limit: `50`
- Maximum limit: `500`
- Default view: `"timeline"`
- First request starts at the newest complete record
- Items returned oldest-to-newest
- The limit counts projected items, not physical JSONL lines

The reader may scan more physical records than the limit when filtering.

6. Partial and corrupt records

We should define:

- An incomplete final line is ignored while reading and can be repaired on the next append.
- Invalid complete records in the middle of the file produce a visible corruption error.
- Unknown future record types are skipped in projected views but returned by the records view when structurally readable.
- Checkpoint recovery scans backward for the newest valid checkpoint.

7. Transcript generations

Every transcript should have a stable `transcriptId` and `generation`.

Generation changes when the file is rewritten, compacted, imported, or otherwise replaced. Cursors carry both, allowing clean invalidation without exposing filesystem paths.

8. Indexing and segmentation

Neither needs to be part of v1:

- Backward chunked reads provide bounded-memory pagination over one JSONL file.
- An optional disposable sparse index can be added later for faster seeking.
- The index must never be authoritative and must be rebuildable.
- File segmentation can later be introduced behind the same opaque cursor contract.

9. Registry pagination

`SessionManager.list()` should use similar public pagination:

```ts
sessionManager.list({
  cursor,
  limit: 50,
  order: "updated_desc",
});
```

The default JSON registry may initially load the registry file internally. Custom database-backed stores can implement efficient pagination without changing the consumer API.

Once these are accepted, I think we have enough to write the complete persistence/transcript specification. The only substantial topic that could remain separate is lifecycle policy—deleting, exporting, importing, and retaining sessions—but that does not need to block the initial transcript implementation.




On 4, I would absolutely keep the separate lifecycle records. I was proposing a terminal record for pagination convenience, but that would weaken the transcript and mishandle tools that remain in progress.

The transcript should preserve:

```text
announced → in_progress → settled
                         ↘ failed/cancelled
```

Each transition is valuable:

- `announced`: the harness declared its intention.
- `in_progress`: execution actually began.
- `settled`: it completed.
- `failed` or `cancelled`: distinct terminal outcomes.
- No terminal event: meaningful evidence that the activity remained unfinished.

These should remain immutable JSONL records sharing an `activityId`, with a monotonic activity revision or phase sequence:

```ts
interface ActivityTranscriptRecord extends TranscriptEnvelope {
  t: "activity";
  activityId: string;
  activityRevision: number;
  phase: "announced" | "in_progress" | "settled" | "failed" | "cancelled";
  // Fields allowed by the capture policy
}
```

Pagination should operate over these events rather than pretending each tool is one physical item. The consumer can fold them by `activityId`:

```text
announced        → insert activity
in_progress      → update activity
settled          → update activity
```

That also works naturally with live listeners. The paginated and live forms represent the same state transitions.

We should document one boundary behavior: an activity’s earlier event may be on an older page. Therefore every activity event must contain enough information to render its current state independently—or consumers must treat it as an upsert, not assume they have previously received `announced`. For example, a `settled` event should include the safe tool name/type again, not only `{ activityId, phase: "settled" }`.

We could later provide a convenience projection such as:

```ts
getActivitySnapshot(activityId)
```

or a folded transcript query, but that should not compromise the canonical event history.

For 9: yes, I meant listing known logical `AgentSession`s from the central registry. The name `list()` is technically reasonable on `SessionManager`, but it undersells that the result is a filtered, ordered, paginated registry query.

I prefer:

```ts
sessionManager.querySessions({
  cursor,
  limit: 50,
  order: "updated_desc",
  adapterId,
  status,
});
```

Returning:

```ts
interface AgentSessionQueryPage {
  sessions: readonly AgentSessionSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}
```

Then we can keep:

```ts
sessionManager.list()
```

as a deprecated or small convenience method only if it already exists, but `querySessions()` becomes the scalable API. It makes the distinction clear:

- `querySessions()` searches the registry and returns summaries.
- `getSessionRecord(agentSessionId)` returns one persisted registry record.
- `createSession()` creates a live `AgentSession`.
- `openSession(agentSessionId)` reconstructs a live `AgentSession`.

So: preserve every tool transition, paginate immutable events, and call the registry operation `querySessions()` rather than making `list()` ambiguously sound like it returns every session at once.




Agreed: keep `list()`.

For long-running tools, we must not assume lifecycle records are adjacent—or even on the same page. An activity could be:

```text
page 8: announced
page 7: in_progress
pages 6–2: messages and other activities
page 1: settled
```

The model should therefore use independent, self-contained state snapshots sharing an identity:

```ts
interface ActivityTranscriptRecord extends TranscriptEnvelope {
  t: "activity";
  activityId: string;
  activityRevision: number;
  operationId: string;
  status:
    | "announced"
    | "in_progress"
    | "settled"
    | "failed"
    | "cancelled";

  // Repeated safe display fields, according to capture policy.
  name: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}
```

`in_progress` may occur multiple times. `activityRevision` increases every time, and the highest revision seen is authoritative. Consumers process every record as an upsert, not as a transition requiring the previous record.

Pagination remains historical, though. A consumer loading only the latest page might not encounter a tool announced much earlier and still running. We should not solve that by distorting pagination. Instead, expose current activity state separately:

```ts
agentSession.listActivities({
  status?: "open" | "terminal" | "all";
}): readonly ActivitySnapshot[];
```

For transcript-only/offline access:

```ts
transcript.listActivities({
  at?: TranscriptCursor;
  status?: "open" | "terminal" | "all";
}): Promise<readonly ActivitySnapshot[]>;
```

The important distinction is:

- `readPage()` returns an ordered event history.
- `listActivities()` folds all revisions by `activityId` and returns state at a particular transcript boundary.
- Live listeners deliver the same activity revisions as they happen.

The initial implementation can compute offline activity state by scanning the transcript with bounded memory—only retaining the latest record per relevant `activityId`. Later, a rebuildable sidecar index can optimize this without changing the API or becoming a source of truth.

We also need to distinguish two persisted states:

- `open`: last observed as announced/in-progress.
- `currently executing`: only knowable from the live `AgentSession`.

After a crash or reopen, an old `in_progress` record proves the tool never recorded a terminal result; it does not prove the harness is still executing it. So an offline snapshot could contain:

```ts
interface ActivitySnapshot {
  activityId: string;
  status: ActivityStatus;
  execution:
    | "observed_live"
    | "historically_open"
    | "terminal";
}
```

If the session closes, crashes, hands off, or switches while an activity is open, we should not invent `failed` or `cancelled`. It remains historically unfinished unless the harness or library has positive evidence of cancellation.

And for the registry API:

```ts
sessionManager.list({
  cursor,
  limit: 50,
  order: "updated_desc",
});
```

On `SessionManager`, `list()` is sufficiently clear and is the better name.




Yes. If the transcript is a restoration source, checkpoints must be written continuously enough to survive an unclean shutdown. Writing only during `close()` is insufficient because `SIGKILL`, power loss, or a host-process crash cannot run cleanup code.

I would use this policy:

- Write the initial checkpoint immediately after the internal session is established.
- Write a checkpoint after every settled operation that may have changed resumable state.
- Write one whenever continuation state changes: handoff, switch, model/mode change, reconciliation, etc.
- On clean close, flush all records and ensure the latest checkpoint is durable. A duplicate checkpoint is unnecessary if nothing changed.
- On a caught error, transport failure, or observed harness exit, best-effort append a failure record and recovery checkpoint.
- On `SIGINT`/`SIGTERM`, attempt the same graceful flush, while acknowledging that `SIGKILL` cannot be handled.

So yes, this likely means a checkpoint after every completed turn. Checkpoints are small compared with the transcript, and otherwise a crash could revert continuation state by several turns.

The important caveat is that a checkpoint written after the ACP process dies cannot discover new state from the dead process. It records the last state the library actually knew. A mid-operation death is therefore different from a settled turn:

```ts
interface AgentSessionCheckpoint {
  // continuation information...

  boundary:
    | {
        status: "settled";
        lastSettledOperationId: string | null;
      }
    | {
        status: "in_flight";
        lastSettledOperationId: string | null;
        interruptedOperationId: string;
        cause: "transport_error" | "harness_exit" | "host_interrupt";
      };
}
```

That prevents us from falsely claiming an exact boundary. The harness might have persisted part or all of the interrupted operation before dying.

The write order should be:

```text
operation events
→ terminal operation record
→ checkpoint referencing that terminal sequence
→ publish/update registry
```

For an interrupted operation:

```text
partial operation events
→ interruption/failure record
→ best-effort in-flight checkpoint
→ publish/update registry
```

Each checkpoint should contain the transcript sequence it covers. During restoration:

- A `settled` checkpoint is a known clean boundary.
- An `in_flight` checkpoint is resumable but carries uncertainty.
- A partial final JSONL line is ignored.
- If the emergency checkpoint could not be written, the previous settled checkpoint remains valid.
- Records after that checkpoint reveal that an operation began but was not durably resolved.

One nuance: “every error or exception” should mean every error affecting the session or persistence path—not arbitrary consumer listener exceptions. A listener throwing must not create a fake session recovery boundary.

And agreed on the registry method:

```ts
sessionManager.listAgentSessions({
  cursor,
  limit: 50,
  order: "updated_desc",
});
```

It is verbose, but unambiguous about listing logical `AgentSession` records rather than internal harness sessions or live objects.




Yes—but only when the persisted records indicate an uncertain boundary. An electricity failure creates two independently persisted realities:

- The library has its transcript and checkpoint.
- The harness may have advanced its internal session beyond that checkpoint.

The library cannot assume either that the operation never reached the harness or that it completed.

The key is a write-ahead operation marker. Before sending anything to ACP:

```text
1. append operation_started
2. durably flush it
3. send the prompt to the harness
4. persist resulting events
5. append operation_settled
6. append the new checkpoint
7. durably flush again
```

After power loss, restoration can distinguish:

- No operation after the checkpoint: clean restoration.
- `operation_started` without a terminal record: potentially divergent.
- Terminal record and checkpoint: clean settled restoration.
- Truncated final JSONL line: ignore it and use the preceding complete record.

“Durably flush” matters here. Merely writing into a userspace or OS buffer does not protect against power loss. At operation boundaries, the implementation should request filesystem synchronization. Prompts are long-running enough that this cost should be acceptable.

## Recovery handshake

When an unfinished operation is detected, loading should pause before accepting another prompt and attempt reconciliation:

```ts
type SessionRecoveryStatus =
  | { kind: "clean" }
  | {
      kind: "reconciled";
      interruptedOperationId: string;
      recoveredRecords: number;
    }
  | {
      kind: "uncertain";
      interruptedOperationId: string;
      reason:
        | "history_unavailable"
        | "history_mismatch"
        | "harness_session_missing";
    };
```

If the adapter can reload or enumerate the harness session history:

1. Resume the recorded `internalSessionId`.
2. Obtain the harness’s current history.
3. Compare it with the last settled transcript boundary.
4. Import any observable missing events into the transcript as recovery records.
5. Append a reconciled checkpoint.
6. Resume normal operation.

Recovered records should be clearly marked:

```ts
recovery: {
  recoveredAt: string;
  interruptedOperationId: string;
  source: "harness_history";
}
```

They should not pretend they were observed live.

## When reconciliation cannot be proven

Some harnesses may resume an internal session without exposing enough history to compare it. In that case, the library must report `uncertain`; it should not silently continue as though restoration were exact.

The consumer could then choose among:

```ts
await session.resolveRecovery({
  strategy: "accept_harness_state",
});
```

This continues the harness session while recording that the transcript may have a gap.

```ts
await session.resolveRecovery({
  strategy: "start_new_internal_session",
});
```

This starts a new internal thread from the last settled library checkpoint, probably using a recovery/handoff prompt.

Or abort restoration.

Starting a new thread does not undo external tool side effects from the interrupted operation. A command may have modified files before the electricity failed, even if neither transcript nor harness history records its completion. That uncertainty has to remain visible.

This should be called session recovery or session reconciliation, distinct from `reconcileMetering()`. The two may happen together after a crash, but they solve different discrepancies.

So the rule is:

- Restore automatically from a clean checkpoint.
- Attempt automatic reconciliation after a dirty/in-flight boundary.
- Require an explicit consumer recovery policy when the adapter cannot establish what happened.
- Never send another prompt while recovery remains unresolved.






There is real value in the critique, but I would not accept all its conclusions. The strongest points are the authority model, unbounded history, configuration reapplication bound, and implementation scope. The default-transcript criticism identifies a real risk, but “therefore transcripts should default off everywhere” does not fit what this library is becoming.

## 1. Default transcripts: the risk is real, but the conclusion is too broad

A transcript is not merely optional logging in this design. It enables or strengthens:

- restoring the logical `AgentSession`;
- recovering after an unclean operation;
- preserving activity and transition history;
- reconstructing handoffs and switches;
- paginating conversation state without asking the harness;
- repairing the registry;
- understanding what happened before an internal-session replacement.

A handoff can technically happen live without a transcript, but durable continuity around it becomes much weaker.

So I agree with you: defaulting to registry-only would quietly make the managed library much less capable.

However, the critic is right that a low-level library call silently beginning to persist prompts after an upgrade is dangerous. I think the best answer is to reflect the two intended uses in the entry points:

```ts
// Low-level ACP transport/session use.
// No persistence unless explicitly supplied.
AgentSession.create({
  adapter,
});
```

```ts
// Managed logical-session use.
// Registry and transcript enabled by default.
sessionManager.createAgentSession({
  adapter,
});
```

That gives us two coherent products:

- Direct `AgentSession`: the original reverse-proxy-like primitive.
- `SessionManager`-created session: the durable, higher-value managed abstraction.

The CLI would use the managed path.

This is better than one global default because the chosen entry point communicates intent. It also means an existing direct `AgentSession.create()` consumer does not unexpectedly start writing prompts after upgrading.

If we insist on one universal default, I would keep transcripts enabled—but only in a breaking release with extremely prominent documentation. The managed/direct split is cleaner.

## 2. Mandatory durability: valid criticism, but it is mostly caused by the current authority model

The expensive part is not appending and syncing a small transcript record. Compared with a provider call, one or two transcript syncs are usually negligible.

The problematic part is rewriting and synchronizing the complete registry before every prompt. That happens only because we currently require both transcript and registry to carry authoritative write-ahead state.

If we fix point 3, the common managed path becomes:

```text
append operation start + input
→ sync transcript
→ dispatch
→ append result + checkpoint
→ sync transcript
→ update registry projection
```

The registry no longer needs a full pre-dispatch rewrite whenever a transcript exists.

I would still support a durability option, but I would not call it `best_effort`, because that phrase hides what is actually lost:

```ts
durability: "synchronous" | "buffered";
```

- `synchronous`: operation boundaries are synchronized before dispatch; power-loss ambiguity is detectable.
- `buffered`: ordering is preserved, but sudden power loss may lose recent boundaries and restoration cannot claim power-loss safety.

I would keep `synchronous` as the managed default. LLM operations are sufficiently slow that we should measure before optimizing away correctness. The interactive CLI could expose buffered mode, but I would not assume it needs it before benchmarking.

## 3. Two authorities: this is the strongest criticism

I think we should adopt a conditional-authority model.

The registry has two conceptually different responsibilities:

- Authoritative inventory: which logical sessions exist and where they are routed.
- Continuation state: how a particular session resumes.

Those do not need the same authority rules.

### When a transcript exists

- Registry is authoritative for discovery.
- Transcript is authoritative for continuation and operation history.
- Registry checkpoint fields are a rebuildable projection/cache.
- A newer transcript repairs the registry.
- A newer registry continuation checkpoint should not normally exist.
- A missing/corrupt transcript is an explicit recovery problem, not an invitation to silently use the registry copy.

### When transcripts are disabled

- Registry is authoritative for both discovery and continuation.
- It must carry the write-ahead in-flight checkpoint before dispatch.

That removes most of the six-way conflict table:

| Mode | Inventory authority | Continuation authority |
|---|---|---|
| Registry + transcript | Registry | Transcript |
| Registry only | Registry | Registry |
| Transcript only | Consumer/path | Transcript |
| Neither | Consumer | Consumer checkpoint |

This also substantially reduces registry writes and makes the design easier to test.

There is still value in retaining the latest checkpoint projection in the registry—it makes listing cheap—but it should not compete with the transcript when the transcript is enabled.

## 4. Certified replay: correct as future architecture, wrong as v1 implementation scope

I agree with the critic here.

The design is legitimate, but if no adapter currently qualifies, implementing the certified branch now would produce:

- unreachable code;
- untestable guarantees;
- types shaped around hypothetical evidence;
- considerable adapter machinery before we know what real replay looks like.

For v1:

```text
dirty boundary
→ attempt to load/resume
→ collect whatever observable replay exists
→ status remains uncertain
→ consumer calls resolveRecovery()
```

We should retain a short “future certified reconciliation” section in the spec, but defer:

- `replay: "certified"`;
- automatic `reconciled`;
- exact replay fingerprints;
- completeness certification.

When OpenCode or another pinned adapter genuinely provides the necessary evidence, we can specify the certified path from real observations.

So: preserve the extension point conceptually, but do not ship dead runtime machinery.

## 5. ACP configuration section

### Reapplication termination

This is a real hole and the fix is straightforward:

1. Apply every desired configuration once, in stored ordinal order.
2. Revalidate after every response.
3. Never restart the sequence automatically.
4. Compare final effective values with desired values.
5. Any residual disagreement becomes `configuration_mismatch`.

That prevents:

```text
A resets B
B resets A
A resets B
...
```

The library must not search for a fixed point.

### Schema digest explanation

There is some value here, but the criticism slightly overstates the problem.

If a desired option disappears, we already have:

- the desired config ID in the checkpoint;
- the newly announced config IDs after reopening.

Therefore we can report exactly:

```text
Desired configuration "reasoning_effort" is no longer advertised.
```

We do not need the previous catalog to determine that.

Likewise, if a desired value is no longer allowed, the new announcement tells us which current values are valid.

However, retaining the prior announced ID set is cheap and makes offline inspection clearer:

```ts
interface SessionConfigurationCheckpoint {
  schemaDigest: string | null;
  announcedConfigIds: readonly string[];
  desired: readonly PersistedSessionConfigSelection[];
  effective: Readonly<Record<string, JsonValue>>;
  omittedConfigIds: readonly string[];
}
```

I would add it, but not because restoration is otherwise impossible. It improves diagnostics and lets us clearly label effective entries whose definitions belonged to an older schema.

We should not retain descriptions, labels, or the complete options catalog in the checkpoint.

## 6. Internal-session history inside every checkpoint

Completely valid criticism.

`internalSessionHistory` is not necessary to resume the current thread, and embedding it in every checkpoint causes:

- checkpoint growth per transition;
- O(history) canonicalization on every operation;
- repeated transcript duplication;
- repeated registry duplication.

I would change the ownership:

```ts
interface AgentSessionCheckpoint {
  internalSessionId: string | null;
  internalSessionActivatedAt: string | null;

  lastTransition?: {
    transitionId: string;
    kind: "handoff" | "switch" | "mode_change" | "replacement";
  };

  internalSessionHistoryRevision: number;
  internalSessionHistoryDigest: string;
}
```

The full history lives in:

- immutable transcript transition records, when transcripts are enabled;
- the registry record, for fast listing and registry-only sessions.

The checkpoint only needs enough information to verify that it agrees with the expected history version. That keeps it bounded.

Because the registry would no longer be rewritten on every transcript-backed prompt, storing the full transition history there is not a significant per-turn cost.

## Smaller comments

### `AgentSession.listSessions()`

The spec should decide. My recommendation:

- `sessionManager.listAgentSessions()` — logical library sessions.
- `agentSession.listHarnessSessions()` — sessions reported by the active harness through ACP.
- Deprecate `agentSession.listSessions()` and its implicit merged result.
- If the CLI wants a merged display, make that CLI/consumer composition explicit.

This reinforces the three-layer distinction we established earlier.

### Message typing

Correct criticism. It should use the actual versioned structured message type, not `JsonValue[]`:

```ts
interface TranscriptMessageRecord {
  text: string;
  messages?: readonly TranscriptResponseMessage[];
}
```

The persisted type can mirror `ResponseMessage` while remaining versioned independently.

### Timeline filtering

Also valid. `types` should remain reserved for the physical `records` view, but timeline should get a projection-specific filter:

```ts
transcript.readPage({
  view: "timeline",
  include: ["message", "activity", "transition"],
});
```

This avoids confusing physical record types with projected timeline categories.

### V0 implementation scope

Strong practical criticism. The current specification is an architectural target, not one reasonable implementation PR.

I would define the first usable slice as:

1. Unified persistence configuration and capture presets.
2. Central registry and explicit managed/direct entry points.
3. Transcript v2 envelope and typed paginated reads.
4. Bounded checkpoints after settled operations.
5. `create()`/`open()` for clean checkpoints.
6. Configuration selection persistence and restoration.
7. Dirty-boundary detection with manual `resolveRecovery()`.

Defer initially:

- certified automatic replay reconciliation;
- elaborate cross-source checkpoint conflict machinery, which conditional authority mostly removes;
- transcript generations created through compaction/redaction;
- sparse indexes and segmented transcripts;
- automatic repair tooling;
- advanced retention/export/import behavior.

I would not defer the operation-start marker entirely. It is cheap, and without it a mid-operation crash can look like a clean checkpoint. We can defer sophisticated automatic reconciliation while still detecting dirtiness correctly.

## My net assessment

I would adopt these changes:

- Use different persistence defaults for direct `AgentSession` and managed `SessionManager` creation.
- Make transcript the continuation authority whenever it exists.
- Keep the registry authoritative for discovery and for continuation only in registry-only mode.
- Add synchronous/buffered durability, probably with synchronous as the managed default.
- Defer certified replay until a real adapter qualifies.
- Make config restoration a single bounded pass.
- Add announced config IDs for diagnostics.
- Remove full internal-session history from checkpoints.
- Decide the session-list naming now.
- Restore strong structured-message typing.
- Add timeline-specific filtering.
- Define a deliberately smaller first implementation slice.

I would reject only the blanket claim that transcript persistence should default off for the managed library. That would protect the lowest-level behavior by weakening the abstraction we are deliberately building. The better answer is to make “raw session” versus “managed session” explicit.











Yes. For the managed use case, `SessionManager` should be the thing used to create and load `AgentSession`s.

What exists currently is already close, but responsibility is fragmented:

```text
Consumer
├── creates SessionManager
├── chooses SessionStore
├── resolves adapter
├── chooses transcript directory
├── injects everything into AgentSession
├── remembers how to reconstruct it
└── owns live AgentSession map
```

The manager currently provides only catalog operations. It does not define the complete persistence environment.

The cleaner model is:

```text
Consumer
├── configures SessionManager once
├── asks it to create/load sessions
└── owns live AgentSession map

SessionManager
├── registry/store
├── transcript configuration
├── adapter resolution
├── checkpoint restoration
└── creates configured AgentSession objects
```

For example:

```ts
const sessionManager = await SessionManager.open({
  persistence: {
    root: "/absolute/path/to/acp-data",

    // Optional. Defaults to:
    // /absolute/path/to/acp-data/agent-sessions.json
    registry: {},

    // Defaults to:
    // /absolute/path/to/acp-data/transcripts/
    transcript: {
      preset: "activity",
    },
  },

  resolveAdapter,
});

const liveSessions = new Map<string, AgentSession>();
```

Creation becomes:

```ts
async function createSession(adapterId: string): Promise<AgentSession> {
  const session = await sessionManager.createAgentSession({
    adapterId,
    cwd: process.cwd(),
    defaultPermission: "cancel",
  });

  liveSessions.set(session.agentSessionId, session);
  return session;
}
```

Loading becomes:

```ts
async function loadSession(agentSessionId: string): Promise<AgentSession> {
  const session = await sessionManager.loadAgentSession(agentSessionId);

  liveSessions.set(session.agentSessionId, session);
  return session;
}
```

And discovery:

```ts
const page = await sessionManager.listAgentSessions({
  limit: 50,
  order: "updated_desc",
});
```

Once returned, it is still a normal `AgentSession`:

```ts
await session.prompt("Continue");
await session.setConfig("model", "sonnet");
await session.handoff();
session.interrupt();
await session.stop();
```

The manager does not proxy those methods and does not need to hold the live object. The consumer’s `Map<string, AgentSession>` remains appropriate.

## Why this is not unwanted wrapping

The concern before was that a higher-level object might have to reproduce the whole `AgentSession` interface:

```ts
manager.prompt(...)
manager.bridge(...)
manager.interrupt(...)
```

That would be unnecessary. The manager is only a factory, repository, and restoration coordinator:

```text
SessionManager --create/load--> AgentSession
Consumer ---------------------> AgentSession methods
```

It wraps construction and persistence, not session operation.

## Registry and transcripts should remain separate stores

The current fragmentation is not that there are two kinds of storage. They genuinely have different behavior:

- Registry: mutable records, lookup, concurrency, atomic replacement.
- Transcript: append-only event stream, sequential reading, pagination.

Combining them into one `SessionStore` abstraction would produce an awkward interface. The fragmentation is that the consumer currently configures them independently and must ensure they refer to the same session.

`SessionManager` should coordinate both under one persistence configuration while retaining separate internal backends.

A custom deployment could still do:

```ts
const sessionManager = await SessionManager.open({
  persistence: {
    registry: {
      store: databaseSessionStore,
    },
    transcript: {
      path: "/secure/transcripts",
      preset: "activity",
    },
  },
  resolveAdapter,
});
```

The registry can live in a database while transcripts remain files. They are configured together but not forced into the same storage mechanism.

## The lower-level path remains

For the original “ACP reverse proxy” use case:

```ts
const session = await AgentSession.create({
  adapter,
  adapterId,
  persistence: false,
});
```

And a consumer that owns its continuation state could directly open from a checkpoint:

```ts
const session = await AgentSession.open({
  adapter,
  checkpoint,
  persistence: false,
});
```

That gives us a clear split:

| Entry point | Purpose | Default persistence |
|---|---|---|
| `AgentSession.create/open` | Low-level consumer-controlled session | Off |
| `SessionManager.createAgentSession/loadAgentSession` | Managed logical session | Registry + transcript |

Transcript-only operation can still use a manager with the registry disabled:

```ts
const sessionManager = await SessionManager.open({
  persistence: {
    registry: false,
    transcript: {
      path: "/absolute/path/to/transcripts",
    },
  },
  resolveAdapter,
});
```

So yes: I think your example is showing the embryonic version of the right design. The missing step is making `SessionManager` own the unified persistence configuration and provide the creation/loading factories, instead of requiring every consumer to manually reconnect `SessionStore`, transcript location, adapter resolution, and `AgentSession.create()`.









This critique is largely right. It also exposes that my last edit fixed the prose-level ownership but did not yet produce the clean type-level contract.

One factual note: the exact “equivalent default manager” sentence has already been removed from the working copy. The current §5.1 says direct sessions have no implicit registry. But the underlying criticism still applies: the current types make direct explicit persistence less capable than managed persistence. That asymmetry should be fixed.

## The configuration model

I would adopt this shape:

```ts
interface PersistenceConfig {
  /**
   * Base for the default registry and transcript locations.
   * Default: ACP_CLIENT_HOME, then ~/.acp-client.
   */
  root?: string;

  /**
   * Default: enabled with the central JSON registry.
   */
  registry?:
    | false
    | {
        store?: AgentSessionStore;
      };

  /**
   * Default: enabled with preset "activity".
   */
  transcript?:
    | false
    | TranscriptConfig;

  /**
   * Governs the persistence system as one durability boundary.
   * Default: "synchronous".
   */
  durability?: "synchronous" | "buffered";

  sessionConfiguration?: SessionConfigurationPersistenceConfig;
}

interface SessionManagerOptions {
  /**
   * Omission means the complete managed default.
   */
  persistence?: PersistenceConfig;

  resolveAdapter?:
    | ((adapterId: string) => Adapter)
    | ((adapterId: string) => Promise<Adapter>);
}

interface AgentSessionConfig {
  /**
   * Direct default: false.
   *
   * Supplying an object explicitly opts into the same complete persistence
   * semantics available through SessionManager.
   */
  persistence?: false | PersistenceConfig;
}
```

The crucial expansion rules are:

```text
AgentSession.create({ persistence omitted })
→ persistence disabled

AgentSession.create({ persistence: false })
→ persistence disabled

AgentSession.create({ persistence: {} })
→ complete persistence enabled:
   registry + activity transcript + typed config + synchronous durability

SessionManager.open({ persistence omitted })
→ the same complete persistence environment

manager.createAgentSession({ per-session overrides })
→ manager environment plus allowed session overrides
```

That gives us the principle the critique identifies:

> Persistence defaults differ by entry point; persistence capabilities do not.

A direct caller can opt into the same exact machinery without going through a manager. Nothing silently appears merely because the package was upgraded.

## Manager versus per-session authority

I agree that the manager must own these:

- `root`
- `registry`
- `durability`
- adapter resolution

A managed session must not redirect its registry or select another durability grade. Otherwise one manager could stop having one coherent inventory and persistence guarantee.

But I disagree slightly with the critic’s proposed override list: per-session transcript `path` must remain configurable. That was the reason for the ownership correction in the first place.

Allowed managed-session overrides should be:

```ts
interface ManagedSessionPersistenceOverrides {
  transcript?:
    | false
    | {
        path?: string;
        preset?: TranscriptPreset;
        capture?: Partial<TranscriptCapturePolicy>;
      };

  sessionConfiguration?: SessionConfigurationPersistenceConfig;
}
```

Not allowed per session:

```ts
root
registry
durability
```

The transcript path does not split the manager inventory. The manager still records the resolved path in its one registry:

```text
manager registry
├── session A → /customers/alice/a.jsonl
├── session B → /secure/b.jsonl
└── session C → default-root/transcripts/c.jsonl
```

So the exact precedence is:

```text
Per-session transcript/config override
→ manager persistence defaults
→ library managed defaults
```

For `root`, `registry`, and `durability`, there is no per-session precedence because they cannot be overridden.

## Durability placement

Agreed. It belongs at the top of `PersistenceConfig`.

```ts
durability: "synchronous" | "buffered";
```

It should govern the complete active continuation system. A single logical session should not claim that its transcript is power-loss-safe while its authoritative registry checkpoint is buffered.

The grades need explicit guarantees:

- `synchronous`: write-ahead state is synchronized before dispatch; dirty power-loss boundaries are detectable.
- `buffered`: record order is maintained, but sudden power loss may erase recent boundaries; the library does not claim power-loss-safe restoration.

Managed default should remain `synchronous` until measurements prove that unacceptable. Once we make the transcript authoritative when enabled, the pre-dispatch path is generally one small append and sync—not a complete registry rewrite.

## `SessionManager` with registry disabled

The critic is right about returning an empty page. It must fail visibly:

```ts
await sessionManager.listAgentSessions();
// throws RegistryDisabledError
```

The same applies to registry-dependent operations:

```ts
sessionManager.listAgentSessions();
sessionManager.getAgentSessionRecord(id);
sessionManager.loadAgentSession(id);
sessionManager.deleteAgentSession(id);
```

They throw `RegistryDisabledError` unless the operation receives an explicit checkpoint/transcript identity that makes registry lookup unnecessary.

A registry-disabled manager can still be useful as a configured session factory:

```ts
const manager = await SessionManager.open({
  persistence: {
    registry: false,
    transcript: {
      path: "/transcripts",
      preset: "activity",
    },
  },
  resolveAdapter,
});

const session = await manager.createAgentSession({
  adapterId: "claude",
});
```

But it has no discoverable inventory. That limitation must be explicit in its capabilities:

```ts
manager.capabilities.registry === false;
```

Whether such an object deserves the name `SessionManager` is debatable, but supporting it is cheap and preserves all four §10 combinations.

## Authority simplification

This should be adopted too:

| Configuration | Inventory authority | Continuation authority |
|---|---|---|
| Registry + transcript | Registry | Transcript |
| Registry only | Registry | Registry |
| Transcript only | Consumer/path | Transcript |
| Neither | Consumer | Consumer checkpoint |

When a transcript exists:

- Its checkpoint and journal tail determine continuation.
- Registry checkpoint fields are a projection for cheap listing.
- Transcript-newer state repairs the registry.
- Registry state never silently overrides the transcript.
- Missing/corrupt transcript requires explicit recovery.

That removes most symmetric two-authority reconciliation and the pre-prompt registry rewrite.

## Migration consequence

Agreed completely. Under the entry-point split, the change is additive:

- Existing `AgentSession.create()` callers continue with no implicit persistence.
- Existing legacy transcript options retain their existing explicit writes.
- `SessionManager.createAgentSession()` is new and therefore has no existing callers whose behavior changes.
- Direct `persistence: {}` is an explicit opt-in.

The old warning that every test/application must add `persistence: false` should be removed.

## CLI exposure and deletion

Also correct.

The managed CLI should print the resolved persistence location when starting:

```text
Session history: /home/user/.acp-client/transcripts/abc.jsonl
```

This is better than maintaining a separate “first run acknowledged” state. It remains visible and truthful if configuration changes.

Manual deletion belongs in v0 even if automatic retention is deferred. At the library level:

```ts
await sessionManager.deleteAgentSession(agentSessionId, {
  transcript: "keep", // default
});
```

```ts
await sessionManager.deleteAgentSession(agentSessionId, {
  transcript: "delete",
});
```

The CLI should expose both and require confirmation before deleting transcript content. Automatic age/size retention can remain deferred.

## Timeline filtering

I agree with the critic now.

As long as timeline categories directly correspond to stored record types, reuse `types`:

```ts
await transcript.readPage({
  view: "timeline",
  types: ["message", "activity", "transition"],
});
```

Validation rules:

- `records`: accepts any known physical record type.
- `timeline`: accepts only members of `TranscriptTimelineItem`.
- `conversation`: either omits `types`, or accepts only `["message"]`.

If we later introduce synthesized timeline entities such as `"turn"`, then a separate projection filter becomes justified. It is unnecessary today.

## History digest

Agreed, and the current spec still needs the actual bounded-history change.

The checkpoint should contain:

```ts
interface AgentSessionCheckpoint {
  internalSessionId: string | null;
  internalSessionActivatedAt: string | null;

  lastTransition?: {
    transitionId: string;
    kind: TransitionKind;
  };

  internalSessionHistoryRevision: number;
  internalSessionHistoryDigest: string;

  // No full internalSessionHistory.
}
```

The complete history lives in:

- transcript transition records;
- the registry record for fast access and registry-only operation.

The digest is only an internal consistency/corruption check:

- Transcript mode: compare reconstructed transition history with the registry projection.
- Registry-only mode: validate that the registry record’s history matches its checkpoint summary.

It does not decide which side wins and does not participate in crash reconciliation.

## Configuration refinements

Both are worth adopting:

- Reapply desired config exactly once in ordinal order.
- Do not iterate toward a fixed point.
- Compare final values after that one pass.
- Remaining disagreement becomes `configuration_mismatch`.

And add:

```ts
announcedConfigIds: readonly string[];
```

The critic overstates its necessity—we can already identify missing desired IDs by comparing `desired` with the new announcement—but the field is cheap and makes offline diagnostics and stale `effective` values clearer.

## Certified replay and v0

I agree with deferring certified automatic reconciliation.

V0 should provide:

- operation-start markers;
- dirty-boundary detection;
- `uncertain` recovery;
- explicit `resolveRecovery()`.

It should not implement a certified branch until a real pinned adapter satisfies the contract.

The first implementation slice should include:

1. Direct versus managed persistence defaults.
2. Registry and per-session transcript ownership.
3. Capture presets and v2 records.
4. Typed pagination.
5. Bounded checkpoints.
6. Clean `create()`/`open()`/`loadAgentSession()`.
7. ACP configuration persistence.
8. Operation-start markers and manual uncertain recovery.
9. Manual session/transcript deletion.

Defer automatic replay reconciliation, automatic retention, compaction, segmentation, and sophisticated repair.

So the critique is substantively good. The one adjustment I would make is preserving per-session `transcript.path`; manager ownership of the registry/root does not require all transcript files to share one directory. Everything else here makes the split more concrete and makes the initial implementation considerably smaller.

















----



“Durability” here means: when the library says a transcript/checkpoint was written, has it actually reached persistent storage, or is it merely sitting in memory waiting for the operating system to write it later?

For example:

```text
1. Library writes operation_started
2. Library sends prompt to harness
3. Electricity goes out
```

A normal `appendFile()` can complete while the data is still in the OS filesystem cache. After a power outage:

- The harness/provider may have received and processed the prompt.
- The supposedly written `operation_started` record may disappear.
- On restart, the library sees the previous clean checkpoint.
- It incorrectly believes no operation was in flight.

To support the recovery guarantee we discussed, the order must be:

```text
write operation_started and captured prompt
→ fsync/fdatasync
→ send prompt to harness
```

After completion:

```text
write response, activity, terminal boundary, checkpoint
→ fsync/fdatasync
→ report the operation as durably persisted
```

That is what I meant by synchronous durability.

The proposed `buffered` option would skip those filesystem synchronization calls:

```text
write into buffers
→ immediately send prompt
→ OS persists data eventually
```

It is faster, but it cannot reliably detect divergence after sudden power loss.

## Do we actually need the option?

On reflection, probably not in v0.

A public durability mode creates two substantially different recovery contracts:

- one where dirty operations are reliably detectable;
- another where an apparently clean checkpoint may be wrong after power loss.

That weakens the central promise of managed persistence and complicates documentation, checkpoints, tests, and recovery.

I would simplify:

- Direct `AgentSession` with persistence disabled: no durability guarantee, naturally.
- Managed persistence: durable operation boundaries are mandatory.
- Custom stores: must satisfy the same durable-commit contract.
- Add a weaker buffered mode later only if measurements demonstrate a real need.

The expensive concern raised in the review was primarily rewriting and synchronizing the complete registry before every prompt. Making the transcript authoritative for continuation avoids that in the normal managed configuration:

```text
small transcript append + sync
→ provider operation
→ small transcript append + sync
→ registry updated as a projection
```

The registry-only configuration is inherently more expensive if it wants power-loss safety because the registry is then the only continuation source. That is an honest tradeoff of disabling transcripts.

Given that model operations generally take seconds or minutes, a couple of small filesystem syncs should be measured before we introduce an option that invalidates power-loss recovery.

So my current recommendation is: remove `durability: "synchronous" | "buffered"` from v0 and make durable boundaries part of the managed persistence contract.






# undecided points

Architecturally, yes. We have enough decisions to begin without inventing the design during implementation.

I would not implement the entire current document literally yet, though. It still contains several stale clauses from before our latest decisions:

- §3 does not yet give direct explicit persistence full parity with managed persistence.
- §10 still contains the dual-authority reconciliation table; transcript-backed sessions should use the transcript as continuation authority.
- `internalSessionHistory` is still embedded in every checkpoint instead of using a bounded revision/digest.
- §20 still treats certified replay as a v0 implementation instead of a deferred extension.
- Config restoration needs the single-pass termination rule.
- `AgentSession.listSessions()` remains undecided.
- Timeline filtering and structured message typing need their agreed corrections.
- §27 needs a concrete v0 boundary.

These are specification consistency fixes, not unresolved architectural questions. I would do that cleanup first and then implement v0 in parts:

1. Configuration/default normalization and direct-versus-managed tests.
2. Central registry and `SessionManager` creation/loading API.
3. Per-session transcript configuration and v2 records.
4. Cursor pagination and capture-policy filtering.
5. Bounded checkpoints and clean restoration.
6. ACP configuration restoration.
7. Operation-start markers and manual uncertain recovery.
8. Manual registry/transcript deletion.

Automatic certified reconciliation, retention, segmentation, compaction, and buffered durability remain deferred.

One practical consideration: this work will substantially touch `agent-session.ts`, where the metering implementation may also be making changes. We should make sure that work is incorporated or stabilized before the AgentSession integration portion. The registry/configuration foundations can begin independently.

So: yes, ready to start—but first with a short spec normalization pass, then the narrow v0 rather than treating all 1,600 lines as one implementation task.











There are no major architectural questions left. We mainly need to turn the decisions already made into exact, non-contradictory contracts in the specification.

The remaining definitions are:

1. Exact persistence types

```ts
interface PersistenceConfig {
  root?: string;
  registry?: false | {
    store?: AgentSessionStore;
  };
  transcript?: false | TranscriptConfig;
  sessionConfiguration?: SessionConfigurationPersistenceConfig;
}

interface SessionManagerOptions {
  persistence?: PersistenceConfig;
  resolveAdapter?: AdapterResolver;
}

interface AgentSessionConfig {
  // Omitted means disabled for direct sessions.
  persistence?: false | PersistenceConfig;
}
```

Managed per-session overrides need a narrower type:

```ts
interface ManagedSessionPersistenceOverrides {
  transcript?: false | TranscriptConfig;
  sessionConfiguration?: SessionConfigurationPersistenceConfig;
}
```

A managed session may override its transcript path, preset, capture policy, or disable it. It may not override the manager’s registry or root.

Defaults:

```text
Direct AgentSession + omitted persistence → disabled
Direct AgentSession + persistence: {}     → full persistence
SessionManager + omitted persistence      → full managed persistence
Managed per-session options               → override transcript/config only
```

2. Conditional authority

This should replace the current six-way checkpoint competition:

| Configuration | Discovery authority | Continuation authority |
|---|---|---|
| Registry + transcript | Registry | Transcript |
| Registry only | Registry | Registry |
| Transcript only | Consumer/path | Transcript |
| Neither | Consumer | Consumer checkpoint |

With transcripts enabled, registry checkpoint fields are a rebuildable listing projection. They do not compete with the transcript.

3. Bounded checkpoint history

Remove full `internalSessionHistory` from every checkpoint.

```ts
interface AgentSessionCheckpoint {
  internalSessionId: string | null;
  internalSessionActivatedAt: string | null;

  lastTransition?: {
    transitionId: string;
    kind: TransitionKind;
  };

  internalSessionHistoryRevision: number;
  internalSessionHistoryDigest: string;

  // Other bounded continuation state...
}
```

Full history remains in registry records and transcript transition events. The revision/digest detects corruption; it does not participate in recovery reconciliation.

4. V0 recovery boundary

For v0:

```text
clean checkpoint → restore normally

dirty operation boundary
→ load/resume harness if possible
→ collect observable evidence
→ remain uncertain
→ consumer calls resolveRecovery()
```

Automatic certified replay reconciliation is deferred until an adapter genuinely qualifies. The extension can remain documented, but it should not be implemented in v0.

5. Configuration restoration termination

Configuration restoration is exactly one pass:

```text
apply desired selections once in ordinal order
→ validate after each response
→ compare final effective state
→ residual mismatch becomes configuration_mismatch
```

No automatic retry loop or fixed-point search.

Add `announcedConfigIds` to the checkpoint for better diagnostics.

6. Session-listing names

Following the terminology we established:

```ts
sessionManager.listAgentSessions();
agentSession.listInternalSessions();
```

`listAgentSessions()` reads logical library sessions.

`listInternalSessions()` invokes the active harness’s ACP session-list capability. It should not implicitly merge registry and harness results. The existing ambiguous `AgentSession.listSessions()` becomes deprecated.

7. Transcript typing and filtering

Replace:

```ts
messages?: JsonValue[];
```

with a real versioned type:

```ts
messages?: readonly TranscriptResponseMessage[];
```

Allow `types` on timeline pages when every requested type belongs to `TranscriptTimelineItem`:

```ts
transcript.readPage({
  view: "timeline",
  types: ["message", "activity", "transition"],
});
```

Invalid combinations remain typed errors.

8. Registry-disabled manager behavior

If `registry: false`:

```ts
listAgentSessions()
getAgentSessionRecord()
loadAgentSession(id)
deleteAgentSession(id)
```

must throw `RegistryDisabledError` when they require registry lookup. They must never return an empty result that looks like an empty inventory.

Transcript-only creation remains supported.

9. Manual deletion API

Manual deletion belongs in v0:

```ts
sessionManager.deleteAgentSession(agentSessionId, {
  transcript: "keep", // default
});
```

or:

```ts
sessionManager.deleteAgentSession(agentSessionId, {
  transcript: "delete",
});
```

The CLI must expose this with confirmation for transcript deletion and display the resolved transcript path when opening a managed session.

10. Explicit v0 scope

The first implementation target should include:

- Direct/managed configuration defaults
- Registry and manager factories
- Per-session transcript policy
- JSONL v2
- Pagination
- Clean checkpoints and restoration
- ACP configuration persistence
- Dirty-operation detection
- Manual uncertain recovery
- Manual deletion

Deferred:

- Certified automatic reconciliation
- Buffered durability
- Automatic retention
- Compaction/redaction
- Segmentation and indexes
- Automatic repair/import workflows

So what remains is principally a consistency edit to the spec. The actual behavioral decisions are already available; we do not need another large design discussion unless you disagree with one of these exact contracts.






The adapter should not belong to `SessionManager`. The manager stores `adapterId` as routing metadata, but the actual executable `Adapter` is runtime input supplied by the consumer.

A manager-level adapter or resolver would be a convenience default, but it creates the wrong impression that one manager corresponds to one adapter. Our registry is explicitly meant to contain sessions across adapters, so I would remove `resolveAdapter` from `SessionManagerOptions`.

## Adapter responsibility

Creation remains explicit:

```ts
await sessionManager.createAgentSession({
  adapterId: "claude",
  adapter: resolveAdapter("claude"),
});
```

Loading requires the consumer to supply the runtime adapter:

```ts
const record =
  await sessionManager.getAgentSessionRecord(agentSessionId);

const session = await sessionManager.loadAgentSession(agentSessionId, {
  adapter: resolveAdapter(record.adapterId),
});
```

Or, as a convenience without making it manager state:

```ts
const session = await sessionManager.loadAgentSession(agentSessionId, {
  resolveAdapter,
});
```

The callback belongs to that load operation, not the manager.

The manager validates that loading is still for the persisted `adapterId`; it never stores or blindly executes an adapter command.

A manager-level `defaultAdapter` could save a few characters for a single-adapter CLI, but the CLI/consumer can provide that default itself. I do not think it belongs in the core manager.

## Internal-session history

Agreed: remove it from checkpoints.

The complete history lives in:

- Transcript transition records when transcripts exist.
- The registry record, especially in registry-only mode.

The checkpoint needs only:

```ts
interface AgentSessionCheckpoint {
  internalSessionId: string | null;
  internalSessionActivatedAt: string | null;

  lastTransition?: {
    transitionId: string;
    kind: TransitionKind;
  };

  internalSessionHistoryRevision: number;
  internalSessionHistoryDigest: string;
}
```

The revision/digest only detects corruption or inconsistent projections. It is not an input into recovery selection.

## Recovery architecture

Your three steps are the correct basic progression:

```text
checkpoint
→ try loading internalSessionId
→ if that cannot restore useful continuity, reconstruct from transcript
```

I would avoid calling the third step an ordinary handoff, though. A normal handoff has a live old thread which produces a summary. During recovery, that old thread may be unavailable or uncertain.

It can reuse the handoff machinery, but should be recorded as a recovery transition:

```text
old internal session unavailable
→ build continuation from persisted transcript
→ create new internal session
→ seed it with continuation
→ preserve agentSessionId
```

The default recovery algorithm could be:

1. Resolve the authoritative checkpoint.

   This supplies the adapter ID, current `internalSessionId`, model/config state, and last clean transcript boundary.

2. Attempt normal internal-session loading.

   ```ts
   providerSession: {
     kind: "load",
     internalSessionId,
     onFailure: "error",
   }
   ```

   No silent fallback to a new thread.

3. Classify the result.

   - Clean checkpoint + successful load: recovered normally.
   - Dirty checkpoint + successful load: thread loaded, but interrupted work remains uncertain.
   - Load failed: restoration requires another strategy.

4. Optionally reconstruct from the transcript.

   - Read the appropriate conversation/history window.
   - Produce continuation context.
   - Create a new internal session.
   - Reapply compatible ACP configuration.
   - Seed it with the continuation.
   - Record a `recovery` transition.
   - Keep the same `agentSessionId`.

5. Otherwise return unresolved recovery to the consumer.

The transcript strategy must be opt-in because it:

- creates a new provider thread;
- consumes tokens;
- may send a large amount of persisted content;
- cannot reproduce tool side effects;
- may be unavailable under a transcript policy that omitted messages.

## Making recovery extensible

The recovery engine should be separate from `AgentSession` construction:

```ts
interface RecoveryContext {
  checkpoint: AgentSessionCheckpoint;
  transcript: TranscriptReader | null;
  adapter: Adapter;
  dirtyBoundary: DirtyBoundary | null;
}

interface RecoveryStrategy {
  readonly kind: string;

  attempt(
    context: RecoveryContext,
  ): Promise<RecoveryStrategyResult>;
}
```

Possible results:

```ts
type RecoveryStrategyResult =
  | {
      kind: "recovered";
      continuity: "exact" | "accepted" | "reconstructed";
      internalSessionId: string;
    }
  | {
      kind: "needs_confirmation";
      reason: string;
    }
  | {
      kind: "not_applicable";
      reason: string;
    }
  | {
      kind: "failed";
      error: Error;
    };
```

Initial built-ins:

```ts
{ kind: "load_internal_session" }
```

```ts
{
  kind: "new_from_transcript",
  buildContinuation?: ContinuationBuilder,
  introductionPrompt?: string,
}
```

V0 does not necessarily need to expose arbitrary strategy plugins publicly. But implementing recovery internally around this boundary prevents it from becoming a hardcoded block inside `AgentSession.open()`.

The default policy should attempt only normal load. Transcript reconstruction requires explicit consumer configuration or an explicit `resolveRecovery()` choice.

The two prompts remain distinct:

- Continuation builder prompt: produces the summary/context.
- Introduction prompt: explains that context to the new thread.

## Configuration restoration

Agreed. One pass only:

```text
apply desired settings once in ordinal order
→ revalidate after every result
→ compare final state
→ configuration_mismatch if anything remains inconsistent
```

No oscillating retries.

## Listing names and transcript typing

Agreed:

```ts
sessionManager.listAgentSessions();
agentSession.listInternalSessions();
```

`listInternalSessions()` is the harness ACP operation. No implicit registry merge.

Also:

- Structured transcript messages get a real type.
- `types` can filter timeline records when they are valid timeline members.
- Registry-disabled registry operations throw `RegistryDisabledError`.

## Deletion API

I agree that the string-valued transcript option is unnecessarily verbose for v0. I would use a destructive positive boolean rather than `keepTranscript`:

```ts
await sessionManager.deleteAgentSession(agentSessionId, {
  deleteTranscript: true,
});
```

`deleteTranscript: true` is clearer and safer than `keepTranscript: false`, because the destructive action must be explicitly enabled.

The default operation should tombstone the registry entry:

```ts
await sessionManager.deleteAgentSession(agentSessionId);
```

Result:

```ts
interface AgentSessionRecord {
  status: "active" | "deleted";
  deletedAt?: string;

  transcript: null | {
    path: string;
    deletedAt?: string;
    // ...
  };
}
```

Listing excludes tombstones by default:

```ts
sessionManager.listAgentSessions({
  includeDeleted: true,
});
```

If `deleteTranscript: true`, the transcript is removed and the tombstone records that fact.

Whether the registry tombstone itself is retained can be another explicit option:

```ts
await sessionManager.deleteAgentSession(agentSessionId, {
  deleteTranscript: true,
  removeRegistryEntry: true,
});
```

Defaults:

```text
deleteTranscript: false
removeRegistryEntry: false
```

Therefore the default “delete” means:

- mark logical session deleted;
- retain its transcript;
- retain a tombstone preventing accidental ID reuse;
- exclude it from ordinary lists and loads.

This is recoverable and auditable. Fully removing both requires two explicit destructive choices.

So I would make all of these changes. The only semantic correction is naming transcript-based recovery as reconstruction rather than ordinary handoff, while allowing it to reuse handoff’s summary-and-seed machinery internally.




We should distinguish “a different `Adapter` object” from “a different adapter identity.”

A new adapter object or executable version with the same `adapterId` should normally be allowed. We should not over-engineer compatibility checks; after validating the persisted identity, try loading the `internalSessionId` and use the result as evidence.

A genuinely different `adapterId` is different: internal session IDs are adapter-scoped and must not be assumed portable.

## Normal loading

The managed loading algorithm should be:

```text
1. Read registry record.
2. If transcript was enabled, require and validate it.
3. Read the authoritative checkpoint.
4. Obtain the runtime Adapter from the consumer.
5. Compare its requested adapterId with checkpoint.adapterId.
6. Start that adapter and try loadSession(internalSessionId).
7. Either it works or return the actual typed load failure.
```

The adapter remains consumer input:

```ts
const record =
  await sessionManager.getAgentSessionRecord(agentSessionId);

const session = await sessionManager.loadAgentSession(agentSessionId, {
  adapter: resolveAdapter(record.adapterId),
});
```

We should expect ordinary loading to work. The registry and checkpoint tell us what to attempt; they do not replace attempting it.

## Same identity, different implementation

This is valid:

```text
Persisted adapterId: "opencode"
Runtime adapterId:   "opencode"
Old executable:      opencode 1.2
New executable:      opencode 1.3
```

The library should simply try loading the internal session.

We should not compare adapter object identity, command arrays, package versions, or executable hashes unless an adapter later declares a specific incompatibility.

The load result is authoritative:

- Success: continue.
- Session not found: typed load failure/recovery.
- Unsupported load: typed capability failure.
- Harness crash: transport failure.

## Different adapter identity

This should fail before attempting to load the old ID:

```text
Persisted adapterId: "opencode"
Requested adapterId: "claude"
```

```ts
throw new AdapterMismatchError({
  expectedAdapterId: "opencode",
  receivedAdapterId: "claude",
});
```

Trying the same string ID against an unrelated adapter is dangerous:

- IDs can accidentally collide.
- The adapter may accept the ID but load an unrelated session.
- Success would not prove that the conversation was transferred.

Changing adapters is therefore an explicit recovery/switch operation:

```ts
await sessionManager.loadAgentSession(agentSessionId, {
  adapter: claudeAdapter,
  adapterId: "claude",

  recovery: {
    strategy: "new_from_transcript",
  },
});
```

That does not load the old internal ID. It:

1. Reads the old transcript.
2. Builds continuation context.
3. Creates a new internal session with the new adapter.
4. Seeds it with the continuation.
5. Updates the same logical `agentSessionId`.
6. Records the old internal session in history.
7. Records a `recovery` or `switch` transition.

If two differently named adapters are genuinely resume-compatible, that should be an explicit adapter migration declaration or explicit consumer recovery strategy—not an automatic guess.

## Missing transcript

Your instinct is correct: if a session record says a transcript exists and that transcript is the continuation authority, a missing file must not create a new session.

It should fail before starting the harness:

```ts
throw new TranscriptNotFoundError({
  agentSessionId,
  path,
});
```

Related failures should stay distinct:

```text
TranscriptNotFoundError
TranscriptUnavailableError    // permissions/I/O
TranscriptCorruptionError
TranscriptIdentityError       // belongs to another AgentSession
```

The behavior depends on how the session was created:

### Transcript-enabled session

```text
Registry says transcript exists
→ transcript missing
→ fail
```

Do not:

- create an empty transcript;
- load from a stale registry projection silently;
- start a new internal session;
- overwrite the missing path.

The consumer can then repair the path, restore a backup, explicitly accept registry state, or supply external continuation.

### Registry-only session

```text
Registry says transcript: null
→ no transcript expected
→ use registry checkpoint
→ load internalSessionId
```

Absence is only an error when the persisted session claims it has a transcript.

### Direct transcript open

```ts
await AgentSession.open({
  persistence: {
    registry: false,
    transcript: {
      path: "/expected/session.jsonl",
    },
  },
  adapter,
});
```

If the path does not exist, `open()` fails. Only `create()` may create a new transcript.

## Is this already handled by `providerSession.kind: "load"`?

Only partially.

The current behavior already distinguishes provider-thread intent:

```ts
providerSession: {
  kind: "load",
  internalSessionId,
  onFailure: "error",
}
```

That correctly prevents a failed harness load from silently becoming a new harness session.

However, current transcripts are history-only:

- Their existence does not control loading.
- A missing transcript is generally treated as an empty read.
- The current `readTranscript()` path swallows missing/read errors and returns `[]`.

Therefore, `kind: "load"` protects against a missing harness session, but it does not protect against a missing authoritative transcript. The new managed `open/loadAgentSession` behavior must add that check.

The legacy option:

```ts
onFailure: "new"
```

may remain for compatibility with explicitly requested low-level behavior, but managed restoration must never select it automatically.

## Extensible recovery order

I would formalize recovery as ordered strategies:

```text
resolve_checkpoint
→ load_internal_session
→ new_from_transcript
→ new_from_consumer_continuation
→ unresolved
```

Not every strategy runs automatically:

- `load_internal_session` is the default.
- `new_from_transcript` requires explicit permission.
- `new_from_consumer_continuation` requires supplied context.
- Creating an empty replacement session is never an implicit recovery.

This handles the difficult combination too:

```text
Different adapter + transcript missing
```

There is no automatic safe recovery. The consumer must provide continuation context or abort. Starting a blank session while preserving the old `agentSessionId` would falsely imply continuity that the library does not possess.


Yes. The current spec still predates several decisions we just made. Before implementation, we should update it in these areas:

- Remove `resolveAdapter` from `SessionManagerConfig`. Adapters are supplied per create/open operation; the manager stores only `adapterId`.
- Remove `internalSessionHistory` from `AgentSessionCheckpoint`. Keep bounded current-routing information plus history revision/digest; full history belongs in registry/transcript transitions.
- Define adapter identity behavior:
  - Same `adapterId`: attempt normal `loadSession()`.
  - Different `adapterId`: throw `AdapterMismatchError`.
  - Cross-adapter continuation must be an explicit switch/reconstruction operation.
- Define the extensible recovery sequence:
  1. Resolve checkpoint.
  2. Attempt internal-session load.
  3. Optionally reconstruct from transcript.
  4. Optionally reconstruct from consumer-provided continuation.
  5. Otherwise remain unresolved.
- Defer certified automatic replay from v0. Dirty boundaries should become `uncertain` and require explicit resolution.
- Tighten missing-transcript behavior:
  - `open()` never creates a missing transcript.
  - If the registry says a transcript is the continuation authority and it is missing, throw `TranscriptNotFoundError` before starting the harness.
  - Distinguish missing, unavailable, corrupt, and identity-mismatched transcripts.
  - Registry-only sessions remain loadable without transcripts.
- Make clear that managed restoration never inherits the legacy `onFailure: "new"` behavior. It must not silently replace a missing harness thread.
- Update deletion to the agreed tombstone model with `deleteTranscript` and `removeRegistryEntry`.
- Normalize conditional authority:
  - Registry + transcript: registry provides discovery; transcript provides continuation.
  - Registry only: registry provides both.
  - Transcript only: consumer/path provides discovery; transcript provides continuation.
  - Neither: consumer owns all continuation state.
- Remove or correct the remaining manager-level/default-root wording that implies each session can relocate the manager registry.

So yes: this is a necessary consistency pass, not merely editorial cleanup. The current draft would otherwise lead implementation toward the wrong adapter ownership, oversized checkpoints, and unsafe implicit recovery.



# auditLog

There are two separate needs here, and a second file only solves one of them.

The current capture model can already represent “retain what the agent did, but not the conversation”:

```ts
persistence: {
  transcript: {
    preset: "activity",
    capture: {
      messages: "none",
      tools: "metadata",
      lifecycle: true,
      usage: true,
    },
  },
}
```

So a second file is not required merely to exclude chat content. Filtering happens before persistence, meaning messages never enter the file.

However, a second artifact becomes valuable when the consumer wants both:

- A conversation/restoration transcript, perhaps short-lived and access-restricted.
- A durable operational audit log, perhaps retained longer and accessible to administrators.

Those have different retention, permissions, and security policies. Keeping them in one JSONL file makes independent deletion or access impossible.

I would model that distinction explicitly rather than calling both “transcripts”:

```ts
persistence: {
  transcript: {
    path: "/data/transcripts",
    preset: "conversation",
  },

  auditLog: {
    path: "/data/audit",
    capture: {
      tools: "input",
      lifecycle: true,
      permissions: "decision",
      usage: true,
    },
  },
}
```

The roles would be:

- `transcript`: canonical continuation/restoration artifact. It may contain conversation content and always contains structural checkpoints.
- `auditLog`: operational evidence. It references `agentSessionId`, `operationId`, `recordId`, and transition IDs, but is not used to restore the session.

That last rule is important. If both files were restoration authorities, every operation would require a distributed transaction across two files. A power failure could leave one ahead of the other. Keeping only the transcript authoritative avoids that complexity.

There is also a gap in our current capture policy. This:

```ts
tools: "none" | "metadata" | "content"
```

is too coarse for auditing. “Content” combines tool arguments and commands with potentially enormous tool output. A consumer often wants to know:

> The agent ran `bun test` and edited these files.

without storing the entire test output or file contents.

I would change it to:

```ts
tools: "none" | "metadata" | "input" | "content";
```

Where:

- `metadata`: tool name, status, timing, identifiers.
- `input`: metadata plus arguments, commands, paths, and edit patches.
- `content`: input plus tool results, terminal output, file contents, and other returned content.

That gives us a genuinely useful audit configuration:

```ts
auditLog: {
  capture: {
    messages: "none",
    reasoning: "none",
    tools: "input",
    lifecycle: true,
    transitions: "metadata",
    permissions: "decision",
    usage: true,
    configuration: "selections",
    protocol: "none",
  },
}
```

One warning: tool inputs can still be highly sensitive—commands reveal paths, edit patches contain source, and shell arguments may contain credentials. An audit log is smaller and differently scoped, but not inherently safe.

My recommendation is:

1. Add `tools: "input"` now.
2. Confirm that a single transcript can operate with `messages: "none"`.
3. Add `auditLog` as a separate optional sink/artifact.
4. Keep the audit log non-authoritative for restoration.
5. Do not create two files by default; only create the audit log when explicitly configured.

This also clarifies an important consequence: if messages are excluded from the canonical transcript, ordinary internal-session loading can still work, but `new_from_transcript` reconstruction may be unavailable. The continuation report should expose that rather than discovering it only after the internal harness thread has disappeared.








These are valuable criticisms. The first three reveal actual contradictions, not just missing implementation detail. I would revise my previous answer: the architecture is ready, but the contract needs one more correction pass before implementation.

1. Pre-dispatch termination

Agreed, with one adjustment: ordinary queue cancellation should normally produce no operation record because queued work has not entered the pre-dispatch persistence phase.

Add:

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

  abortReason?:
    | "pre_dispatch_persistence_failure"
    | "pre_dispatch_cancelled";
}
```

The compensation algorithm should be explicit:

1. Track every artifact where `started` became durable.
2. If a later required pre-dispatch write fails, do not contact the harness.
3. Append `operation(aborted)` to every artifact that contains `started`.
4. Publish a settled checkpoint where possible.
5. If the compensating write fails, reopening remains conservatively uncertain.

That last condition is unavoidable: knowing in memory that dispatch did not happen is insufficient after a crash unless the fact was persisted.

2. Reconstructing internal-session history

Agreed. Deriving history from timestamps and partial transition records would be nondeterministic.

I would introduce an explicit activation phase:

```ts
event:
  | "started"
  | "target_created"
  | "target_activated"
  | "completed"
  | "failed";
```

`target_activated` should carry the exact immutable history entry being committed:

```ts
historyEntry: InternalSessionHistoryEntry;
```

The canonical fold becomes simple:

- `started` and `target_created` do not modify history.
- `target_activated` appends exactly its `historyEntry`.
- Repeated records with the same transition ID must contain the identical entry.
- Failure before activation does not change current routing or history.
- Failure after activation keeps the target current and retains the committed history entry.
- `completed` describes orchestration completion; it does not independently mutate history.

This also supplies configuration, activation/deactivation timestamps, model, protocol, adapter, and replacement reason without asking every reader to infer them.

3. Undefined repair operations

Agreed, although I would not build every repair operation into v0.

I suggest dividing them:

- Transcript relocation and arbitrary import: explicitly deferred. Remove language implying they already have public APIs.
- Live persistence failure: no in-place repair in v0. The session remains blocked and must be stopped.
- Audit replacement/disable: supported through an offline manager operation.
- Missing transcript authority: requires an explicit offline repair acknowledging loss of transcript authority.

A possible managed API:

```ts
await sessionManager.reconfigureAgentSessionPersistence(agentSessionId, {
  expectedRecordRevision,

  transcript:
    | { action: "keep" }
    | {
        action: "disable";
        acknowledgeContinuationLoss: true;
      }
    | {
        action: "replace";
        config: TranscriptConfig;
        checkpoint: AgentSessionCheckpoint;
        acknowledgeContinuationLoss: true;
      },

  auditLog:
    | { action: "keep" }
    | {
        action: "disable";
        acknowledgeAuditGap: true;
      }
    | {
        action: "replace";
        config: AuditLogConfig;
        acknowledgeAuditGap: true;
      },
});
```

It must require no live writer, use registry CAS, and never start a harness. The following `loadAgentSession()` then uses the repaired configuration normally.

4. Hard removal

Agreed with your choice. Prohibit hard registry removal while retaining any library-managed artifact.

Therefore:

```ts
removeRegistryEntry: true
```

requires deletion of every configured transcript and audit log in the same operation. Otherwise it throws. This gives us an enforceable guarantee and eliminates library-created orphans.

Externally copied files may still exist, naturally, but they are outside the managed identity guarantee.

5. Consumer-controlled durable dispatch

Agreed. The current statement promises an integration point that does not exist.

I would remove it for v0:

> With registry and transcript persistence disabled, no durable dispatch boundary exists.

Consumers needing database-backed durability should provide an `AgentSessionStore` through `SessionManager`. A more general pre-dispatch persistence coordinator can remain deferred. We should not introduce another sink abstraction until we know the manager store cannot cover the orchestration use case.

6. Record-size limits

Agreed. This is both a storage and input-validation requirement.

We need separate limits:

```ts
interface PersistenceLimits {
  maxRecordBytes: number;
  maxCapturedFieldBytes: number;
  maxJsonDepth: number;
  maxCursorBytes: number;
}
```

Suggested initial defaults:

```ts
{
  maxRecordBytes: 1_048_576,       // 1 MiB
  maxCapturedFieldBytes: 262_144,  // 256 KiB
  maxJsonDepth: 64,
  maxCursorBytes: 4_096,
}
```

Rules:

- Measure encoded UTF-8 bytes, not JavaScript character count.
- Truncate strings only on valid UTF-8/code-point boundaries.
- Oversized structured values become an explicit omission object containing:
  - reason;
  - original byte count;
  - SHA-256 digest of the omitted serialized value.
- Truncate tool results before tool inputs.
- Never truncate identity, sequencing, operation boundaries, or checkpoint integrity fields.
- An oversized structural record is a persistence error, not a truncated record.
- Full activity snapshots remain bounded by these limits, preventing unbounded repeated growth.
- Cursor decoding validates encoded size before decoding, then nesting, numeric ranges, and offsets before filesystem access.

So yes: I would incorporate all six, with the modifications above. After that pass, I would consider the specification genuinely ready for phase-one implementation.







---


# Review passes


These are real blockers. The first is slightly nuanced—`SessionConfigurationCheckpoint` is already filtered by the separate restoration policy—but it still violates the declared structural-record contract, and mechanically copying it into the audit log is definitely wrong.

I would resolve them as follows.

1. Separate transcript and audit transitions

The transcript transition may retain the already-filtered restoration configuration because it needs to reconstruct canonical internal-session history. The spec must explicitly identify this as restoration state, governed by `sessionConfiguration`, not `capture.configuration`.

The audit log needs its own sanitized shape:

```ts
interface AuditLogTransitionRecord extends AuditLogEnvelope {
  t: "transition";
  transitionId: string;
  kind: TransitionKind;
  event:
    | "started"
    | "target_created"
    | "target_activated"
    | "completed"
    | "failed";

  from?: AuditInternalSessionDescriptor;
  to?: AuditInternalSessionDescriptor;
  failedAfter?: TransitionPhase;
  errorCode?: string;
}

interface AuditInternalSessionDescriptor {
  internalSessionId: string | null;
  adapterId: string;
  mode: "normal" | "degraded";
  model: string | null;
  protocol: { name: "acp"; version: number } | { name: "pty" };
}
```

It must omit:

- `sessionConfiguration`;
- `historyEntry`;
- summary and continuation content;
- replacement reasons when they contain consumer text.

The generic `AuditRecordFrom<TranscriptTransitionRecord>` mapping should be removed. Security-sensitive audit records should have concrete schemas.

2. Normalize history transition identity

Agreed:

```ts
interface InternalSessionHistoryTransition {
  kind: "handoff" | "switch" | "mode_change" | "replacement";
  transitionId: string;
  reason?: string;
}
```

Every transition kind then participates in the same canonical matching rule. `reason` should be persisted only when admitted by the relevant restoration/capture policy; a content-free reason code would be preferable to arbitrary text.

3. Repair an uncovered `target_activated`

Deterministic checkpoint repair is the consistent result.

A durable `target_activated` means the transition fold has committed:

- the previous history entry;
- the target’s current identity;
- configuration/model/protocol state;
- the history revision and digest.

If the following checkpoint is absent, reopening should:

1. Start from the preceding valid checkpoint.
2. Apply the exact `target_activated` record.
3. Derive the new checkpoint deterministically.
4. Append and synchronize it.
5. Repair the registry projection.
6. Report that checkpoint repair occurred.

This is not an uncertain provider operation. If the target thread subsequently cannot be loaded, that is a separate continuation-availability failure and appears in `ContinuationReport`.

A malformed or incomplete activation record remains corruption.

4. Prepared deletion

Agreed. Deletion needs the same transaction structure as reconfiguration:

```text
CAS prepared deletion
→ hide/block the session from ordinary load
→ acquire artifact locks
→ delete requested artifacts
→ fsync parent directories
→ finalize tombstone or remove registry entry
```

The registry should carry something like:

```ts
pendingDeletion?: {
  deletionId: string;
  requestDigest: string;
  status: "prepared";
  deleteTranscript: boolean;
  deleteAuditLog: boolean;
  removeRegistryEntry: boolean;
  startedAt: string;
}
```

The caller supplies a stable `deletionId`, allowing an interrupted deletion to be retried idempotently.

Until finalized:

- ordinary loading fails with `DeletionInProgressError`;
- normal listing hides it;
- `includeDeleted: true` exposes it;
- another deletion ID or conflicting request fails;
- identity remains reserved.

This also fixes transcript-only deletion and audit-only deletion, not merely full removal.

5. Configuration mismatch resolution

We need a distinct API because this is not crash recovery:

```ts
await session.resolveConfigurationMismatch({
  strategy: "accept_effective",
});

await session.resolveConfigurationMismatch({
  strategy: "replace_desired",
  selections: {
    model: "sonnet",
    reasoning: "high",
  },
});
```

Semantics:

- `accept_effective` makes the currently announced effective values the new desired restoration state.
- `replace_desired` applies the supplied selections in one ordinal pass and persists the resulting desired/effective state.
- Both create a configuration record and checkpoint before unblocking.
- Failure leaves the mismatch unresolved.

I would remove “start a new thread” from this API. The consumer can resolve/accept configuration first and then explicitly hand off or switch. Combining thread replacement with configuration reconciliation creates another compound state machine unnecessarily.

6. Strict create semantics

Agreed. `create()` must reject any initialized transcript or audit log, even when its `agentSessionId` matches.

Claimable destinations are only:

- absent paths;
- existing zero-byte regular files acquired under the exclusive writer lock.

Anything containing a recognized header, legacy transcript content, malformed content, or even unrelated bytes is not claimable by `create()`.

7. Deterministic option merging

Use `activity` as the default transcript preset whenever transcript persistence is explicitly enabled, including direct `transcript: {}`.

Resolve managed configuration layer by layer:

1. Managed library defaults.
2. Manager session defaults.
3. Per-session options.

At each layer:

- `false` disables the artifact.
- A supplied `path` replaces only the path.
- A supplied `preset` resets the capture policy to that preset.
- That same layer’s `capture` overrides individual members after preset expansion.
- A layer with no `preset` merges its `capture` into the previously resolved policy.
- `limits` merge member-by-member.
- Arrays such as configuration `include`/`exclude` replace rather than concatenate.

Thus:

```ts
// Retains manager preset and capture settings:
transcript: { path: "/customer/path" }

// Resets policy to detailed, then changes messages:
transcript: {
  preset: "detailed",
  capture: { messages: "none" },
}
```

8. Make truncation conform to the schemas

Whole message records should never disappear when message capture is enabled.

Rules:

- `text: string` remains a string and is Unicode-safely truncated.
- Optional structured fields such as `structured` may be omitted, with envelope truncation metadata.
- Required `JsonValue` fields may contain `OmittedPersistedValue`.
- Strongly typed structural fields cannot be replaced with omission markers.
- A record is retained unless its nontruncatable structure alone exceeds the hard limit, which becomes a typed persistence failure.
- Conversation availability becomes `partial` when a message record has truncation metadata affecting `text` or `structured`.

That removes the type contradiction and preserves evidence that content existed.

9. Remove stale relocation support

Agreed. `loadAgentSession()` should say it rejects transcript path overrides. Healthy relocation and arbitrary new destinations remain deferred.

The offline replacement operation is recovery at the recorded path, not relocation.

10. Introduce a view-independent snapshot cursor

`listActivityStates()` should not accept a page cursor tied to a projection/filter. Add:

```ts
interface TranscriptPage<T, C> {
  items: readonly T[];
  snapshot: TranscriptSnapshotCursor;
  // Existing navigation fields...
}

interface ListTranscriptActivitiesOptions {
  at?: TranscriptSnapshotCursor;
  status?: "open" | "terminal" | "all";
  order?: "updated_desc" | "updated_asc";
  limit?: number;
}
```

`TranscriptSnapshotCursor` identifies only:

- artifact ID and generation;
- snapshot high-water sequence and byte offset;
- boundary digest.

It contains no view/filter fingerprint. Default ordering should be `updated_desc`, with `activityId` as the deterministic tie-breaker. The result is limited but not itself paginated in v0.

So, unfortunately, the spec still was not implementation-ready. These corrections are worth making first; otherwise we would immediately encode contradictions into the public types and recovery machinery.





These changes are directionally right and improve the architecture, not merely patch the wording. They push the design toward three healthy principles:

- persisted schemas are sink-specific;
- transcript state is reducible deterministically;
- destructive maintenance uses explicit transactions.

I would adopt all ten, with a few important refinements.

## Important refinements

1. **Do not generically map any security-sensitive transcript record into audit records.**

   Separating transition records is essential. I would go slightly further: audit records should generally have concrete schemas for transitions, permissions, configuration, and activity. A generic `AuditRecordFrom<T>` creates a future security hazard: adding a field to a transcript schema can silently add it to the audit artifact.

   Architecturally, use one normalized internal event and two explicit projections:

   ```text
   normalized runtime event
       ├── transcript projection — restoration + capture policy
       └── audit projection      — audit allowlist only
   ```

   The transcript configuration exception should explicitly say that filtered restoration values may appear in checkpoints and canonical transition-history records, governed exclusively by `sessionConfiguration`.

2. **Keep arbitrary reason text out of canonical history.**

   Normalizing `transitionId` is correct, but conditional capture cannot affect canonical history or its digest. Otherwise two sessions with identical routing history but different capture policies produce different canonical history.

   I would split it:

   ```ts
   interface InternalSessionHistoryTransition {
     kind: TransitionKind;
     transitionId: string;
     reasonCode?: string;
   }
   ```

   Any consumer-authored explanation becomes a separate `reasonText`, admitted only under transition content capture and excluded from history reconstruction and its digest.

3. **Deterministic activation repair needs deterministic checkpoint fields.**

   The repair algorithm is right, but “derive the checkpoint deterministically” requires every digest-covered value to be derivable from the activation record. In particular:

   - resulting `stateRevision`;
   - `updatedAt`;
   - `internalSessionActivatedAt`;
   - history revision and digest;
   - `lastTransition.at`;
   - transcript `coveredSequence`;
   - boundary state.

   Avoid generating a fresh timestamp during recovery. Either put the resulting checkpoint metadata on `target_activated`, or define canonical derivation from fields already present. Otherwise two recovery attempts can produce different checkpoint digests.

   The repair should also be represented directly in `AgentSessionOpenResult`, not only through a notification, because opening listeners may not yet exist:

   ```ts
   repairs: readonly PersistenceRepair[];
   ```

4. **Acquire deletion locks before publishing prepared deletion.**

   The proposed deletion transaction is good, but I would order it as:

   ```text
   resolve targets
   → acquire all artifact locks in canonical order
   → reread and validate registry revision
   → CAS pendingDeletion
   → delete artifacts and fsync directories
   → finalize tombstone/removal
   ```

   Publishing `pendingDeletion` before acquiring locks could leave the session hidden and blocked merely because a live session still owns a writer lock.

   Also, `AgentSessionSummary` needs a way to represent this state when `includeDeleted: true`; `deletedAt` alone is insufficient. Something like:

   ```ts
   lifecycle: "active" | "deletion_pending" | "deleted";
   ```

5. **Configuration replacement must be ordered and crash-safe per selection.**

   `accept_effective` is clean. `replace_desired` should not take a record/object because its semantics depend on order:

   ```ts
   selections: readonly {
     configId: string;
     value: JsonValue;
   }[];
   ```

   Each `setSessionConfigOption` that reaches the harness needs its ordinary operation start/terminal/checkpoint boundary. A single checkpoint after the whole pass is insufficient: a crash after applying selection two of four would leave runtime configuration changed without durable knowledge of which selections succeeded.

   Suggested behavior:

   ```text
   validate mismatch-resolution request
   → apply selection 1 + checkpoint
   → validate returned schema
   → apply selection 2 + checkpoint
   → ...
   → final configuration-resolution record/checkpoint
   → unblock
   ```

   If one fails, prior successful changes remain accurately checkpointed and the mismatch remains unresolved.

   `accept_effective` also needs policy-specific semantics: values excluded by `sessionConfiguration` cannot become persisted desired state. The method can accept the current runtime configuration, but must not claim exact future restoration for omitted values.

6. **Strict creation exposes a broader multi-artifact initialization problem.**

   Rejecting initialized files is correct, but consider:

   ```text
   transcript header successfully created
   → audit header creation fails
   → create() fails
   ```

   A retry now sees an initialized transcript and must reject it. Similar partial states can occur before registry publication.

   Creation therefore needs either:

   - a stable consumer/library-generated `creationId` and resumable prepared creation;
   - temporary artifacts installed only after all are prepared;
   - or explicit cleanup of artifacts proven to have been created by this failed attempt.

   Temporary files alone do not make two artifact renames plus a registry update atomic. A generalized registry maintenance transaction is probably cleaner.

7. **Define how `false` behaves across configuration layers.**

   The merge algorithm is good, but one ambiguity remains: can a higher-precedence object re-enable something disabled by a lower layer?

   I recommend:

   - manager `transcript: false` disables it by default;
   - per-session `transcript: { ... }` explicitly re-enables it, starting from the library `activity` preset;
   - per-session `transcript: false` is final because it is the highest layer.

   The same rule should apply to audit configuration. Also explicitly define whether managed `persistence: false` is legal; it cannot disable the manager registry if managed creation always guarantees discovery.

8. **The truncation rules are coherent, but hashes may leak sensitive values.**

   Keeping every message record is exactly right. One concern: `originalSha256` of captured-but-truncated content can enable dictionary attacks against low-entropy secrets, commands, paths, or configuration values.

   I would either:

   - omit the original hash by default and retain only `originalBytes`;
   - make hashes an explicit diagnostic-policy feature;
   - or hash only non-sensitive structural content.

   A plain SHA-256 digest is not necessarily harmless metadata.

9. **The snapshot cursor design is correct.**

   Define `updated_*` using the sequence number of the greatest activity revision, not timestamps:

   ```text
   primary key: latest activity record seq
   tie-breaker: activityId
   ```

   Also specify that:

   - `at` is inclusive of the snapshot high-water sequence;
   - the snapshot is returned even for an empty page;
   - the page navigation cursor embeds or references the same snapshot identity;
   - status filtering happens after folding activity revisions.

## Larger architectural effect

These changes reveal that the system really has two foundational abstractions.

### A pure transcript reducer

There should be one implementation that folds:

```text
checkpoint + structural journal tail → derived continuation state
```

The writer, opener, registry repair, activation repair, cursor reader, and tests should all use this same reducer. If each subsystem independently implements transition folding, their checkpoint digests will eventually diverge.

The checkpoint becomes a materialized cache of the reducer, not a separately interpreted state object.

### A generalized maintenance transaction

Reconfiguration and deletion now share the same shape, and strict creation likely needs it too. Rather than accumulating independent optional fields such as:

```ts
persistenceReconfiguration?
pendingDeletion?
pendingCreation?
```

consider one mutually exclusive registry field:

```ts
maintenance?: {
  kind: "creation" | "persistence_reconfiguration" | "deletion";
  operationId: string;
  requestDigest: string;
  status: "prepared";
  startedAt: string;
  details: ...;
};
```

That naturally prevents deletion and reconfiguration from racing and gives listing/loading one consistent blocked-state rule.

Finally, promptability should be an explicit composition rather than scattered booleans:

```text
promptable =
  continuation acquired
  AND recovery resolved
  AND configuration matched
  AND persistence healthy
  AND no maintenance operation pending
```

That will become important because these changes introduce several intentionally independent state machines.

Bottom line: I would accept the proposed direction. The key additional work is making activation-derived checkpoint fields deterministic, making configuration replacement crash-safe per setting, and extending prepared transactions to creation—not just deletion and repair.










These are good findings. Most are genuine specification holes, not overengineering. I would adopt them, with a slightly different solution for maintenance idempotency and creation provenance.

1. Capture schemas: agree

If `reasoning` and protocol `metadata` are configurable capture components, they need concrete records.

I would add:

- `TranscriptReasoningRecord`
- `AuditLogReasoningRecord`
- `TranscriptProtocolMetadataRecord`

Reasoning should use complete revisions under a stable `reasoningId`, like activity snapshots, instead of persisting every stream delta. Protocol metadata should contain a normalized allowlist of initialization/capability information; raw ACP payloads remain exclusive to `TranscriptRawRecord`.

2. Structural reducer: agree strongly

Capture-dependent configuration and lifecycle records must not affect continuation.

The canonical reducer should consume only:

```ts
type TranscriptStructuralRecord =
  | TranscriptCheckpointRecord
  | TranscriptOperationRecord
  | TranscriptTransitionRecord;
```

Configuration mutations, mismatch resolutions, and recovery resolutions become authoritative through their resulting checkpoints. Their configuration/lifecycle records are display history only.

Section 10’s definition of the journal tail should use this exact shared type. Capture policy must never change reducer output.

3. Maintenance read/idempotency: agree, with bounded receipts

`AgentSessionStore` needs:

```ts
getMaintenance(agentSessionId: string):
  Promise<SessionMaintenance | null>;
```

For finalization retries, I would add bounded completion receipts:

```ts
interface MaintenanceCompletionReceipt {
  agentSessionId: string;
  operationId: string;
  requestDigest: string;
  kind: SessionMaintenance["kind"];
  outcome: "completed";
  completedAt: string;
}
```

The store atomically replaces the prepared transaction with a receipt when finalizing.

However, we should not promise eternal idempotency. Receipts must have a documented retention bound. Therefore:

> Retrying is idempotent while either the prepared transaction or its completion receipt remains available.

This matters particularly after hard deletion and later reuse of the same `agentSessionId`.

4. Provider-ID persistence order: agree

The current window is not narrow. Creation should be:

```text
prepare maintenance
→ create provider thread
→ immediately persist staged continuation identity
→ construct/sync/install session logs
→ persist complete staged record
→ finalize
```

The first maintenance update need not contain the complete final registry record. It should hold a bounded `stagedContinuation` containing the internal ID, adapter, protocol, model/configuration state, and activation time. The unavoidable loss window then really is only between the provider response and that first durable update.

5. Installed-log provenance: agree, but it is structural—not cryptographic

This is the point you were unsure about. We do need it.

Otherwise, after a crash, the library cannot safely establish whether a final-path file was installed by the interrupted transaction or pre-existed. Locks prevent concurrent writers, but they do not establish ownership across process death.

I would use:

```ts
interface SessionLogInstallation {
  kind: "creation" | "persistence_reconfiguration" | "restoration";
  operationId: string;
  requestDigest: string;
}
```

Every transcript/audit header contains:

```ts
installation: SessionLogInstallation;
```

This replaces `reconfigurationId`.

Matching the prepared transaction against the header allows safe retry and cleanup. It is not tamper resistance or cryptographic proof against an attacker; it is transaction provenance under the library’s locking and corruption model.

A random installation nonce could also work, but the operation ID plus request digest already carries the required identity and exact-request check.

6. Tombstone restoration: agree

Restoration is effectively creation applied to an existing tombstone. It needs:

```ts
restorationId: string;
expectedRecordRevision: number;
```

and:

```ts
kind: "restoration"
```

in `SessionMaintenance`.

The prepared restoration should cover replacement logs, continuation acquisition, transition/checkpoint persistence, and final tombstone clearing. A crash must leave a resumable `maintenance_pending` restoration, not orphaned logs or threads.

7. Configuration fidelity: agree

I would rename `desired` to `restorationTargets`:

```ts
interface PersistedSessionConfigSelection {
  configId: string;
  type: "select" | "boolean" | "unknown";
  value: JsonValue;
  ordinal: number;
  source: "explicit_selection" | "accepted_effective";
  recordedAt: string;
}
```

Rules:

- `restorationFidelity: "exact"` only when all relevant announced effective values were admitted by policy.
- `values: "none"` is immediately `partial`.
- `typed` becomes `partial` whenever an announced value is omitted because it is unsupported or unknown.
- Choosing a lossy persistence policy is itself acceptance of partial future restoration. It should not force a mismatch on every reopen.
- A persisted restoration target that disappears, becomes invalid, or is rejected still produces `mismatch`.
- `accept_effective` creates restoration targets with `source: "accepted_effective"` and a real `recordedAt`; it does not pretend they were explicitly applied.

The remaining smaller findings are also correct:

- Require caller-supplied `agentSessionId` and `creationId` for persistent direct creation. Managed creation may generate them because pending work is discoverable through its registry.
- Fix the stale “lower-level constructor, then registry” description.
- Define `transitionId` for all transition kinds.
- Remove the claim that whole retained messages can be omitted.
- Say “with all deletion flags omitted or false.”
- Apply the exact `abortReason` presence invariant to audit operation records too.

So yes: I would implement all of these changes. The provenance proposal in point 5 is necessary, but it should be described as transaction ownership evidence—not cryptographic authentication.








I’ll do one more clean pass over the latest text, concentrating on whether those maintenance, restoration, configuration-fidelity, and record-schema gaps were actually closed—and whether the fixes introduced new contradictions elsewhere.This version is much closer. The previous structural-transition, maintenance-read, restoration-transaction, configuration-model, reasoning/protocol-schema, and stale-text problems are largely fixed. I still see four blockers and several smaller inconsistencies.

## Blockers

1. **`prepareMaintenance()` cannot report “already completed.”**

   Its return type is `Promise<void>` ([lines 1258–1262](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1258)), but an exact completion receipt is supposed to report that the operation already completed without creating a reservation ([lines 1286–1290](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1286)).

   The caller must distinguish:

   - newly prepared: continue performing the operation;
   - already prepared: resume it;
   - already completed: do not perform it again.

   With `void`, a caller could proceed after an already-completed result despite holding no reservation.

   It needs a discriminated result:

   ```ts
   type PrepareMaintenanceResult =
     | { status: "prepared"; maintenance: SessionMaintenance }
     | { status: "already_prepared"; maintenance: SessionMaintenance }
     | { status: "already_completed"; receipt: MaintenanceCompletionReceipt };
   ```

2. **High-level return semantics after an “already completed” receipt are undefined.**

   This matters because these methods do not merely return `void`:

   - create returns a live `AgentSession`;
   - restoration returns `AgentSessionOpenResult`;
   - reconfiguration returns a summary.

   A receipt contains no original continuation report, repair report, or live session ([lines 678–685](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:678)). After a lost response, an identical retry cannot reproduce the original method result.

   Define one of these contracts:

   - mutation idempotency only, with an `AlreadyCompleted` result requiring a separate load;
   - retry transparently performs an ordinary load and returns a newly produced open report;
   - completion receipts retain a serializable operation result, while live objects are reacquired separately.

   The first is probably cleanest. Do not imply full call-result idempotency if only the mutation is idempotent.

3. **Restoration request identity is not canonicalizable as currently typed.**

   `restoreAgentSession()` places `OpenContinuationOptions` inside a request identified by a canonical `requestDigest`, but a continuation strategy may contain a JavaScript `buildContinuation` function ([lines 2499–2525](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:2499)). Functions cannot be canonically serialized or compared across retries.

   Consumer continuation strings create another problem: hashing their content can leak a guessable fingerprint through the registry and permanent log header.

   Require stable, nonsecret strategy identity separately from executable behavior:

   ```ts
   {
     kind: "new_from_transcript";
     strategyId: string;
     buildContinuation: TranscriptContinuationBuilder;
   }
   ```

   The maintenance digest should cover `strategyId`, strategy order, target adapter ID, paths, and other nonsecret intent—not callback identity or raw continuation content. If exact consumer continuation equality is required, the API needs an explicit caller-provided opaque `continuationId`.

4. **Deterministic repair of an uncovered `aborted` record remains underdefined.**

   Activation records now carry every digest-relevant derivation field. Abort records do not. Yet restoration claims it can synthesize a settled checkpoint deterministically without fresh timestamps ([lines 2416–2422](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:2416)).

   It still needs normative rules for:

   - resulting `stateRevision`;
   - `updatedAt`;
   - whether `lastSettledOperationId` becomes the aborted operation or remains unchanged;
   - `coveredSequence`;
   - exact boundary content.

   Add an `abortState` analogous to `activationState`, or explicitly derive these fields from envelope `stateRevision`, `ts`, `seq`, and `operationId`, including the canonical timestamp conversion.

## Likely legacy regression

Direct persistent creation now requires caller-supplied `agentSessionId` and `creationId` ([lines 381–385](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:381)), and strict creation rejects legacy/malformed nonempty files.

That is fine for the new `persistence` API, but it may regress deprecated `transcriptPath`/`transcriptDir` usage if compatibility normalization causes them to count as “persistence enabled.” Existing legacy behavior allows generated logical IDs and historically tolerated permissive v1 files.

The compatibility section should explicitly state:

> The direct-creation ID requirements, strict empty-destination rule, and v2 maintenance transaction apply only to the new `persistence` configuration. Deprecated transcript options retain their historical ID generation and append behavior during compatibility mode.

Otherwise the compatibility guarantees at [lines 2954–2995](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:2954) conflict with strict creation.

## Other real inconsistencies

- **Direct creation has no completion receipt.** Its marker is removed before the call returns ([lines 359–370](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:359)). If the process dies after marker removal but before the caller receives success, retry sees initialized logs and fails. Either document that direct creation is resumable only before finalization or retain a bounded direct completion receipt.

- **Receipts are bounded per ID, not globally.** Keeping 32 receipts per `agentSessionId` still leaves the central registry growing forever as unique IDs are hard-deleted ([lines 848–854](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:848)). It also means “fully destructive” deletion retains logical ID and timing metadata. Add a global bound/purge contract or explicitly weaken the hard-deletion semantics.

- **Configuration resolution can incorrectly report `matched`.** `replace_restoration_targets` says its final checkpoint marks the status matched ([lines 1107–1112](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1107)). If persistence policy excludes any effective values, the recomputed status must remain `partial`, not `matched`.

- **Replacement semantics need one sentence.** Clarify that successful `replace_restoration_targets` replaces the old target list exactly, rather than merging into it. Otherwise old disappeared targets could survive the resolution.

- **The v1 upgrade entry point is unclear.** Strict `create()` rejects legacy content and ordinary `open()` requires continuation state that a v1 transcript may not contain, yet the migration section says a v2 writer can intentionally open and upgrade v1 ([lines 2968–2986](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:2968)). State explicitly that only the migration/import utility performs this upgrade, or define another entry point.

- **Replacement generation identity remains ambiguous.** Section 19 says a new generation may preserve `transcriptId`; reconfiguration says it creates a new identity and generation. V0 should mandate whether replacement uses `(same ID, generation + 1)` or `(new ID, generation 1)`.

- **Error taxonomy omits restoration in one sentence.** `SessionMaintenanceConflictError` is described as covering creation, reconfiguration, or deletion, but maintenance now also includes restoration ([lines 2706–2709](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:2706)).

Overall, the architecture is now coherent in shape. The remaining serious work is mostly about idempotency boundaries: distinguishing prepared/completed operations, defining what retries return, making continuation strategies comparable, and making abort repair genuinely deterministic.



The review is strong, but it does not require another architectural expansion. Three blockers need direct fixes; the idempotency issue should be resolved by narrowing the guarantee rather than persisting complete method results.

## Changes I would make now

1. `prepareMaintenance()` returns a discriminated result

This is a real type-level hole. Adopt the proposed result:

```ts
type PrepareMaintenanceResult =
  | { status: "prepared"; maintenance: SessionMaintenance }
  | { status: "already_prepared"; maintenance: SessionMaintenance }
  | { status: "already_completed"; receipt: MaintenanceCompletionReceipt };
```

Only `prepared` and `already_prepared` authorize continuing the mutation.

2. Promise mutation idempotency only

We should not persist continuation reports, repair reports, or serialized method results. That adds substantial state and still cannot reproduce a live object.

The contract should say:

> Maintenance idempotency applies to the durable mutation, not reproduction of the original method result.

On an `already_completed` receipt:

- `deleteAgentSession()` can return successfully because its return type is `void`.
- Create, restoration, and reconfiguration return/throw a typed `MaintenanceAlreadyCompleted` outcome carrying the receipt.
- The consumer then uses `loadAgentSession()` or `getAgentSessionInfo()` to obtain current state.

That is honest and avoids pretending a newly opened object/report is the original result.

3. Add stable continuation-strategy identities

This is necessary because callbacks cannot enter a canonical digest.

```ts
type ContinuationStrategy =
  | { kind: "load_internal_session" }
  | {
      kind: "new_from_transcript";
      strategyId: string;
      buildContinuation: TranscriptContinuationBuilder;
    }
  | {
      kind: "new_from_consumer_continuation";
      continuationId: string;
      continuation: string;
    };
```

The maintenance digest includes strategy kind, order, `strategyId`/`continuationId`, adapter ID, and other nonsecret intent. It excludes:

- callback identity;
- generated continuation text;
- consumer continuation content.

The caller must reuse the same behavior/content for the same ID. The library deliberately cannot verify content equality without retaining a guessable fingerprint. Stronger verification can be deferred.

4. Define aborted-checkpoint reduction without another model

We do not need `abortState`. Require `stateRevision` on `operation(aborted)` and define:

- `stateRevision = previous stateRevision + 1`;
- `updatedAt = canonical ISO conversion of envelope.ts`;
- `lastSettledOperationId = aborted operationId`;
- `boundary = { status: "settled", lastSettledOperationId: operationId }`;
- transcript `coveredSequence = aborted record seq`;
- every other continuation field remains unchanged.

Also define the timestamp conversion precisely, including millisecond precision. That makes abort repair deterministic with existing fields.

## Small corrections to make now

These are inexpensive and valid:

- Legacy transcript options retain generated IDs, permissive append behavior, and do not enter strict v2 creation maintenance.
- `replace_restoration_targets` replaces the entire old target list.
- Its resulting configuration status is recomputed as `exact` or `partial`; it must not unconditionally say `matched`.
- Only the explicit migration/import utility upgrades a v1 transcript.
- V0 replacement creates a new transcript/audit-log ID at generation 1. Future rewrite/compaction may preserve ID and increment generation.
- Add restoration to the maintenance-conflict error description.
- Fix the remaining stale wording identified by the review.

## Tradeoffs to document and accept

Direct persistent creation does not need another receipt subsystem. Since direct persistence now requires known IDs and paths:

- before finalization, retry resumes through the marker;
- after finalization but before response delivery, retry sees the initialized transcript;
- the consumer uses `AgentSession.open()` with its known identity/path.

So direct creation is transaction-resumable before finalization, but its original call result is not reproducible afterward. That is acceptable for V0 and should be stated explicitly.

Receipts do need a global bound. I would specify:

- maximum 32 receipts per `agentSessionId`;
- maximum 4096 receipts globally;
- deterministic eviction by oldest `completedAt`, then agent/session and operation ID;
- hard deletion removes session content and discovery state but may temporarily retain this bounded, content-free operational receipt.

That slightly weakens “fully destructive” wording, but accurately bounds the retained metadata.

So I would accept nearly the entire review, but explicitly defer:

- reproduction of original live objects and reports;
- hashing/comparing continuation content;
- direct-session completion receipts.

Those are real limitations, not correctness gaps, once stated clearly.








# review pass


I’ll reread the current file and diff, then re-audit the transaction boundaries, idempotency contracts, recovery rules, and compatibility story against the issues from the last pass.The earlier blockers are now substantially addressed: maintenance preparation has a discriminated result, high-level completed retries have explicit semantics, continuation digests exclude callbacks/content, aborted checkpoint repair is deterministic, receipt storage is globally bounded, and legacy create behavior is scoped away from v2. I’m checking whether those fixes created any contradictions at adjacent API and lifecycle boundaries.The spec is much stronger now, and the blockers from the previous pass are mostly resolved. I still see four implementation blockers and a few smaller contradictions.

## Blockers

1. Canonical history cannot be reconstructed from the specified reducer input

The spec excludes complete history from checkpoints, saying it will be reconstructed from transition records ([spec:917](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:917)). But the reducer receives only a checkpoint plus structural records after its `coveredSequence` ([spec:1143](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1143), [spec:1209](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1209)).

After the first checkpoint following a transition, that transition is no longer in the tail. The checkpoint contains only the history revision/digest, not the entries. Therefore the reducer cannot:

- reconstruct full `internalSessionHistory`;
- append a new entry and recompute its digest;
- repair the registry’s full history projection.

`TranscriptReductionResult` and the history-digest algorithm are also undefined.

I would split this into two explicit folds:

- a history fold over every canonical `target_activated` record through the snapshot;
- a continuation fold from the latest checkpoint over its structural tail.

Define the initial history digest and exact JCS/SHA-256 input as well.

2. Registry-newer in-flight checkpoint validation is not deterministic

The authority rules require reconstructing every field and digest of a registry-newer in-flight checkpoint from the transcript ([spec:1221](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1221)).

But `operation(started)` does not require state revision, checkpoint timestamp, covered sequence, or an in-flight state payload. Moreover, transcript timestamps are expressly forbidden as state-derivation input except for abort repair ([spec:1491](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1491), [spec:1511](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1511)).

So two conforming writers could produce different registry checkpoint `updatedAt` values that the transcript cannot reproduce.

Give `started` something analogous to transition `activationState`, or normatively define:

- next `stateRevision`;
- exact `updatedAt`;
- boundary;
- transcript `coveredSequence`;
- which prior fields are copied.

3. Completion receipts conflict with logical-ID reuse

The spec says receipts do not prevent reuse after hard deletion ([spec:862](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:862), [spec:2931](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:2931)). But `prepareMaintenance()` checks retained receipts before examining the possibly reused identity ([spec:1306](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1306)).

If a new incarnation reuses an old operation ID:

- the same digest produces a false `already_completed`;
- a different digest produces a false conflict.

Either operation IDs must be globally unique and never reused, including across deleted incarnations, or receipts need an incarnation identifier. The latter is structurally safer.

4. The unstaged-provider crash policy still references a nonexistent API

Creation acknowledges the unavoidable crash window after provider creation but before `stagedContinuation` is durable. It says another thread is started only under the “same explicit retry policy” ([spec:374](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:374)), but no such policy or default behavior is defined.

On retry, the library cannot know whether the first provider call completed. It needs a concrete choice such as:

```ts
unstagedProviderOutcome: "fail_uncertain" | "retry_and_allow_orphan"
```

This should cover managed creation and any restoration strategy that can create a thread before staging.

## Flagrant security/detail issue

The direct-maintenance filename includes raw caller-supplied `creationId`:

[spec:265](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:265)

```text
<encoded-agentSessionId>.<creationId>.json
```

Unless IDs have a restrictive validated grammar defined elsewhere, this permits separators, `..`, oversized names, and collisions. Encode both components independently or use a digest-derived filename.

## Smaller inconsistencies

- Snapshot cursors are explicitly view-independent ([spec:2387](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:2387)), but the following generic rule says “a cursor” is invalid with another view/filter ([spec:2393](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:2393)). Qualify that rule as applying only to navigation cursors.
- `getSessionMaintenance()` is said to expose exact normalized retry details, but maintenance records omit significant original inputs such as policies, continuation strategies, adapters, and runtime intent. Either weaken that promise to “persisted recovery state” or store a complete nonsecret retry descriptor.
- Tombstone restoration says the old transcript path is never recreated implicitly, but `replacementTranscript: {}` can resolve through defaults to that exact path ([spec:2915](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:2915), [spec:2961](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:2961)). Require an explicit `path`, or state that explicitly supplying `{}` authorizes the resolved default path with a new identity.

Overall: the audit separation, configuration fidelity, prepared deletion/restoration, strict-v2 compatibility boundary, truncation contract, and completed-maintenance semantics now look coherent. The history fold and in-flight checkpoint derivation are the two most architecturally important remaining problems.





---



This review is valid, but we can close it without materially expanding the architecture. Two issues require deterministic algorithms, one needs an incarnation field, and one can be handled as an explicit V0 limitation.

## 1. History reconstruction: accept, but keep it internal

The current reducer cannot reconstruct history once earlier transitions fall behind the latest checkpoint. We need two folds, but they do not need to become large public abstractions:

```text
history fold:
  all target_activated records through snapshot
  → complete InternalSessionHistory

continuation fold:
  latest checkpoint
  + reconstructed history through checkpoint.coveredSequence
  + structural tail after coveredSequence
  → current continuation state
```

Define:

- Initial history revision: `0`.
- Initial history digest: lowercase SHA-256 of UTF-8 JCS `[]`.
- Each `target_activated.historyEntry` is appended in `seq` order.
- Revision equals the number of canonical entries.
- Digest is lowercase SHA-256 of the UTF-8 JCS serialization of the complete ordered entry array.
- Every checkpoint’s history revision/digest must match the history fold through its `coveredSequence`.

`TranscriptReductionResult` only needs an internal normative shape:

```ts
interface TranscriptReductionResult {
  checkpoint: AgentSessionCheckpoint;
  internalSessionHistory: readonly InternalSessionHistoryEntry[];
  recovery: SessionRecoveryStatus;
  repairs: readonly PersistenceRepair[];
}
```

The implementation may perform both folds in one streaming scan. A disposable index can optimize this later.

## 2. Registry in-flight reconstruction: accept, reuse existing fields

We do not need another `startState` object. Make `operation(started)` deterministic using `stateRevision`, `ts`, and `seq`, exactly as abort now does:

- `stateRevision = previous.stateRevision + 1`;
- `updatedAt = canonical `toISOString()` conversion of `started.ts`;
- copy every other continuation field;
- set boundary to:

```ts
{
  status: "in_flight",
  lastSettledOperationId: previous.boundary.lastSettledOperationId,
  interruptedOperationId: started.operationId,
  cause: "operation_started",
}
```

- set `coveredSequence = started.seq`;
- recompute the digest.

The envelope rule becomes: `ts` is state-authoritative only for deterministic `started` and `aborted` reduction.

This makes registry-newer in-flight validation reproducible without another schema.

## 3. Receipt reuse: use `creationId` as the incarnation

The review is right. Globally unique operation IDs would merely turn a structural issue into a caller convention.

We already have the appropriate identity: `creationId`. Store it as the logical incarnation ID:

```ts
interface AgentSessionRecord {
  incarnationId: string; // creationId for newly created sessions
  // ...
}

interface MaintenanceCompletionReceipt {
  agentSessionId: string;
  incarnationId: string;
  // ...
}
```

All maintenance checks are scoped by:

```text
agentSessionId + incarnationId + operationId
```

Rules:

- A newly created incarnation must use a fresh `creationId`.
- Existing-session maintenance gets the incarnation from the registry record.
- Migration generates and persists a fresh incarnation ID.
- Hard deletion may retain receipts for the deleted incarnation.
- Reusing the logical ID creates a new incarnation and cannot match old receipts.

This adds one field, not a new lifecycle abstraction.

## 4. Unstaged provider outcome: accept a fixed V0 policy

I would avoid another configurable policy.

Use this concrete rule:

> An identical, explicit retry of a prepared creation/restoration with no staged continuation is authorization to repeat the provider-thread creation step.

Consequences:

- The library never retries it automatically during manager opening, listing, or unrelated loading.
- The retry may leave one unknown orphan provider thread.
- The new staged continuation records that an unstaged prior attempt may have completed.
- The library emits this uncertainty through the returned opening report/notification.
- Once `stagedContinuation` exists, no subsequent retry may create another thread or rerun the continuation builder.

This is a reasonable V0 limitation. A configurable fail/retry/reconcile policy can be deferred until adapters can provide stronger creation idempotency.

## Security and smaller fixes

All should be accepted:

- Direct marker filename becomes something like:

  ```text
  maintenance/<sha256(JCS([agentSessionId, creationId]))>.json
  ```

  Actual IDs remain inside the owner-only marker.

- Cursor view/filter invalidation applies only to navigation cursors.
- `getSessionMaintenance()` promises persisted recovery state, not the complete original request.
- Tombstone replacement requires an explicit `path`. The consumer may deliberately reuse the former path, but it receives a new log ID at generation 1.
- Add the history/reducer definitions and in-flight reconstruction tests.

## What to defer

Document these explicitly:

- History side indexes or periodic history materialization.
- Adapter-aware reconciliation of possibly orphaned provider threads.
- Configurable unstaged-provider retry policy.
- Complete executable retry descriptors.
- Automatic cleanup of provider-side orphan sessions.

So I would accept the review, but treat blocker 4 as a fixed, documented V0 retry rule rather than adding another policy API. The resulting implementation model remains manageable.




# review pass

I’ll inspect the newest revision against those four blockers first, then do another cross-section pass for any regressions introduced by the fixes.The previous four issues are now explicitly repaired. Two new cross-section problems remain in the transaction/reducer contracts: the history-fold API currently double-counts its own tail, and incarnation-scoped receipts cannot be addressed by the store API after a hard deletion. I’m validating the CAS behavior as well, because it affects deletion and reconfiguration under registry-only races.This revision fixes all issues from the previous pass. I still see three real blockers, primarily around incarnation safety and the history reducer.

## Blockers

1. Stable-ID reuse still has an ABA problem at the public API

Receipts are correctly scoped by `incarnationId` ([spec:889](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:889)), but consumers cannot supply or inspect that incarnation:

- `AgentSessionSummary` omits it ([spec:1463](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1463)).
- `deleteAgentSession()` accepts only the logical ID, deletion ID, and record revision ([spec:2985](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:2985)).
- `finalizeMaintenance()` also lacks it ([spec:1344](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1344)).

A dangerous sequence is therefore possible:

1. Incarnation A is hard-deleted.
2. The same `agentSessionId` is recreated as incarnation B.
3. A delayed retry of A’s deletion arrives.
4. Its `expectedRecordRevision` happens to equal B’s revision.
5. The manager associates the request with the current incarnation and deletes B.

The internal receipt tuple does not protect against this because the caller has not identified which incarnation it intended.

Expose `incarnationId` in summaries/results and require `expectedIncarnationId` on every existing-session mutation. Store finalization and receipt lookup must also receive it explicitly. This is the proper ABA token; `recordRevision` alone resets with reuse and is insufficient.

2. Prepared maintenance does not clearly fence ordinary record publication

`prepareMaintenance()` verifies the record revision ([spec:1362](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1362)), but the prepared record does not retain that base revision except for restoration. `finalizeMaintenance()` has no expected revision parameter.

That conflicts with the explicit registry-only race claim that CAS prevents resurrection ([spec:3074](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:3074)). A live registry-only session could publish a checkpoint after deletion/reconfiguration is prepared but before it finalizes. Nothing currently says that `saveAgentSessionRecord()` must reject writes while maintenance exists, and finalization cannot verify that the record remained unchanged.

Add a common field:

```ts
baseRecordRevision: number | null;
```

Then require both:

- ordinary record saves atomically reject an active maintenance reservation;
- finalization verifies the current incarnation and base record revision before applying its mutation.

This should be part of the `AgentSessionStore` contract, not merely default-store behavior.

3. The new history-fold API disagrees with its own prose

The API takes `activationsThroughSnapshot` and returns history through the entire snapshot ([spec:1188](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1188)). But `reduceTranscriptState()` expects `historyThroughCheckpoint` and then folds post-checkpoint transition activations itself ([spec:1192](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1192), [spec:1210](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:1210)).

Passing the declared history result into the declared state reducer would double-apply post-checkpoint activations.

Make the boundary explicit:

```ts
reduceTranscriptHistory(
  activationsThroughCheckpoint: Iterable<TranscriptTransitionRecord>,
): TranscriptHistoryReduction;
```

Then pass only records after `checkpoint.transcript.coveredSequence` to the state reducer.

There is also a related direct contradiction: history revision is defined as `entries.length`, and `historyEntry` is absent when `from.internalSessionId` is null, but transition rule 3 unconditionally says every activation appends an entry and increments the revision ([spec:2284](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:2284), [spec:2290](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-5+/9-6-SPEC-persistence-transcripts.md:2290)). The append/increment must be conditional on `historyEntry` being present.

Everything else from the last review is now coherently fixed: deterministic started/aborted reduction, safe marker naming, explicit orphan-producing retry behavior, incarnation-scoped receipts, cursor distinction, explicit tombstone replacement paths, and maintenance-inspection wording. After the three issues above, I would consider the architecture substantially implementation-ready.




---




All three are real correctness issues. I would fix them now; none requires another subsystem or conceptual abstraction.

## 1. Use `incarnationId` as the public ABA token

The reviewer is right: an internal incarnation field provides no protection if a delayed caller cannot identify its intended incarnation.

Expose it consistently:

```ts
interface AgentSessionSummary {
  agentSessionId: string;
  incarnationId: string;
  recordRevision: number;
  // ...
}

class AgentSession {
  readonly agentSessionId: string;
  readonly incarnationId: string;
}
```

Every mutation targeting an existing managed session must require:

```ts
expectedIncarnationId: string;
expectedRecordRevision: number;
```

That includes at least:

- `deleteAgentSession()`;
- `restoreAgentSession()`;
- `reconfigureAgentSessionPersistence()`;
- future offline metadata/maintenance mutations.

Ordinary live checkpoint publication already knows its incarnation from the `AgentSession` object and must include it in its CAS.

Store finalization becomes:

```ts
finalizeMaintenance(
  agentSessionId: string,
  expectedIncarnationId: string,
  operationId: string,
  requestDigest: string,
  mutation: ...
): Promise<void>;
```

A delayed mutation for incarnation A can then find A’s receipt or fail safely, but can never be interpreted as a mutation against incarnation B.

This is not really API expansion—it exposes the ABA token the design already depends upon.

## 2. Maintenance must fence ordinary record writes

Also valid. Add one common field to every maintenance transaction:

```ts
baseRecordRevision: number | null;
```

Rules:

- Creation uses `null` and requires no session record to exist.
- Reconfiguration, restoration, and deletion use the exact current revision.
- `prepareMaintenance()` atomically validates incarnation and base revision.
- `saveAgentSessionRecord()` rejects when active maintenance exists for that logical ID/incarnation.
- `finalizeMaintenance()` verifies:

  ```text
  active maintenance identity
  + incarnation
  + operation ID
  + request digest
  + unchanged base record revision
  ```

- Only `finalizeMaintenance()` may mutate the record while the reservation exists.

Remove restoration’s separate `priorRecordRevision`; the common field replaces it.

This makes the existing “CAS prevents resurrection” claim true for custom stores as well as the default JSON implementation.

## 3. Correct the history-fold boundary

This is primarily a naming/contract correction:

```ts
reduceTranscriptHistory(
  activationsThroughCheckpoint: Iterable<TranscriptTransitionRecord>,
): TranscriptHistoryReduction;

reduceTranscriptState(
  checkpoint: AgentSessionCheckpoint,
  historyThroughCheckpoint: TranscriptHistoryReduction,
  structuralTailAfterCheckpoint: readonly TranscriptStructuralRecord[],
): TranscriptReductionResult;
```

The state reducer folds only records whose sequence is greater than `checkpoint.transcript.coveredSequence`.

And transition reduction becomes conditional:

```text
if target_activated.historyEntry is present:
  append entry
  revision += 1
  recompute digest

otherwise:
  change current routing only
  leave history entries/revision/digest unchanged
```

That correctly handles transitions from a null/degraded internal identity.

These should not be deferred. They are small changes that make the already-chosen architecture enforceable:

- one existing identity becomes public;
- one common CAS field is added;
- one fold parameter is renamed;
- one unconditional sentence becomes conditional.

After these corrections, I agree with the review: the persistence architecture should be considered implementation-ready rather than continuing another design-expansion cycle.