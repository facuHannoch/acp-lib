# AgentSession / AgentConversation boundary checkpoint

Status: design checkpoint after refactor steps 1–6. This document defines the
next implementation boundary; it does not yet define identity memory semantics,
discovery, incoming-message routing, or tool transports.

## What the refactor established

The current class called `AgentSession` is demonstrably a conversation runtime.
Its extracted components are now named accordingly:

```text
current AgentSession compatibility class
  AgentConversationQueue
  AgentConversationPresentation
  conversation continuation policy
  conversation contracts and errors
  AgentController
```

The remaining class still coordinates controller lifecycle, persistence
transactions, configuration, recovery, mode changes, handoff, and metering. Those
are all conversation concerns. None of them needs to become agent-wide state.

The top-level agent owner should therefore be introduced around this runtime,
not by stretching this runtime to contain other copies of itself.

## Target public objects

### AgentSession

An `AgentSession` is a durable local agent identity and the owner of a collection
of conversations.

```ts
interface AgentSession {
  readonly id: AgentSessionId; // ags-...
  readonly conversations: AgentConversationManager;

  // Identity is intentionally opaque at this stage.
  resolveIdentity(context: IdentityResolutionContext): Promise<IdentitySnapshot>;

  close(): Promise<void>;
}
```

Construction must require an explicit storage choice. A default may exist only
when its resolved path is visible to the caller; callers can always provide an
exact file path or a backend implementation.

```ts
type AgentStorageConfig =
  | { kind: "sqlite"; path: string }
  | { kind: "jsonl"; root: string }
  | { kind: "custom"; backend: AgentStore };

interface AgentSessionConfig {
  id?: AgentSessionId;
  storage: AgentStorageConfig;
  identity?: IdentityProvider;
  conversationDefaults?: AgentConversationDefaults;
  tools?: ToolRegistry;
  audit?: AuditSinkConfig;
}
```

The exact `IdentityProvider`, `ToolRegistry`, and `AuditSinkConfig` shapes remain
deferred. Their ownership is established here so they are not accidentally put
on one conversation.

### AgentConversation

`AgentConversation` is the renamed and evolved form of the current class.

```ts
interface AgentConversation extends AgentClient, Bridgeable {
  readonly id: AgentConversationId; // agc-...
  readonly ownerId: AgentSessionId;
  readonly internalSessionId: string | null;
  readonly participants: readonly ParticipantRef[];

  prompt(input: string, options?: ConversationPromptOptions): Promise<AgentConversationPromptResult>;
  stop(): Promise<void>;
}
```

It owns its operation queue, transcript/presentation stream, provider-thread
history, active controller, mode, configuration, recovery, metering, and handoff.
It receives an identity snapshot before an operation but does not own or mutate
the identity representation directly.

`internalSessionId` remains provider-owned and replaceable. It is never a key for
the conversation catalog.

### AgentConversationManager

Each agent session exposes one manager scoped to that owner:

```ts
interface AgentConversationManager {
  create(config: CreateAgentConversationConfig): Promise<AgentConversation>;
  open(id: AgentConversationId, config?: OpenAgentConversationConfig): Promise<AgentConversationOpenResult>;
  get(id: AgentConversationId): Promise<AgentConversationSummary | null>;
  list(options?: ListAgentConversationsOptions): Promise<AgentConversationPage>;
  delete(id: AgentConversationId, options?: DeleteAgentConversationOptions): Promise<void>;
}
```

The manager is the only default route for creating a conversation under an agent;
this makes ownership and storage placement unavoidable. A lower-level detached
conversation constructor may remain for compatibility/testing, but it must not
pretend to participate in agent identity.

### AgentSessionManager

An optional higher-level manager can list/open several agent databases or use a
consumer-provided directory. It manages agents, not provider sessions and not the
operations within one conversation.

```ts
interface AgentSessionManager {
  create(config: CreateAgentSessionConfig): Promise<AgentSession>;
  open(id: AgentSessionId): Promise<AgentSession>;
  get(id: AgentSessionId): Promise<AgentSessionSummary | null>;
  list(options?: ListAgentSessionsOptions): Promise<AgentSessionPage>;
}
```

It is not mandatory for a consumer that already knows the database path for one
agent. Library-managed and consumer-managed discovery can later implement the
same directory contract.

## Participant and prompt boundary

The minimum participant reference is:

