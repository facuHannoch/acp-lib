# Native harness model execution

Date: 2026-11-19.
Status: ready for implementation on the accepted configuration and permissions base.

## Scope

Support streaming model responses, bounded retries and timeouts, and durable
call summaries. Use the existing OpenRouter and scripted model paths. Build on
the session lifecycle and the tool dispatch gate defined in the
[configuration and permissions spec](../../11-19-config-permissions/SPEC.md).
The [business rules](../../BUSINESS_RULES.md) list choices whose values or
behavior can be revisited independently.

Topic subscriptions and media input have separate designs. The execution loop
continues to take input through the inbox. A future topic notice can wake a
subscribed channel and use that same path.

## Execution units

- A **turn** runs on one channel and can span any number of iterations.
  Different channels run in parallel.
- An **iteration** takes pending input, builds a model request, runs one logical
  model call, then handles the tools returned by that call through the
  permission gate. The end of the iteration is a suspension boundary.
- A **model call** uses one fixed request and one deadline. An **attempt** is
  one execution of that request by the adapter. A call can retry with a new
  attempt while keeping its ID, original request, and deadline.

Input accepted while a call is in flight can steer the turn at the next
inference boundary. It does not change that call or a retry of it. After
handling a response, continue if tool results require another inference or
pending input is eligible for take. Otherwise, close the turn through the
existing atomic inbox check. Input accepted after the turn closes can wake a
new one.

## Model adapter and stream

The adapter runs one attempt and honors cancellation. It reports ordered text
deltas, provider usage when available, and an explicit terminal outcome.
When the provider confirms a request reached inference before generating
output, the adapter may report that evidence separately.

A successful terminal response contains the complete assistant message, any
complete tool requests, and a stop reason. The adapter assembles tool-call
fragments internally. A non-streaming or scripted adapter may return a complete
response without deltas. A stream that ends without a valid terminal response
is incomplete. An explicit provider output limit ends the turn with the
`output_limit` reason. Keep any streamed text visible as incomplete and
skip tool dispatch for that response. Define the normalized response shapes
and stop reasons in the contract decision.

Publish text deltas under a stable assistant message ID so the client can
assemble one live reply. A committed completion uses the same ID. Commit the
successful model-call outcome and complete assistant response, including its
tool requests, in one transaction. Publish completion and dispatch tools only
after that transaction commits.
Only complete tool requests from a validated response reach the permission
gate. Keep the existing tool result pairing and dispatch event rules.

Every published draft has a terminal outcome. On failure, timeout, interrupt,
or stop before commit, mark the live reply incomplete with a reason if the
connection can still deliver the event. The turn separately reports its failed
or interrupted outcome. Clients can keep partial text visible locally.

If the connection dies before a terminal event, the client stops presenting
the draft as live and reconciles by message ID on reconnect. A committed reply
replaces the draft if found. Otherwise the draft stays incomplete. Timeline
reads return committed responses. Live deltas and incomplete text have no
durable replay guarantee and stay out of inference history.

### Consumer delivery modes

Consumers choose a text delivery mode on their event subscription. Both
modes use the same inference, tool execution, and committed history.

| Mode | Consumer receives |
| --- | --- |
| Messages (default) | One completed assistant message per model response that contains text, along with tool and turn events. |
| Streaming | Text deltas followed by completion for the same message ID, along with tool and turn events. |

The completed model response defines the message boundary. Paragraphs within
that response stay together. A response containing text and tool requests
publishes its completed text before dispatching the tools. A tool-only
response emits no empty text message. A later inference can emit another
assistant message in the same turn.

Streaming is opt-in for consumers such as the interactive terminal and web
chat. Messages mode filters out text deltas and incomplete reply events.
Consumers in that mode still receive the turn outcome. Subscription mode
does not change the retry policy or what commits to history.

Both modes respect bounded transport frames. Coalesce deltas within a bounded
buffer per connection without waiting for the reader in the execution loop.
If a reader falls behind, stop live delta delivery for that message. The
completion gives the consumer the authoritative reply. Deliver ordinary
completions inline. For a reply too large for one frame, send a completion
reference with the same message ID and allow bounded reads of its committed
text by ID. Enqueue completion before tool events for that response.

