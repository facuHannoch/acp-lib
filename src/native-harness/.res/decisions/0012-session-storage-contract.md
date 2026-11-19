# Session storage contract, revision 1

## Problem and options

Persisting only `SharedContextStore` would retain messages while resetting turn
IDs, channel status and knowledge of unfinished work. Options are to extend that
context-only interface, expose general database transactions to the kernel, or
introduce a session-storage contract with atomic domain operations.

## Choice

Add the type-only `contracts/storage.ts` for history restoration. A single owner
opens one session, explicitly creating or reopening it. Storage atomically accepts
input, allocates IDs, records execution and returns neutral snapshots. Expected
failures are typed results; synchronous operations preserve the scheduler's local
admission boundaries. No transaction spans inference or tool execution.

Open checks format/configuration compatibility and exclusive ownership. Reopen
marks leftover queued/running turns interrupted atomically. Failure and
interruption are terminal outcomes for a turn. The channel remains available
for new work even if an input went unanswered. Nothing executes on open.
Configuration identity is an explicit
caller-supplied compatibility key, not inferred from tool names or credentials.

Suspend/resume requires a subsequent contract revision for durable notices,
deduplication, lifecycle transitions and checkpoints. Keep input and turn identity
explicit now so that revision can preserve queued work from clean suspension.
Revision 1 must not claim durable inboxes or resumable shutdown.

## Compatibility and verification

This is an additive, unconnected contract. Existing session/store APIs, kernel,
protocol and behavior remain unchanged. Adapter implementations and runtime wiring
follow in a separately approved increment. Both memory and SQLite adapters must
pass the conformance checklist in the persistence document before integration.
This increment verifies type correctness and dependency boundaries only; no
storage behavior is claimed without an implementation.
