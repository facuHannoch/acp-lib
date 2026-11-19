# Persistence implementation specification

Status: design for review. See [PLAN.md](PLAN.md) for implementation stages and
[LOG.md](LOG.md) for decisions and results.

## Goal

Deliver one complete persistence slice that can be tested through real process
restarts. A consumer can run the harness with a SQLite database, use multiple
channels, suspend execution, close the process, reopen the session and explicitly
resume accepted work. The timeline, pending inputs and internal notices
survive. The inspector displays restored shared context immediately.

This is the persistence group of work. Context selection, sophisticated memory
and facts recall, policy enforcement, and consumer-owned coding workers remain
separate groups. Persistence initially retains the current full-history context
rendering.

## Current foundation

The existing harness has an in-memory shared history, sequential execution within
each channel, concurrency across channels, explicit internal notices, and separate
context rendering. Development startup and the experimental scripted protocol
share session execution. In-process and stdio transports already exist.

The type-only [storage contract](../../../src/contracts/storage.ts) and
[decision 0012](../../decisions/0012-session-storage-contract.md) cover initial history
restoration. They are not implemented or connected to execution. Extend that
contract for durable inboxes and suspension checkpoints before adapter work.
Revise the contract to distinguish pending inbox items from taken inputs, and
to end interrupted turns while keeping their channels usable.

## Required architecture

Keep three responsibilities separate:

| Responsibility | Required behavior |
| --- | --- |
| Storage | Own durable records, ordering, identity allocation and atomic transitions |
| Queries | Return timeline entries and execution metadata |
| Context building | Build the shared history view from timeline entries and render it with current configuration for inference |

SQLite belongs behind contracts in `src/state/storage/`. Kernel code coordinates
through contracts and must not import SQLite or execute SQL. Assembly chooses
implementations. Maintain an in-memory adapter with matching execution semantics
and shared conformance checks.

Use `bun:sqlite`, one database for one session, and one owning process. Different
channels retain concurrent asynchronous inference/tool execution. Database
transactions are short; no transaction remains open across inference or tools.
PostgreSQL and multi-server scheduling are not requirements for this slice.

## Durable information

Persist at least:

- Session identity, data/schema versions, configuration compatibility metadata
  and lifecycle state.
- Stable channel and participant IDs for routing and attribution. Derive who has
  spoken in a channel from its timeline entries. Membership and access rules are
  separate configuration.
- Stable turn identities, original inputs, channel ordering and execution status.
- A session-wide timeline of user messages, assistant responses, internal
  notices, tool calls and paired tool results. Entries record their sequence,
  timestamp, channel, sender and turn where applicable.
- Accepted input IDs and payload signatures for restart-safe deduplication.
- Pending inbox items and notices, source/target attribution, turn links once
  taken, and confirmed inference receipts.
- Resumable turn checkpoints, including the next execution step and references
  to recorded messages and pending work.

Use stable IDs and a global committed sequence; timestamps do not determine
order. Preserve structured payloads rather than only rendered prompt text.
Validate serialization and preserve supported opaque provider state unchanged.
Credentials, functions, connections and process handles are supplied at runtime,
not serialized as execution state.

## Acceptance, recording and ordering

The harness delivers every accepted message as soon as the channel can use it.
When a turn is active and accepting input, it takes pending items at its next
inference boundary, after the current inference and its requested tools finish.
This is steering. If the channel is idle or the turn has closed admission, the
input starts a new turn when the channel can run it. The send API has one
delivery behavior. Internal notices use the same delivery rule and retain their
source-channel attribution.

Acceptance first commits the item to the durable inbox with its stable ID,
payload signature, channel and sender. The same ID and payload return the
original acceptance, including across restart and while suspended. The same ID
with a different payload returns a conflict. New external inputs are subject to
the session's admission state.

Taking input removes it from the pending inbox, adds it to the timeline and
links it to its turn in one transaction. Retain its ID for deduplication. Take
pending items in acceptance order within the channel. The inspector can show
pending input from the inbox. Input becomes eligible for model context at take.
The finish decision and the pending input check are atomic with respect to
acceptance. A concurrent send either keeps the current turn open or starts a
later one, with each input taken once.

Record assistant responses and tool requests before execution. Record each tool
result with its call identity afterward. Publish corresponding completed-message
and result events only after recording succeeds. Lifecycle events similarly
follow their durable transitions. Do not claim that persistence guarantees client
receipt or provides durable output replay.

Maintain sequential execution per channel and concurrency across channels.
Timeline queries must preserve attribution and active-turn tool pairing. The
builder reads fresh committed information before every inference, without
changing a request already in flight.

### Message milestones

