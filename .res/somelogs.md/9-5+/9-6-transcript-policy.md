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