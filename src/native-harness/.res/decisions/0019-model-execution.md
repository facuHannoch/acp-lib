# 0019: Model calls, evidence, and live replies

## Problem

Complete-response inference cannot bound attempts, expose streaming without
retrying visible text, or recover call cost and response identity after a crash.
The existing tool permission and storage fences must remain authoritative.

## Options

Put retries and streams in the kernel, provider adapters, or a neutral call
runner; persist only final text or persist attempt evidence; block execution on
consumer writes or bound each connection's queue.

## Choice

Use the neutral contracts in `contracts/model-execution.ts` and a call runner
outside the kernel. One logical call freezes the request and reserves a stable
call ID and assistant message ID. Attempts have distinct IDs and ordinal order.
An adapter runs one attempt, emits ordered neutral signals and at most one
terminal, assembles provider tool fragments privately, and honors abort. EOF
without terminal is incomplete; malformed or duplicate tool IDs, malformed JSON
arguments, invalid response/stop combinations, or tool fragments without a
valid terminal never dispatch. Provider state remains opaque and unchanged.
A complete response validates as one assistant message; `complete` has no tool
calls, `tool_calls` has at least one, and `output_limit` is terminal without
committing that response or dispatching any of its tools. Non-streaming adapters
can return a response without deltas. Empty deltas have no effect.

The default logical deadline is 120000ms from the first durable attempt start, shared by all attempts
and the retry wait. A single transient failure before cutoff may retry once,
after 1000ms, with the identical frozen request and only remaining time. No
retry occurs for invalid input/config, cancellation, incomplete EOF, output
limit, or other failures. The cutoff is the first nonempty text delta accepted
by the runner, before subscription filtering, queuing or backpressure, or a
committed response. Privately buffered tool fragments can confirm Seen without
closing retry. Interrupt and stop abort the attempt or retry delay and fence all
late signals and writes; suspension permits the current logical call and an
eligible retry within the original deadline, then handles the iteration under
existing tool and approval rules and checkpoints before another call.

`accepted` confirms Delivered; nonempty text or adapter `seen` confirms Seen
(and Delivered). A validated complete response confirms both. Evidence applies
only to the call's frozen set of items taken into that turn and included in the
request, never shared-history items or inbox items not taken. Each advancing
receipt commits before its event and survives an attempt failure. The attempt
start, provider ID and reported usage are durable; usage is an absolute report
for that attempt, not a delta, so a later report replaces its previous report
and aggregation sums each attempt once. Absent counts remain unknown; never
invent zero. Usage must be emitted before the attempt terminal to be accepted;
usage arriving after a timeout or cancellation is fenced even if the provider
reports it later. A started attempt with no confirmed usage stays unknown. Usage accepted before termination survives a crash. Ignore all
signals after a terminal, timeout, cancellation, or a failed storage fence.

A running call's successful attempt and complete response, including all tool
calls and the reserved message ID, commit in one storage transaction. Only
after that succeeds can completion be queued and tool dispatch begin. Failed
commit publishes neither completion nor tool effects. Marking dispatch still
follows 0018. On interrupt or crash after success, retain the successful call
and message even if the enclosing turn ends interrupted. Before success commit,
no assistant response or tool calls are durable or executable. On recovery,
unfinished calls and running attempts become interrupted, preserving committed
receipts and usage, without replay. Both memory and SQLite implement the same
atomic boundaries. Each scripted attempt reserves and increments its channel's
zero-based script position in the durable start-attempt transaction, including
retries; a crash consumes the reservation even if no adapter code ran. Reopen
uses the durable position, never the count of completed messages.

Messages is the default text subscription (`final` remains its wire spelling
for compatibility); streaming is opt-in as `stream`. Both run identical calls
and commit identical history. Stream events carry the reserved message ID;
completion uses that same ID and precedes tool events. A tool-only response
emits no text completion. Failure after any published draft emits one incomplete
event if the connection remains deliverable; final mode filters both deltas and
incomplete events. After reconnect, look up that ID: committed text replaces a
local draft; otherwise mark it incomplete. Drafts are not durable history.

Each connection has a 1 MiB live-event queue in addition to the existing 1 MiB
frame maximum. Producers never await a reader. Coalesce queued text deltas for
the same message when they fit; on overflow drop further deltas for that
message and enqueue one `text_gap` before its completion. If a required gap,
completion, or other nondroppable event cannot fit, fail the connection and
apply existing disconnect/stop rules; committed data remains recoverable. A
`message_completed` fitting the frame is inline; otherwise it carries `reference: true`
and its ID. `session/message/read` retrieves committed UTF-8 text by ID as
base64 pages of at most 524288 raw bytes, with byte offsets and `nextOffset`;
concatenate bytes before decoding. Unknown IDs are `not_found`, invalid offsets
are `invalid_input`, and paging does not alter history. `session/load` and
`session/messages` use the same reference representation for oversized text
instead of failing solely because one message is too large. `session/model-calls` summary pagination
is in durable call-creation order using a stable call ID as cursor, with a maximum of 100 calls per page and a 1 MiB frame;
when a page cannot fit, return fewer entries and a continuation, never a partial
summary. A single summary too large for a frame fails `transfer_limit`.