| Milestone | Evidence |
| --- | --- |
| Sent | The client submitted the message and is awaiting acknowledgment. |
| Received | The harness committed the message to the durable inbox and can acknowledge acceptance. |
| Taken | The harness committed the message to the timeline and linked it to the turn that took it. |
| Delivered | The provider confirmed that its inference engine accepted a request containing the message. |
| Seen | The harness received model output from that request. The exact evidence depends on the adapter. |

Delivered and Seen refer to a request in the target turn that took the message.
Inclusion in another channel's shared history does not advance these receipts.
Record receipts only when supported by provider evidence. A valid model
response can confirm both at once with the current non-streaming adapter.
An outbound request, transport headers alone, or a rejected call does not
establish a model receipt. Commit confirmed receipts before publishing them.

Failure is reported with a reason and preserves the last confirmed milestone.
A missing acknowledgment leaves acceptance unknown to the client. Retrying
the same ID resolves whether the harness received the input. An interrupted
turn retains its taken items and any confirmed receipts.

Working describes turn activity. Several messages may link to the same working
turn. A client may show Sent, Received and Seen as separate ticks, fold Delivered
into Seen, and show the Taken turn link in message details.

## Lifecycle and suspension

Expose session lifecycle `running → suspending → suspended`. Explicit resume
returns a compatible suspended session to running. Opening a session and resuming
execution are separate actions. A suspended session may remain open for inspection.

When suspension begins:

1. Reject new external work with an explicit lifecycle error. Preserve accepted
   inputs that have yet to be taken. Stop starting turns and new iterations.
2. Let in-flight inference finish. Record its response, execute its requested
   tools and record their results. If tools are already running, finish that
   iteration's remaining calls.
3. Continue durably accepting valid internal notices from finishing work, but
   do not start additional execution to deliver them while suspending.
4. At the iteration boundary, complete naturally finished turns or save a
   suspended checkpoint when another inference is required.
5. Commit session suspended only after every active turn has settled and all
   accepted work/checkpoints are durable; then report suspension complete.

A tool-free response with no pending input completes normally. Pending inputs
remain durable without forcing an extra inference during suspension. Repeated suspend requests
observe the same transition; suspension of an already suspended session is
harmless. Notice admission and final checkpoint transitions must leave no gap
where acknowledged work can disappear.

Closing releases resources and ownership; it does not itself suspend execution.
Stop, including stdin EOF, closes admission and requests cancellation of active
inference and tools immediately. It starts no further work and does not wait
for the current iteration or drain the inbox. Record active turns as interrupted
and leave untaken inputs pending. Fence off late results so stopped work cannot
advance execution. A tool already in flight may have an uncertain outcome.
The host waits for successful suspension before a clean update or relocation.
Resume reconstructs model and tool services, continues suspended turns on
their original channels, and delivers pending input under the usual steering
rule. Other channels can resume independently.

## Crash recovery and compatibility

An unexpected exit is distinct from successful suspension. A tool can have an
external effect before its result commits. End active turns as interrupted and
keep the channel usable. Inputs already taken stay attached to that turn. Untaken
inputs remain pending and become eligible for delivery on normal reopen. Preserve
committed tool results and report uncertain outcomes in the turn record and
subsequent context. The scheduler never automatically repeats a call from an
interrupted turn. An external effect and its recorded result cannot generally
commit together.

Clean suspension preserves pending input and checkpoints for explicit resume.
If the process exits before the session commits clean suspension, end unfinished
turns as interrupted, including turns that individually checkpointed during that
attempt. Preserve their committed records. Any still-untaken items remain eligible
on normal reopen.

Use explicit create/open and exclusive ownership. Check storage format and schema
readability before recovery writes. A second owner or unsupported format fails
clearly. Check execution compatibility before starting work. A readable session
can be opened for inspection and exported even if its supplied services cannot
continue a checkpoint. Pending inputs that have never started a turn use the
configuration in effect when they run. Continuing a suspended turn requires
compatible model, provider state and tool implementations. Report incompatibility
without consuming pending input or advancing a checkpoint.

A host may force termination after a shutdown deadline, but expiry is interruption,
not successful suspension. Suspension itself may wait for a long-running tool.

## Export and import

Export a single versioned `.harness` archive containing a manifest and a logical
session snapshot. Export is available when the session is idle with no active
or pending work, or when it is cleanly suspended. Export leaves the lifecycle
unchanged. Take one consistent snapshot so a concurrent send cannot leave an
export with only part of an accepted input.

