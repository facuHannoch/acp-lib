# Persistence durability decision

Status: v0 decision; weaker mode deferred
Date: 2026-09-06

## Concern

A successful filesystem append does not necessarily mean bytes have reached durable
storage. They may remain in the runtime or operating-system cache. If power is lost after
the harness receives a prompt but before the operation-start record reaches storage, the
library can reopen at an apparently clean checkpoint even though the harness advanced.

This is different from an ordinary caught exception: after sudden power loss there is no
opportunity to append a final recovery checkpoint.

## V0 decision

V0 will not expose `durability: "synchronous" | "buffered"`.

- Direct `AgentSession` use with persistence disabled makes no persistence or crash-
  recovery guarantee.
- Managed persistence requires durable operation boundaries.
- A custom persistence store must satisfy the same durable-commit contract if it claims
  compatibility with managed restoration.

This keeps one recovery contract: if provider work may have been dispatched, durable
state must show an operation-start or in-flight boundary.

## Durable operation architecture

Before provider work:

```text
append operation(started)
→ append captured input records
→ synchronize the authoritative continuation store
→ dispatch to the harness
```

After provider work:

```text
append response/activity records
→ append terminal operation record
→ append settled checkpoint
→ synchronize the authoritative continuation store
→ expose the durably persisted result
```

For the normal managed configuration, the transcript is the continuation journal. Its
small append is synchronized before dispatch; the central registry is a discovery/index
projection and does not need a complete pre-dispatch rewrite for every prompt.

When transcripts are disabled, the registry is the continuation authority. Registry-only
mode must durably publish an in-flight checkpoint before dispatch and therefore has a
higher write cost. That cost is an explicit consequence of requesting power-loss-safe
restoration without an append-only transcript.

Filesystem synchronization means using the strongest appropriate file and directory
sync primitives available on the platform, not merely awaiting `appendFile()` or
`writeFile()`. It cannot protect against broken hardware, dishonest storage caches, or
loss of the entire storage device; it establishes the strongest practical local boundary
the library can request.

## Deferred buffered proposal

A future performance-oriented mode could dispatch after preserving write order but
without synchronizing every boundary:

```ts
durability: "buffered";
```

That mode would reduce latency but could lose recent operation markers during sudden
power loss. Consequently, an apparently clean checkpoint would not prove that the
harness did not advance. It would require a distinct checkpoint provenance/guarantee,
different recovery messaging, and separate tests.

The mode is deferred until real measurements show that transcript synchronization is a
material cost relative to harness/model latency. It must not be introduced as a silent
optimization or described as equivalent managed recovery.

## Rationale

The library's managed value comes from preserving a stable logical `AgentSession` across
internal-session changes and process restarts. A default mode which can silently lose the
only evidence of an in-flight provider operation weakens that promise at its most
important failure boundary.

Two small transcript synchronizations per typically long-running model operation are
expected to be cheaper than the complexity and ambiguity of shipping two durability
grades immediately. The implementation should measure this assumption; a weaker mode can
be added later with an honest contract if evidence justifies it.

