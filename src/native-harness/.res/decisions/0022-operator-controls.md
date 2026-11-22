# 0022: Focused operator reads and attachment ownership

Full load couples readiness to history size. Keep lifecycle mutations in the
harness and replace wire load and message listing with focused open, observation,
tracked reconciliation and explicit history reads. Keep stored formats and
startup batch semantics. Open and create return identity, lifecycle, revision
and startup results before recovered work can publish events. Active model,
approval and callback phases retain their start timestamp and correlation ID.

The operator method map is in contracts/operator-controls.ts. Observe returns
current channel state, pending count, live or parked turn and outstanding
approvals at a revision boundary. Register delivery first, then reconcile and
drain buffered events in order. Revisions are boundaries rather than event IDs.
Reconcile accepts at most 100 unique IDs combined, scoped to the channel.
Foreign IDs appear unknown. Replies are metadata only and page independently
of item and turn dispositions. A continuation carries the original query and
revision and returns only further reply metadata. Open, observe and tracked
reads use focused storage operations on both adapters. SQLite uses indexes on
channel and sequence or the requested identities, without reading full history.

History pages default to 50 and accept limits 1–100. Bound complete wire
responses to the existing frame maximum. Cursor scope includes session, view,
channel when applicable, direction, initial revision and exclusive sequence
boundary. Invalid scope, direction, bounds or malformed cursor fails
invalid_params. Cursors survive reconnect and carry no authority. Backward
pages return the newest eligible records in chronological order and continue
before their oldest record. Forward pages advance after the saved position
through the inclusive observed revision. Save progress only after transcript
commit, and keep it before any unresolved gap. Live completion and history
share stable message IDs and channel-scoped positions. Use assistant text
references for large messages. Other oversized payloads retain attribution,
identity and an omitted marker. A scoped tool result reference is retained
when it fits. Every such entry advances the cursor. Conversation pages count
participant and assistant text only. Timeline pages include tool activity and
notices with source attribution.

The host owns one configured approval responder for all channels and routes
requests before conversation delivery. That responder alone answers when
configured. Otherwise preserve conversation handler behavior. Observe supplies
still-pending requests. Publish a closure notification keyed by request ID
when the approval becomes unavailable, including dispatch, denial, expiry and
cancellation. Disconnect invalidates the local pending view. Harness answers
remain authoritative for races. Attachment disposal affects observation only.
Controller stop confirms exact-turn interruption or that it already ceased,
then detaches. Loss before confirmation fails stop and prevents shared Restart
from starting. Agent stop suppresses reopen. Suspend waits for a committed
checkpoint while status and interrupts remain available. Intentional process
replacement preserves committed suspension until explicit resume.

The responder receives the exact request and an answer function returning the
harness acceptance outcome. Observers receive request data without that
function. The host deduplicates delivery by connection generation and request
ID, including during observation. Closure removes that ID from pending
presentation without changing the authority of an already in-flight answer.
Working counts include only running turns, regardless of attachments. A lost
observer marks its last agent status stale until the host can confirm it.

## Options and compatibility

Keep the full-load path with paging, or replace it with focused reads. Choose
focused reads so readiness and attachment never require transcript recovery.
Gate 2 removes session/load and session/messages from DurableMethods and
capabilities.methods. session/create returns OpenResult. There is no legacy
wire compatibility or wire migration. Stored formats remain unchanged.

## Binding details

On one connection, observe publishes events whose commits are included in the
observation revision before the response, and publishes later events after it.
Serialize no-revision notifications with that response too. Approval events
before the response are reflected in approvals. After taking the view, drop
buffered committed events at or below its revision for state reconciliation.
Deduplicate committed messages by ID when merging with separately read history.
For ephemeral events use the response's wire-order boundary: discard earlier
buffered notifications, apply subsequent ones in delivery order. Earlier drafts
and tool notifications are live-only and have no recovery guarantee. Seed the
approval set from observation, then apply subsequent request and closure events
by request ID. Keep this buffer and boundary local to the observed channel.
Observation includes session lifecycle and waitingForResume at the same revision.

Publish approval_closed exactly once after approval_requested for each request
leaving pending. Use the existing ApprovalCloseReason, or dispatched when
allow_once reaches dispatch. A grant awaiting dispatch remains tracked until
dispatch or cancellation. Disconnect closes the internal request even when
there is no remaining connection to deliver its event. Only approval-capable
connections receive actionable approvals and their lifecycle notifications.
approval/respond returns accepted true when its answer wins. Late, duplicate
and unknown IDs return not_found. A connection that did not declare approval
gets invalid_state.

Assistant message IDs use the reserved ID, with the existing numeric sequence
fallback for legacy entries. Participant messages use item:<itemId> and also
expose the original itemId. Their parts contain the original participant text,
without the model-context attribution prefix. Each live take reports these
message identities and positions alongside its item IDs. Both live completion
and paging use the same position derived from the committed sequence, encoded
with its session and channel scope. The Gate 1 event fields are optional for
existing producers until Gate 2 populates them on every eligible wire event.
Notice actors are agents attributed to their source channel. Timeline entries
preserve bounded typed message payloads, including assistant tool-call data.

Use a partial SQLite index on (channel_id, seq) for conversation-eligible
entries and a partial index on (turn_id, seq) for committed assistant text
reply lookup. Persist indexed eligibility projections, backfilled once for
existing SQLite sessions without bumping the format. Global timeline uses the
sequence primary key, and turn-reply results merge bounded indexed ranges for
the requested turns. Memory maintains corresponding ordered indexes. Each
range reads at most limit plus one eligible entry. Gate 2 covers these adapter
contracts in test/conformance/storage.ts on both adapters. The protocol owns
wire byte budgeting and projection, not storage.

A malformed turn ID (anything outside canonical positive safe-integer strings),
duplicate IDs within either ID list, more than 100 combined IDs, or an after
position from another session or channel returns invalid_params. Syntactically
valid unknown or foreign tracked IDs stay unknown.