Include session metadata, portable configuration and compatibility metadata,
channels and participants, timeline entries, turn outcomes, pending inbox items,
deduplication records, clean checkpoints and ID allocation state. The destination
supplies credentials, tool implementations and environment-specific resources.
The bundle format is versioned independently from SQLite's internal schema.

Validate the full archive and publish the imported session atomically into a
fresh destination. Permit a new session ID while preserving IDs within the
session. Reject an existing destination. An imported suspended session requires
explicit resume. Import creates a copy. For relocation, stop the source before
resuming the destination so the same pending work cannot run in both copies.

Support a file path when the caller and harness share a filesystem, and bounded
file transfer over stdio for callers that do not. A session archive can exceed
the size of a single protocol frame. The contract should specify transfer limits
and cleanup for interrupted transfers.

## Consumer and development interfaces

Provide public session lifecycle/storage APIs and typed client/protocol operations
for create/load, status, suspend, resume, export and import. Specify concrete
operation names and errors in the contract decision. Preserve transport-independent execution.
Status must distinguish idle, suspended and unresolved interrupted work.

Load returns a consistent view of lifecycle, channels, turn outcomes, taken and
pending input IDs with confirmed receipts, and committed assistant messages with stable IDs. Use a
storage revision to identify the snapshot. On the same connection, deliver the
load response before publishing live events for recovered work. If paged, keep
load results anchored to that revision. Configure execution before making pending
input eligible. Callers decide how to reconcile their own records.

Provide development startup controls for database selection, create/open and
resume. Restore live context in the inspector without requiring a new message,
and display lifecycle/channel status. Do not make read-only inspection resume work.

The development assembly with real inference and the scripted stdio server must
use the same persistence implementation. Offline checks require no provider key.
Update protocol capability descriptions to reflect only implemented guarantees.

## Acceptance criteria

Use scripted models, controlled tools and real child-process restarts to verify:

1. Two completed channels survive restart; live context is restored immediately,
   subsequent captured inference includes both conversations, and IDs do not collide.
2. Identical accepted-input retries create no duplicate work after restart;
   conflicting payloads return a stable conflict error.
3. Pending messages and notices survive suspension and reopening. A message
   arriving at turn completion reaches exactly one turn, including when it
   arrives during inference or tool execution.
4. Suspension during inference/tools finishes the iteration and resumes at the
   next inference without repeating completed calls. Per-channel ordering holds.
5. A notice accepted as another channel checkpoints remains deliverable after
   resume without starting extra inference during suspension.
6. A naturally completed turn stays completed through suspension and reopening.
7. Exit before input take leaves it pending. Exit after input take leaves it
   attached to an interrupted turn. Exit after a tool request or external effect
   with no committed result reports uncertainty without tool replay. The same
   channel accepts fresh input after reopening.
8. Concurrent ownership, incompatible format/configuration, serialization failures
   and illegal transitions fail clearly without partial domain writes.
9. Typed client operations work through in-process and stdio transports; existing
   execution scenarios continue to pass.
10. Load recovers a committed assistant message missed by the client and delivers
    its snapshot boundary before live events for recovered work.
11. Export and import preserve a cleanly suspended session, including pending
    input and deduplication. A bundle larger than one stdio frame transfers
    successfully. Invalid bundles and existing destinations leave no partial import.
12. Inspect and export a readable session with an incompatible checkpoint. Resume
    fails clearly and preserves the checkpoint and pending inputs.
13. A received message stays outside the timeline until take. A provider
    rejection or an inference on another channel never advances Delivered or
    Seen. Confirmed receipts remain visible after reopening.
14. Stop during a controlled tool call requests cancellation without waiting for
    the iteration, preserves pending input, and reports the active turn as
    interrupted. A late tool result cannot restart execution.

### End-to-end scenarios

**Clean relocation.** Use the public client with a scripted child process. Start
two channels. While a controlled tool is running, accept a message or notice and
request suspension. Finish the iteration, export the suspended session, and
close the source. Import into a fresh home and load. Verify the timeline, turn
IDs and pending input before resuming. After explicit resume, the input reaches
exactly one turn and the completed tool call runs only once across both processes.

**Crash recovery.** Kill the process on each side of the durable input-take
boundary. On reopen, verify the input is pending or attached to exactly one
interrupted turn as appropriate. Exercise a tool effect with no committed result
and a committed assistant reply the client missed. Verify load reports both,
the affected channel accepts a fresh message, and the prior tool call is never
replayed automatically.

Complete a manual development test with multiple channels and the inspector:
start work, exchange a notice, suspend, close, reopen and resume. Record what was
verified and any remaining limitations. Historical inspector request snapshots,
durable output replay, advanced recall/compaction, and automatic reconciliation of
uncertain external effects are outside this scope.
