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