```ts
interface ParticipantRef {
  readonly id: string;
  readonly kind: "agent" | "user" | "service" | "external";
  readonly name?: string;
}
```

The ID provides continuity and collision resistance. It is not a credential or
proof that the caller is entitled to speak as that participant. Consumers may add
an authentication/authorization hook later.

An agent managed by this library normally uses its `ags-` value as its participant
ID. Users and external systems can supply stable IDs or request library-minted
ones. Not every participant must be routable.

The eventual prompt boundary must accept speaker metadata independently of the
provider protocol role. ACP may still receive the input as a `user` prompt while
the canonical conversation records Atlas, Bob, user-42, or another participant as
the author.

## Storage contract before schema

The backend-neutral contract must expose domain operations rather than only a
generic event stream:

```ts
interface AgentStore {
  conversations: ConversationStore;
  messages: MessageStore;
  checkpoints: ConversationCheckpointStore;
  providerSessions: ProviderSessionStore;
  auditOutbox?: AuditOutboxStore;
  transaction<T>(work: (tx: AgentStoreTransaction) => Promise<T>): Promise<T>;
}
```

An implementation may maintain a canonical append-only journal internally, but
consumers must be able to retrieve messages and reconstruct a chat without
reverse-engineering event types.

The first SQLite backend is one database per agent. It should use WAL mode, a
bounded busy timeout, schema migrations, indexed `(conversation_id, sequence)`
message retrieval, and short transactions. No database transaction remains open
during a harness/model call. Large immutable payloads can move to hashed blobs
without changing message ordering.

JSONL stays as a backend/export/archive option. Audit remains a separate sink and
can use independent rotation and retention. A database transaction plus outbox is
the intended bridge between canonical state and a separate audit destination.

## Concurrency invariants

- Operations in one `AgentConversation` are serialized by its queue.
- Different conversations under the same agent may run concurrently.
- Multiple processes may use different agent databases without coordination.
- Multiple processes writing the same SQLite agent database rely on SQLite WAL,
  transactions, busy handling, and uniqueness constraints—not in-memory locks.
- Find-or-create routing for an incoming participant/channel must eventually use
  a unique constraint or transactional upsert.
- Identity resolution returns an operation snapshot. Identity merge/update policy
  belongs to the supplied identity provider and occurs outside long model calls.
- Network filesystems with unreliable SQLite locking are not silently supported;
  a remote database backend is the later multi-host option.

## Compatibility and migration

The current public name `AgentSession` means one conversation. The target public
name means the agent-level container. Reusing that name in place would compile
some consumer code while changing its meaning, which is worse than an explicit
breaking transition.

The migration therefore has three deliberate stages:

1. Internally rename the current implementation to `AgentConversation` and keep
   the existing `AgentSession` export as an explicitly deprecated compatibility
   alias/facade with its old constructors and behavior.
2. Introduce the new top-level owner under an unambiguous preview name or subpath
   while its API is validated. Do not expose two different meanings under the same
   import.
3. In the next major release, make `AgentSession` the owner, make
   `AgentConversation` the conversation, and move the old facade to a named legacy
   export with migration instructions.

Persisted legacy data maps as follows:

- one old logical session becomes one new agent plus one conversation;
- when the old ID is already a valid `ags-...`, it remains the new agent ID;
- otherwise migration mints an `ags-...` and stores the old ID as a lookup alias;
- migration always mints an `agc-...` for the contained conversation;
- existing transcript/audit artifacts, provider thread IDs, checkpoints, and
  paths are retained and referenced rather than rewritten merely for naming;
- opening by a retained legacy ID resolves through the migration alias;
- migration is idempotent and records its version/result transactionally.

This preserves the property the user relies on: an existing `ags-...` identity
does not change. It also avoids pretending arbitrary historical test/application
IDs already satisfy the new namespace.

## What is intentionally not implemented next

Before steps 8–12, the following need a focused design pass informed by this
boundary:

- identity provider snapshot/observation/version semantics;
- participant aliases, groups, and conversation selection rules;
- local and consumer-provided discovery composition;
- cross-agent messaging service and failure semantics;
- direct TypeScript, native harness-tool, and MCP adapters;
- caller authentication/authorization integration;
- the exact SQLite schema, blob threshold, and audit outbox protocol.

The refactor has made room for those features without choosing their semantics.
The next implementation tranche should begin only after these contracts—especially
identity concurrency and incoming-conversation selection—are reviewed.

