# Persistence proposal

Status: proposed, updated 2026-11-17. No SQLite implementation or new public contract has
been approved through this document. The implementation requires a contract
decision before dependent changes.

The first type-only contract is now defined in
[`src/contracts/storage.ts`](../../src/contracts/storage.ts), with rationale in
[decision 0012](../decisions/0012-session-storage-contract.md). It is not wired to
execution and has no adapter implementation yet. It covers participant-initiated
turns; durable notice admission, protocol deduplication and suspension remain
subsequent contract work. Integrating existing notice-driven execution must not
silently drop notices or pretend that this first interface handles them.

Revision 2 of the contract ([decision 0013](../decisions/0013-durable-delivery-contract.md))
replaces the revision 1 operations below with a durable inbox, take, lifecycle,
load and archive operations. Memory and SQLite adapters implement it, and the
scheduler, context builder and scripted stdio server run on it, including
suspend, resume and stop. Archive transfer is not exposed through an interface yet.

### Contract operations, revision 1 (superseded)

An adapter is configured with its location by assembly. `open` explicitly creates
or opens a session, validates its compatibility key and acquires exclusive ownership.
The returned handle exposes `acceptInput`, `startTurn`, `appendMessage`,
`finishTurn`, `snapshot` and `close`. Each mutation is synchronous and atomic.
Expected failures use a typed result, not database exception parsing.

`close` releases storage only. The caller must prevent further writes by live
execution; closing does not suspend or cancel it. Unfinished turns are preserved
and classified as interrupted on reopen. Schema migration and portable checkpoint
formats remain adapter/lifecycle work rather than implied capabilities.

### Required adapter conformance checks (revision 2)

These become shared executable checks when memory and SQLite adapters are added:

- Explicit create/open, session ID mismatch, unsupported format, ownership
  conflict, close/reopen and operations on closed handles. A different
  compatibility key opens normally and open never rewrites the stored key.
- Acceptance: the exact signature, `auto:<n>` allocation, identical retries
  returning the original item in every lifecycle state and after reopen,
  `item_conflict`, lifecycle admission, and no timeline or turn change.
- Atomic `beginTurn`/`takePending`/`finishTurn`: items taken once in acceptance
  order, the finish-time pending check, per-channel single live turn,
  independent channels, attribution and defensive copies.
- Monotonic turn IDs, seq and revision after reopen; timestamp-independent order.
- Assistant calls recorded before results, pairing validation, serialization
  failure without partial writes. `appendMessage`, `confirmReceipts` and
  `takePending` refuse a turn that is not running.
- Failed/interrupted turns keep history, items and receipts, list uncertain
  calls, and leave the channel usable. Nothing replays an uncertain call.
- Suspension: checkpoint only for turns needing inference, `completeSuspend`
  preconditions, `interruptActive` in each lifecycle state, and `resume`
  failing `incompatible` on a key mismatch while writing nothing.
- Reopen: `suspended` keeps checkpoints and pending items unchanged; any other
  lifecycle interrupts running and checkpointed turns in one transaction.
- Illegal transitions, export preconditions and failed imports leave no partial
  writes; an export/import round trip preserves IDs, deduplication and counters.
  SQLite-specific tests additionally cover real process death and ownership.

The contract does not itself constitute passing conformance; no adapter has been
verified against these requirements yet.

## Goal and scope

First make recorded conversations survive a restart and rebuild context from
them. Then make accepted pending work recoverable. Suspension at an iteration
boundary follows once those foundations exist.

The [suspend/resume design](suspend-and-resume.md) defines the lifecycle and
checkpoint requirements that the storage contract must accommodate from the
start, even before suspension is exposed as a working operation.

Use SQLite through `bun:sqlite`, one database for one session, with one owning
process. Keep independent channels concurrent while committing short synchronous
transactions. Never hold a transaction open during model calls or tools.
PostgreSQL and multiple servers sharing an identity are future possibilities,
not constraints on this increment. Promise queues and in-memory notifications
would need a different coordination mechanism for that deployment.

## Proposed durable information

The following is a conceptual schema, not final SQL:

| Record | Purpose | Increment |
| --- | --- | --- |
| Session metadata | Stable identity, schema version and monotonic ID allocation; lifecycle when suspension lands | History restoration, extended for suspension |
| Channels | Known channel identities | History restoration |
| Participants and channel membership | Identity attribution and observed associations | History restoration |
| Turns | Channel, input origin, queued/running/completed/failed/interrupted status; suspended checkpoint when supported | History restoration, extended for suspension |
| Conversation entries | Ordered neutral input, assistant calls/text and tool results | History restoration |
| Accepted inbox items | Original item ID/payload, delivery state and durable deduplication | Work recovery |
| Notices | Source/target, accepted payload and pending/consumed state | Work recovery |

