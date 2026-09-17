# Agent persistence, search, and identity

Status: accepted design for implementation steps 8–12.

This document extends `ARCHITECTURE-agent-conversations.md` and
`SPEC-agent-session-conversation-boundary.md`. It fixes the contracts required to
introduce an agent-level owner and SQLite persistence without attempting to define
agent discovery, inter-agent delivery, group conversations, or a particular memory
model.

## Public ownership model

The public hierarchy introduced by this tranche is:

```text
Agent (ags-...)
  persistence
  identity
  adapter registry
  default tools
  conversations
    AgentConversation (agc-...)
      participants
      ordered records and messages
      provider-thread history
      AgentController (while connected)
```

`Agent` is the new owner name. The existing public `AgentSession` continues to mean
one conversation during the compatibility period and becomes a deprecated facade for
`AgentConversation`. This avoids silently changing the meaning of existing consumer
code. `AgentSessionId` and the `ags-` namespace remain the stable agent identity;
`AgentConversationId` and `agc-` identify a conversation.

An agent has no privileged main conversation. A consumer may remember a preferred
conversation, but that is not a persistence invariant.

## Participants and attribution

The initial participant kinds are deliberately small:

```ts
interface ParticipantRef {
  readonly id: string;
  readonly kind: "agent" | "user" | "external";
  readonly name?: string;
}
```

Names may change without affecting continuity. A participant ID prevents accidental
collisions; it is not authentication or proof that a caller is entitled to speak for
that participant. Missing caller identity maps to one reserved implicit user for the
conversation. Supplying a previously unseen ID creates that local participant
implicitly.

The owning agent is implied by `conversation.agentSessionId` and is not required to
appear as another participant row. Initial conversations are one local agent plus one
or more other participants. Group-chat routing semantics remain deferred.

## Canonical records

Persistence exposes typed domain records rather than a vague public event stream. Every
record has a stable envelope:

```ts
interface ConversationRecordEnvelope {
  readonly recordId: string;
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId: AgentConversationId;
  readonly sequence: number;
  readonly kind: ConversationRecordKind;
  readonly timestamp: string;
  readonly metadata?: string;
}
```

`metadata` is an opaque consumer string. JSON may be stored in it, but the library does
not parse or assign semantics to it.

The initial kinds are:

- message;
- tool call and its state transitions;
- permission request and resolution;
- configuration change;
- normalized or raw ACP protocol record;
- conversation-native action such as handoff, switch, or mode change;
- thinking/reasoning block;
- activity such as file or terminal work;
- future agent-initiated action.

Message boundaries are canonical. Separate provider messages remain separate; the
library never joins several messages merely to simplify storage or presentation. A
shared record envelope and type-specific payloads allow new record kinds without
changing existing message tables.

Mutable protocol lifecycles may be exposed as one current projection, but their durable
history remains reconstructable. For example, a tool call can have announced, input,
completed, and failed observations while the query API also exposes its latest state.

Markers, bookmarks, branches, evaluations, and annotations are deferred. Stable record
IDs and ordered conversation sequence numbers make them additive later: a marker can
reference a record or sequence range without inserting into or renumbering history.

## Capture and retrieval

Capture policy and retrieval are independent. Capture policy decides what is written;
query options decide which already-written records are returned. Each supported record
kind has an explicit capture level. Raw ACP traffic and thinking remain opt-in unless a
preset explicitly enables them.

The persistence API reconstructs a chat through message operations and reconstructs a
complete operational timeline through record operations. Consumers do not need to
interpret private reducer events to display a conversation.

## Persistence topology

The default online topology is one SQLite database per agent at a caller-selected path.
The library never requires a home-directory location. The path may be repository-local,
mounted, container-local, or supplied through existing command/environment resolution.

The backend-neutral name is `PersistenceBackend`. Its API is domain-oriented:

```ts
interface PersistenceBackend {
  readonly capabilities: PersistenceCapabilities;
  readonly conversations: ConversationPersistence;
  readonly records: ConversationRecordPersistence;
  readonly checkpoints: ConversationCheckpointPersistence;
  readonly providerSessions: ProviderSessionPersistence;
  readonly identity?: IdentityPersistence;
  readonly search?: SearchPersistence;
  readonly auditOutbox?: AuditOutboxPersistence;

  transaction<T>(work: (tx: PersistenceTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

SQLite uses schema migrations, WAL, a bounded busy timeout, short transactions, and
database uniqueness constraints. No transaction remains open during a harness or model
call. The supported SQLite runtime must contain the current multi-connection WAL fixes.

JSONL remains supported as:

- the existing compatibility format;
- a per-conversation backend where each conversation has its own path;
- export/archive output.

New multi-conversation JSONL storage must not put every conversation behind one append
lock. Existing JSONL files load as one agent with one generated conversation. An absent
user ID maps to the reserved implicit user at read time; migration does not need to
rewrite the original file.

## Search

SQLite search uses an FTS5 virtual table, not an extra ordinary column. Canonical text
remains in the record/type tables or a database view; an external-content FTS5 table
stores the full-text index and joins through a private numeric row ID. Canonical public
IDs remain strings.

Each record kind owns its searchable-text projection. Messages, tool names and selected
input/output, configuration commands, native actions, activities, and captured thinking
may be indexed. Raw ACP records are excluded by default. Search can be scoped by agent,
conversation, participant, record kind, and time.

FTS maintenance occurs in the same transaction as canonical writes. The backend exposes
capability detection, rebuild, and integrity checking. Search remains unavailable rather
than silently falling back to an unbounded scan when FTS5 is absent.

Vector retrieval is a separate optional `VectorIndex` capability. The default topology
allows embeddings and a vector index to live in the same agent database, keyed to the
same memory or record IDs. An external vector service remains possible through the same
interface. No vector implementation is selected in steps 8–12.

## Persistence extensions

Library-level persistence extensions may create namespaced tables and register versioned
migrations and commit hooks:

```ts
interface PersistenceExtension {
  readonly id: string;
  readonly version: number;
  migrate(context: PersistenceMigrationContext): Promise<void>;
  recordsCommitted?(records: readonly ConversationRecord[]): Promise<void>;
}
```

Installed versions are recorded in a persistence-extension catalog. A future RAG
extension may own documents, chunks, source references, embeddings, and vector indexes
inside the same SQLite file. Native SQLite loadable extensions are optional deployment
capabilities, never a requirement for opening an agent database.

## Identity runtime

Identity is agent-scoped and implemented as an append-only memory pool plus replaceable
derived snapshots. Conversations never compete to overwrite one identity blob.

```text
conversation commits
  -> immutable memory observations
  -> optional asynchronous consolidation
  -> versioned identity snapshot
