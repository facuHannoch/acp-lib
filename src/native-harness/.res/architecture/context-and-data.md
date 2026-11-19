# Context and data

Status: current implementation and intended separation, 2026-11-16.

## Three responsibilities

| Responsibility | Meaning | Current implementation |
| --- | --- | --- |
| Storage | Own recorded information and its ordering | `SharedContextStore`, implemented in `src/state/storage/shared-context.ts` |
| Queries | Select stored information without rendering it | Currently only the store's complete `snapshot()`; no separate query service |
| Context building | Present selected information to the model | Pure functions in `src/capabilities/context/build.ts` |

Keep these responsibilities distinct without creating a module for each before
it is useful. A SQLite adapter may implement both writes and typed read queries;
the builder receives neutral data and never SQL or a database handle. Later,
history tools and the inspector can use queries without reusing prompt rendering.

## Recorded experience

Each `ContextEntry` carries a global sequence number, timestamp, channel, turn,
sender, optional input/notice kind and source channel, and a neutral message.
Messages contain participant text, assistant text/tool calls, or tool results.
The current store deep-copies appended values and snapshots and notifies local
subscribers after append.

System instructions and tool definitions are supplied configuration, not history
entries. Execution status, queued work and protocol acceptance records are not
fully represented by the context log either. Conversation history alone cannot
reconstruct a scheduler reliably.

## What an inference receives

`buildSharedContext` produces the system prompt and attributed shared history as
JSON text. It excludes opaque provider state from that shared rendering.

`buildContext` adds current channel and participant/notice origin, removes the
active turn from the shared-history section, then appends that turn's messages
in native conversation form. This preserves local assistant/tool pairing and
avoids duplicating the active input. Tool definitions are a separate model-call
argument; the provider adapter decides their wire representation.

There is one shared record of experience and a fresh view for every inference.
There is no single mutable model-context buffer whose latest writer wins. Parallel
inferences can therefore see different snapshots of the same growing record.

The inspector's Live context is the channel-independent rendered base plus tool
definitions for inspection. It is not a provider's hidden token layout. Per-call
inspection includes the actual active-turn context and provider request.

## Limits and future changes

All history is currently included on every build. There are no budgets,
compaction, retrieval, durable facts, scoped history queries or confidentiality
filters. Persistent raw history comes first; memory selection can improve later.

Opaque provider state is kept with its originating response. A durable format
will need explicit serialization and provider compatibility rules; it must not
silently discard or reinterpret that data. Restored historical turns can remain
attributed data without attempting to resume their native provider exchanges.