Use stable session-scoped IDs and a database-assigned sequence for entries.
Sequence means committed recording order, not proof that concurrent model calls
saw one another. Timestamps are descriptive; ordering must not depend on clocks.
Turn IDs must not restart at one against an existing history.

Store structured neutral payloads in versioned JSON, with attribution and query
keys in typed columns. Preserve original payloads rather than persisting only
rendered prompt text. Validate serialization, including opaque provider data,
before committing; reject unsupported values rather than silently dropping them.
Do not persist tool implementation functions, credentials or process handles.

## Storage, queries and building

The persistence contract should expose the few atomic operations execution needs:
accept input and allocate its turn, record turn start/end, append model/tool
messages, and load session/channel metadata. Avoid exposing independent writes
that let a turn exist without its input or its channel.

Read operations return neutral records: initially the ordered history and startup
metadata. A complete history read is sufficient for the current builder; add
bounded history queries when there is a concrete caller. Context rendering stays
pure and retains its current behavior for the first persistence increment.

The in-memory implementation should support the same required semantics and
shared conformance tests. Assembly chooses the implementation. Kernel code must
not import SQLite, run SQL, or depend on SQLite-specific classes.

SQLite commits are the durable write boundary. Publish store notifications and
execution output only after the corresponding record commits. Notification
subscribers remain local; persistence is not automatically an event replay API.
Use foreign keys, transactions and versioned migrations. Choose and document
journal/synchronous settings and enforce single-process ownership before opening
execution. A second process must fail clearly rather than start a second scheduler.

## First increment: restore history, no automatic work recovery

On opening an existing database, restore the session, channels, participants and
ordered conversation history. Continue allocating new IDs without collision.
Rebuild the inspector's live context from that history immediately.

Until clean suspension is implemented, mark turns left queued or running by a prior process as interrupted; never silently
resume them or declare them completed. Keep their recorded input/output visible
as attributed history. A channel can accept new turns after a failure or
interruption, even if an earlier input went unanswered. Surface the failure or
interruption as a turn outcome.

This deliberately does not promise restart-safe delivery of every accepted
notice, durable protocol deduplication, or replay of output missed by clients.
Busy inbox notices are currently volatile; that remains an explicit limitation
until the second increment. Never advertise durable acceptance before that work.

Tools can change external state without their result reaching the database. Such
a tool has an unknown outcome after a crash. Do not automatically retry it or
invent a result. Persisting conversation history also does not persist a tool's
own state: the dashboard counter is a separate scenario concern.

The system prompt and tools are supplied again on open. Record enough configuration
identity/version metadata to make changes visible; do not reload stale credentials
or silently assume an old configuration is executable. Decide the minimal
compatibility check in the contract review.

## Second increment: durable acceptance and inboxes

Commit incoming item payloads, IDs and deduplication before acknowledging durable
acceptance. In one transaction, bind an item to its turn and delivery state.
For notices, persist pending delivery before returning accepted, then atomically
record consumption with its context entry. Keep the scheduler's synchronous
finish/admission rule while making its durable state transition explicit.

Recover queued work that has not started under a defined policy. Previously
running work still needs reconciliation; a queue in SQLite cannot provide
exactly-once execution of arbitrary external tools. Client output replay and
acknowledgment are separate contracts from input deduplication.

## Third increment: drain, suspend and resume

Follow the [suspend/resume lifecycle](suspend-and-resume.md): reject new external
work, finish active iterations, preserve internal notices and queued inputs, then
commit a clean suspended state. Reopening that state preserves queued and suspended
work for explicit resume rather than classifying it as interrupted. Completed
turns stay completed. Closing a process and reopening a database are separate from
suspending and resuming execution.

## Proposed implementation order and acceptance checks

1. Agree on the durable contract, first-increment schema, open/close ownership and
   interrupted-channel behavior. Record the accepted decision separately.
2. Implement in-memory and SQLite adapters against shared conformance checks:
   attribution, copies, ordering, atomic writes, ID allocation and reopen behavior.
3. Wire startup and session assembly to explicit storage configuration. Provide
   clear create/open behavior without silently changing the experimental protocol.
4. Verify two channels through a real process restart: history survives, the next
   captured inference contains both conversations, and new IDs do not collide.
5. Verify abrupt exit after input acceptance and after a tool call was recorded:
   incomplete work is reported, no tool is replayed, and unrelated completed
   channels remain usable. Verify incompatible schemas and a second owner fail.

All acceptance checks use scripted models and controlled tools. No provider calls
are needed. Historical inspector iteration snapshots and live subscriber replay
are outside the first increment; restored history and current context are in scope.