A blocked shared stdio connection can delay events from every channel. If
terminal events cannot be delivered within the connection bounds, fail the
connection explicitly and apply existing stop and recovery rules. Results
already committed remain recoverable. Define the buffer limits, fallback
signal, and bounded read format in the contract decision.

## Receipts

Update receipts only for messages already taken into the target turn and
actually included in that inference request. Evidence from another channel's
shared history does not advance them.

Provider confirmation that inference accepted the request can establish
Delivered. Meaningful model output, such as generated text or a tool-call
delta, can establish Seen before completion. If the adapter only has evidence
from output, it can confirm both together. A valid non-streaming response can
also confirm both. Commit confirmed receipts before publishing them. An attempt
can establish Seen and later fail. Its failure leaves the confirmed receipt
intact.

## Retry, timeout, and lifecycle

Allow at most one automatic retry for a transient provider failure while
the deadline still permits it. Close the retry window when the runner first
accepts a nonempty text delta for publication, before filtering by subscription
or handling transport backpressure. Committing a response also closes that
window. Privately buffered tool fragments can establish Seen without closing
it. Retry classification distinguishes transient provider errors from
cancellation, invalid configuration, and invalid requests. No model retry
replays a tool.

The default model call deadline is 120 seconds from the start of the first
attempt. It includes waiting for the provider, receiving the full stream, and
the one-second delay and attempt for any retry. The retry uses only the time
remaining on that deadline. Tool execution, approval waits, and inbox time
are outside this deadline. Timing out cancels the active attempt and fences
late output. End an exhausted or expired call with an explicit outcome and
leave the channel usable. A turn has no overall iteration limit in this slice.

Interrupt and stop cancel the current attempt or retry wait immediately and
fence late output. Preserve already committed responses and receipts. Suspend
lets the current logical call settle within its existing deadline, including an
eligible retry. Finish handling the complete response and its tools under the
existing suspension and approval rules. Checkpoint before the next model call
when the turn still needs one.

## Call records and usage

Persist one summary per model call, linked to its turn, with one attempt
summary per provider attempt. Include stable IDs, timing, outcomes, retry
reason, provider request ID when available, and provider-reported usage.
Attribute reported usage to the attempt that incurred it, including failed or
cancelled attempts. Missing usage remains unknown. Aggregate reported usage
without counting an attempt twice.

Keep summaries available through the harness after restart, separate from the
conversation timeline. Reopening after a process crash reports unfinished
calls as interrupted and retains the summaries and usage already recorded.
If the successful model call committed before the crash, its outcome and
response remain successful even if its enclosing turn is interrupted.

The scripted adapter reserves its next step as part of the durable attempt
start for that channel. Every attempt advances the script once. A crash after
reservation consumes the step even if the adapter did not run it. Reopening
does not derive the script position from completed assistant replies.
Exact wire events, stored fields, and retrieval are part of the contract gate.

## Acceptance

Use scripted attempts and deterministic barriers to verify the following:

1. Streaming emits deltas under one ID and commits one completed reply with
   that ID. Fragmented tool arguments reach the executor only as a complete,
   permission-checked call. Scripted and non-streaming responses still work.
   Messages mode emits no deltas and publishes completed text before any
   tool dispatch from the same response.
2. A transient failure before output can retry once using the same request.
   Both attempts appear under one call. The shared deadline bounds the retry.
3. A late failure after streamed text marks the reply incomplete, leaves no
   completed timeline message for it, and does not retry or execute partial
   tool calls. Both subscription modes make the same retry decision. An
   explicit output limit has its own recorded reason.
4. Interrupt cancels a stalled attempt or retry wait and fences late output.
   Suspend lets the current iteration settle and resumes from its checkpoint.
   A second channel can finish a turn while the first is waiting.
5. Confirmed receipts and call summaries survive restart. Usage reported by a
   failed attempt is counted once. Missing usage remains unknown.
6. Crash on either side of the atomic success commit. Verify the call outcome
   and timeline agree, the streaming client reconciles using the message ID,
   and the scripted adapter continues from its reserved attempt position.
7. With a slow reader, verify deltas are coalesced or dropped within bounds
   while another channel can complete and commit. Recover dropped text from
   completion. Fetch an oversized reply by ID in bounded reads in both modes.
   Verify a fully blocked connection follows stop and recovery behavior.

Record the adapter and client event contracts, call summaries, and operational
defaults in a decision record before dependent code changes.
