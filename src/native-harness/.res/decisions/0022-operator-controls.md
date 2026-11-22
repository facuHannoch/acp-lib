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