## Compatibility and traces

SQLite format becomes 5 and logical archive becomes 4; session-file envelope
stays 1. Upgrade formats 2/3 through their existing recovery and migration to
4, then to 5 transactionally. Existing format 4 opens with empty call records
and scripted position initialized from its prior assistant-response count per
channel, preserving the old scripted continuation behavior. New exports carry
format 5/archive 4, summaries, usage, and script positions. Adapter imports of
archives 1–3 and session files with archives 2–3 migrate equivalently; archive
1 inside an envelope remains invalid. Standalone JSON stays invalid. Validate
all references, IDs, attempt ordering, states and usage before atomic import;
no failed upgrade/import may partly publish. Export eligibility and saved config
are unchanged. Unfinished calls cannot be exported because export requires a
clean suspension or idle session.

Trace retry: no text, transient attempt 1 persists evidence/usage, attempt 2
uses the same request; a successful atomic commit yields one message and two
attempt summaries in either delivery mode. Text before failure instead closes
retry in both modes, leaves no completed message, and only streaming receives
incomplete. Interrupt during a wait or attempt records interrupted and fences
late output. A slow reader loses deltas, not committed data; if its queue cannot
hold required events it disconnects, while already committed results remain.
Crash after script reservation but before response commit leaves an interrupted
call and consumed script step, with no response or tool effect. Crash after
response commit preserves the successful call and message with the same ID;
tool effects obey dispatch evidence 0018 and are never replayed.

## Contract locks following review

The following details resolve the wire and lifecycle choices above. The existing
completion event is `message_completed`, never a second completion event. It
carries the reserved message ID in both subscription modes. Streaming adds only
`text_delta`, `text_gap`, and `text_incomplete`; `final` filters those three,
while receiving completions, tool events and turn outcomes. Receipts remain
`items_receipt`, emitted after their commit only for items that advanced.
Inline `message_completed` has the complete text in parts; a reference omits
parts. Oversized entries in load and message listing use the same reference.
`session/model-calls` and `session/message/read` are protocol methods. Turn
outcomes remain completed, failed and interrupted: only interrupt and stop
produce interrupted; timeout, failed, incomplete and output_limit end the turn
failed with that call outcome as its reason, with no further call in that turn.

The deadline starts when the first attempt's durable start commits, not at
startCall. If less than the 1000ms retry delay remains, finish timeout without
starting the retry. Defaults are 120000ms, 1000ms and one retry; tests may
shorten timeoutMs. Tool execution, approval and inbox time are outside the limit.

The script counter denotes the next zero-based step. Starting a scripted
attempt atomically records that step and increments the counter; a non-scripted
start does not. A failed start writes nothing. A call has at most one running
attempt and two attempts total; an excess start fails and writes nothing. A
failed response commit does not undo a reservation. Migration counts all prior
assistant timeline messages on the channel, including tool-only messages; reopen
uses the stored counter without recounting.

A call reserves a message ID that is never reused even if it does not commit.
`commitResponse` accepts only validated `complete` without calls or validated
`tool_calls` with calls; other stop reasons or invalid tool payloads fail without
writes. The same transaction ensures dispatchedCallIds exists for responses
containing calls without marking new call IDs, as in 0018. The transaction does
not mark or invoke tools. The existing permission gate follows it. Completion
is emitted only for nonempty committed text. Non-streaming adapters emit a
validated response through the runner; the kernel does not take receipt evidence
or dispatch from a resolved Model promise.

Milestones only advance; seen includes delivered, and repeated or lower evidence
writes nothing. startCall rejects any item that is not taken by that turn with no
write. A provider request ID is committed on its first report, including accepted
before terminal, and survives crash. Usage reports replace absolute per-attempt
values; negative, fractional or unsafe counts are rejected without replacing a
prior report. Missing fields stay unknown. Sum each present field once per
attempt without inventing a total. Reports after terminal, timeout or cancellation
are ignored.

Format 2/3 performs existing upgrade through 4 and existing recovery, then the
format 5 migration in one transaction. Format 4 performs existing recovery first:
a suspended session keeps its turns; otherwise running turns and checkpoints
outside individually suspended channels are interrupted, and a suspending channel
returns open. The same transaction adds empty call records, initializes script
positions and publishes format 5, including for suspended sessions. Failure leaves
the owned file at its old version. Import and export reject running calls or
attempts. A succeeded call has exactly one assistant timeline message at its
reserved ID with its committed tool calls; other outcomes have none. Attempt
ordinals are contiguous from zero. Adapter archives 1–3 and session-file archives
2–3 migrate equivalently; envelope 1 remains, and archive 1 inside it is invalid.
A summary page contains whole calls; a single call too large for a frame fails
`transfer_limit`, never an empty page.

The runner never awaits a transport write. The per-connection 1 MiB live queue
coalesces deltas in order, drops further deltas for a lagging message and enqueues
one gap. The existing 1 MiB frame and 4 MiB queued-write limits remain. If a
nondroppable event cannot fit the live queue or the existing writer rejects it,
fail that connection and apply existing disconnect and stop rules. Already
committed records remain recoverable.