```

Every memory keeps provenance: source conversation, source record, participant, time,
and kind. Contradictory observations coexist until an identity implementation reconciles
them; storage does not silently select a winner.

The agent exposes one always-invoked runtime:

```ts
interface AgentIdentityRuntime {
  load(input: IdentityLoadInput): Promise<LoadedIdentityContext>;
  update(input: IdentityUpdateInput): Promise<void>;
  synchronize?(input: IdentitySynchronizationInput): Promise<IdentityWatermark>;
}
```

`update` ingests committed record references. It does not replace the identity. `load`
returns a prompt-operation snapshot assembled from a derived identity, relevant memories,
and recent observations not yet consolidated. The default runtime is a no-op.

Memory and snapshots use monotonically increasing watermarks. Initial consistency modes
are:

- `eventual`: return the current snapshot plus relevant pending observations;
- `through-current`: capture the committed memory watermark and wait, with a timeout,
  until consolidation reaches it.

The runtime never waits for unknown future information or for active conversations whose
completion depends on identity loading. This prevents circular waits. No SQLite
transaction remains open while consolidation or a model call runs.

An `IdentityModelRunner` abstraction permits deterministic, consumer-provided,
API-backed, or harness-backed consolidation later. A harness-backed implementation uses
a separate internal controller/session and may reuse environment credentials, but it
does not reuse or recursively ingest the visible conversation thread.

## Handoff, switch, and reset

Handoff, provider switch, and context reset are one internal conversation transition.

- `handoff()` defaults the target adapter to the conversation's current adapter.
- `switch(targetAdapterId)` delegates to `handoff()` with an explicit target.
- `reset()` delegates to `handoff()` with no continuation context.

```ts
interface HandoffOptions {
  readonly target?: {
    readonly adapterId: string;
    readonly mode?: AgentMode;
    readonly config?: Readonly<Record<string, unknown>>;
  };
  readonly continuation?:
    | {
        readonly kind: "generated";
        readonly summaryInstructions?: PromptInput;
        readonly summaryPrompt?: PromptInput;
      }
    | { readonly kind: "provided"; readonly content: PromptInput }
    | { readonly kind: "none" };
  readonly targetPrompt?: PromptInput;
}
```

`summaryInstructions` augments the library's portable-summary prompt;
`summaryPrompt` replaces it completely, and they are mutually exclusive. The generated
summary prompt is the final internal prompt on the source thread. It is persisted as a
native transition operation, not attributed to a participant as a chat message.

`targetPrompt` is optional. When present it makes switch-and-continue atomic with respect
to the conversation queue and its result is included in the transition result. Without
it, the target is prepared and the next ordinary `prompt()` supplies the next task.

An explicit provided continuation replaces summary generation. `kind: "none"` preserves
the logical `agc-` conversation and visible history while starting a target with no prior
context. Creating a truly unrelated chat uses `agent.conversations.create()` instead.

Target adapter IDs resolve through the owning agent's adapter registry. A detached legacy
conversation must receive an explicit adapter definition when it cannot resolve the ID.
Every transition persists started, target-created, target-activated, completed, or failed
state so opening after a crash enters explicit recovery rather than guessing.

The existing `handoff({ summary: string })` remains a compatibility shorthand for a
provided continuation during the migration period.

## Audit

Audit remains an independently configured sink with its own capture policy, destination,
retention, and rotation. Canonical persistence never depends on a best-effort audit file
write. A durable audit mode commits an outbox item with canonical state, then delivers it
to the sink with idempotent IDs. A required synchronous mode may reject an operation only
when explicitly configured. Rotation closes one generation and opens another; it does
not alter conversation sequence or canonical records.

## Steps 8–12 boundary

1. Freeze this contract.
2. Establish `AgentConversation` as the actual conversation runtime while retaining the
   compatibility `AgentSession` facade.
3. Add backend-neutral persistence contracts and record models.
4. Implement the SQLite backend, migrations, concurrency policy, and FTS5 search.
5. Add `Agent`, its conversation manager, adapter registry, and the always-invoked
   identity lifecycle.

Cross-agent discovery/delivery, native or MCP messaging tools, group routing, markers,
AI-backed consolidation, and a concrete vector engine remain subsequent tranches.
