# Agent sessions and conversations

Status: accepted foundation for the September refactor. The identity, discovery,
messaging, and tool protocols remain intentionally incomplete until the current
conversation implementation has been separated into smaller components.

## Why this change exists

The current `AgentSession` is one durable conversation backed by one active
`AgentController`. That was the right front face when the library only needed to
represent one conversation at a time. It is not the right ownership boundary for
an agent that has a persistent identity and many independent conversations.

The target hierarchy is:

```text
AgentSession (ags-...)
  identity
  persistence/backend
  default tools
  conversations
    AgentConversation (agc-...)
      participants
      transcript
      provider-thread history
      AgentController (when connected)
```

`AgentSession` is the library-owned agent entity. `AgentConversation` is one
locally observed conversation belonging to that entity. `AgentController` is the
ephemeral harness control plane used to run a conversation.

## Stable identifiers

- `agentSessionId` uses the `ags-` namespace and identifies the agent-level
  entity. It never changes during that entity's lifetime.
- `agentConversationId` uses the `agc-` namespace and identifies exactly one
  conversation owned by one agent session. It never changes during that
  conversation's lifetime.
- `internalSessionId` is the provider/harness thread identifier. It can be absent
  or change when a conversation is reconstructed, handed off, or changes mode.
- A participant identifier identifies continuity and prevents name collisions.
  It is not authentication and must not be described as proof of identity.

The existing `ags-` identifier currently attached to a conversation is preserved
during migration. A legacy record maps to one agent-level `AgentSession` with one
generated `agc-` conversation. Migration must not silently reinterpret an
existing public identifier as a provider thread identifier.

## Ownership and invariants

### AgentSession

The eventual agent-level object owns:

- its stable `ags-` identity;
- the configured persistence/backend location;
- the opaque identity provider or identity state boundary;
- default tools and capabilities made available to conversations;
- creation, lookup, listing, and lifecycle of its conversations.

It does not own a single privileged or "main" conversation. A consumer may store
an alias or default selection, but the core model treats every conversation the
same way. This permits several users, agents, services, or task-specific threads
to talk to the same agent.

### AgentConversation

The conversation object owns the behavior currently concentrated in
`AgentSession`:

- serialized mutation/prompt execution;
- participants and local speaker attribution;
- canonical locally observed messages and presentation records;
- provider-thread continuation and reconstruction;
- configuration, mode changes, handoff, recovery, and metering;
- the active `AgentController`, when connected.

A conversation must be reconstructable from its own store for inspection by a
user. Reconstruction here means rebuilding the recorded chat and operational
history; it does not require replaying the full transcript into a model context.

### AgentController

The controller remains an ephemeral, single-harness control plane. It speaks ACP
or the degraded transport, exposes live capabilities, and executes operations. It
does not own agent identity, the conversation catalog, discovery, or durable
cross-conversation state.

## Independent local histories

Communication between agents does not create a replicated conversation managed
by this library.

If Bob sends Atlas a message, Bob may record what Bob observed in one of Bob's
conversations. Independently, Atlas may receive that message, resolve Atlas's
identity, and record what Atlas observed in one of Atlas's conversations. Those
records can contain naturally redundant knowledge, as two people remember the
same exchange, but they are not transactionally mirrored copies.

The library therefore does not require:

- a shared sequence number between the two agents;
- an atomic write spanning their stores;
- delivery acknowledgement to make either local record valid;
- matching transcripts or even a record on both sides;
- a hard relationship between the two local conversations.

Optional message, correlation, sender, receiver, or channel identifiers may make
relationships discoverable from the data later. They must not turn independent
histories into forced replication.

## Identity boundary

Identity belongs to `AgentSession` and can affect every conversation. Its
representation is opaque to the conversation layer: it might be text, a RAG
system, an external service, or another implementation supplied by the consumer.

The initial boundary will support resolving an identity snapshot before an
operation and, later, observing a settled interaction. The library will not
prescribe facts, memories, embeddings, or merge semantics.

Concurrent conversations introduce an identity race. The baseline rule is:

- resolve a snapshot for an operation;
- do not hold a database lock during a harness/model call;
- let the identity provider define serialization, compare-and-set, append-only
  observations, or other reconciliation semantics.

## Persistence boundary

The persistence location remains explicitly configurable. Repository-local,
mounted, container-local, and non-home locations are first-class uses.

The intended local topology is one database per `AgentSession`. This makes an
agent portable and isolated while allowing its conversations to scale and be
queried independently. SQLite is the intended primary online backend; JSONL
remains a compatibility/export/archive mode. PostgreSQL is deferred until a
central multi-host hub needs shared remote coordination.

The storage contract must represent messages and conversations directly. A
generic append-only event journal may exist underneath, but public retrieval must
not force consumers to guess which vague "events" form a chat.

Transcript storage and audit storage remain separate policies. Audit output can
have a separate destination and rotation policy. A readable timestamped text log
may be useful operationally, but it is not a better canonical data format than
structured records and is not automatically tamper-evident.

## Managers

The target has two scopes rather than two unrelated objects both called
`SessionManager`:

- an agent-session manager manages top-level agents, their configured stores,
  and optional local discovery;
- an agent-conversation manager, scoped to one agent, creates, opens, lists, and
  removes conversations.

Existing handoff and switching operations act on a conversation. Cross-agent
messaging is a later capability and is not another meaning of handoff.

## Deferred design

The following are deliberately reserved but not specified by this document:

- identity snapshot and observation interfaces;
- participant record shape beyond stable ID, kind, and optional display name;
- consumer-provided versus library-provided discovery composition;
- incoming-message conversation selection;
- direct API, native harness tool, and MCP adapters for messaging;
- authentication and authorization hooks owned by a consumer;
- group conversations and task/channel routing;
- SQLite schema and audit delivery mechanism.

These decisions will be made after the current conversation implementation is
factored into explicit contracts and runtimes. The refactor must leave extension
points for them without fabricating their semantics now.

## Refactor sequence and compatibility

The initial sequence is behavior-preserving:

1. Record this model and its invariants.
2. Introduce vocabulary and stable identifier primitives (`ags`, `agc`, internal
   provider session) without changing runtime ownership.
3. Extract conversation contracts and errors from the current monolith.
4. Extract the serialized operation queue.
5. Extract presentation/activity persistence coordination.
6. Extract continuation/opening coordination.
7. Verify the extracted boundaries, then define the actual top-level
   `AgentSession` API and migration in more detail before implementing it.

Until the new container exists, the exported class named `AgentSession` remains
the compatibility front face for the current durable conversation. New internal
names and documentation may call that role `AgentConversation`, but the public
export is not silently repurposed. Renaming and introducing the new owner require
an explicit compatibility release plan.

