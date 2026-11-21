# Operator and consumer controls

Date: 2026-11-20.
Status: proposed for review. See [PLAN.md](PLAN.md) for module ownership and
implementation gates.

## Goal

Let a consumer control an agent, manage one of its channels, and attach to a
conversation independently. Prove the behavior through acp-client and the
public harness client over stdio. Build on the accepted revisions of the
[acp-client integration](../../acp-client-integration/0001-DESIGN/SPEC.md) and
[tools and host callbacks](../../tools-and-callbacks/0001-DESIGN/SPEC.md).
Reuse the existing [channel controls](../../11-19-channel-controls/SPEC.md).

## Ownership

| Scope | Owner | Effect |
| --- | --- | --- |
| Agent session | Harness; the consumer host owns the process and transport | Session lifecycle governs execution across all its channels. |
| Channel | Harness | Channel lifecycle governs admission and execution for that channel. A turn and its tool invocations belong to the channel. |
| Attachment | Consumer | An attachment lets the client observe a channel. A listener can unsubscribe independently. Disposing the attachment releases local resources. |

An agent session represents one identity and timeline. Each channel keeps its
own lifecycle, turns, pending inputs, and policy over the session tool catalog.
An active channel can admit input and run a turn with no attachments. Closing a
client view leaves the channel, its work, and the shared host connection intact.
Closing the host's stdio connection still has the existing EOF stop semantics.
Two clients may observe one channel through the consumer without creating two
harness channels or two turn supervisors for it.

## Status

| Scope | Consumer view |
| --- | --- |
| Attachment | **Connected** or **Disconnected**. Connected means the client has attached and can observe the channel. |
| Channel | **Active · Idle**, **Active · Working**, **Suspending**, or **Suspended**. **Retired** is permanent. Map the harness's existing `open` state to **Active**. |
| Agent | **Online**, **Suspending**, **Suspended**, or **Offline**. While online, show **Idle** or **Working in N channels**, derived from the number of channels with a running turn. |

Show a session-level blocker alongside the channel's own state. An active
channel under a suspended session stays active but cannot run until the
session resumes. A channel waiting on an approval or callback with a running
turn counts as working. A checkpointed turn and pending inputs by themselves
do not count as running work. Where phase data is available, show the phase,
its start time, and the relevant turn, approval, model call, or tool ID.

Offline means the host knows the agent is down. If the client loses its own
connection and cannot verify the agent state, show that state as unknown or
mark the last view as stale. Obtain a current view through the existing public
status operation and revisioned channel observation.

## Attachment and controller API

Plain attach observes the existing channel and preserves its lifecycle. A
consumer can offer an attach-and-start convenience option for normal use.
Install event handling and reconcile the initial view before exposing live
updates. When the same operation makes work eligible, establish observation
before enabling execution. A repeated attach on the same controller reuses its
attachment. A repeated start leaves an already active channel active.

Disposing the attachment is idempotent. It stops local delivery and leaves
accepted inputs, running turns, and pending approvals in the harness under
their existing lifecycle rules. Removing a listener just stops delivery to
that listener.

The harness owns pending approvals and enforces their deadlines. An
approval-capable consumer can route and answer requests independently of a
conversation attachment. In acp-client, the host routes the request to an
authorized responder under acp-client's own authorization. Attaching or
sending a message grants no approval authority. If the approval connection
stays open but nobody is available to answer, the request waits under its
existing deadline. An authorized responder who attaches before expiry can
see and answer it. Closing the approval connection follows the existing
cancellation rules. A harness without an approval-capable consumer skips
calls that need approval. Harness-level participant approval roles are deferred.

Keep the existing `ConversationController.start()` and `stop()` pair for the
shared high-level workflow. Native start can attach and make an eligible
channel available. ACP keeps its existing lifecycle. A client can compose
restart as stop followed by start after a successful stop. For native, this
uses the same channel ID and keeps its history. Plain reattachment never
resumes a suspended channel. Expose attach-only as a capability where
supported. The console or UI can offer a detach action through attachment
disposal.

For this slice, keep native `stop()` as a targeted interrupt and detach. The
channel remains eligible for future work. When a running turn is targeted,
successful stop confirms that the harness interrupted it or that it had
already ceased running. If the connection drops before confirmation, surface
the unconfirmed result and reconcile the target on reopen. Shared Restart
opens only after successful stop. Attachment disposal leaves the turn running.
Explicitly suspend the channel to prevent future turns, and resume it to
restore eligibility. Host shutdown acts at agent scope.

## Opening, reconciliation, and history

| Operation | Scope and response |
| --- | --- |
| Open agent | Open the configured session, recover execution state, and apply startup channel changes before work becomes eligible. Return session identity, lifecycle, revision, and startup change results. The open response excludes transcript pages and historical turns and inputs. |
| Attach or reattach | Require a channel ID. Return current channel state, its running or checkpointed turn, and any live approval the consumer can act on. Establish the revision boundary for live delivery. |
| Reconcile tracked work | Look up the specific input or turn IDs the host still tracks, scoped to the channel. Recover their outcomes and committed reply IDs or references without walking earlier history. |
| Read history | Explicitly request either one channel's conversation or the agent's cross-channel timeline. Fetch additional pages only on request. |

Use focused storage reads for open, channel observation, and tracked recovery.
These paths must avoid materializing the historical timeline, turns, or inbox
records. Recovery still updates unfinished work and applies pending startup
changes under the existing rules.

### Public protocol

| Request | Inputs and result |
| --- | --- |
| `session/open` | Takes the session ID, optional config, and optional startup channel changes. Opens an existing session and returns identity, lifecycle, revision, and startup change outcomes. A missing session is `not_found`; the host can then use `session/create`. Both readiness responses are lightweight. |
| `channel/observe` | Takes a channel ID. Returns one revisioned view with channel lifecycle, a pending-input count, the running or checkpointed turn summary, and actionable pending approvals. The consumer uses the existing connection's live event stream. |
| `channel/reconcile` | Takes a channel ID and a bounded batch of input and turn IDs. Returns their current disposition, explicitly identifies unknown IDs, and exposes committed reply references for the matched turns. Page any reply references that exceed the response budget. |
| `channel/messages` | Takes a channel ID and optional limit. The initial request reads the newest page. An older-page cursor continues backward. A saved message position and an upper revision begin forward catch-up. A continuation cursor advances that catch-up within the same bounds. Returns messages with stable IDs and recoverable positions, plus a continuation when more records exist. |
| `session/timeline` | Takes an optional limit and older-page cursor. Returns a page of attributed timeline events and a continuation when older events exist. |

Replace the public `session/load` and `session/messages` paths in the harness
and switch acp-client to these operations in the same slice. The former wire
shapes require no migration or compatibility path. Keep the existing lifecycle
requests and `session/message/read` for assistant text references. Preserve
stored sessions and startup channel-change behavior. Recovered work becomes
eligible after the open response is sent, subject to session and channel state.

The live attachment path registers delivery before taking the current view.
Recover an active turn even when it has no local submission record. Restore
completed turns as history and scope live supervision to live work. Use stable
IDs to deduplicate committed replies where the initial view overlaps live
delivery. Transient deltas follow the existing delivery contract.

### History views

Both views read the same stored timeline through the storage adapter. A
conversation page requires a channel ID. Its limit counts committed participant
messages and assistant text messages. Tool calls, tool results, internal notices,
and transient deltas consume none of that budget. The agent timeline pages by
stored events across channels and can include notices and tool activity.

Return the newest page first and order records chronologically within each
page. Use an opaque cursor bound to the session, view, channel where applicable,
and the original timeline boundary. Older reads use indexed sequence ranges.
Respect the wire-size bound and use references for oversized records where
supported. If a single event is oversized, return a bounded entry with its
identity, attribution, and an omitted-payload indicator. Include an existing
scoped result reference when available. The cursor advances past this entry.
The [business rules](../../BUSINESS_RULES.md) set the page default and opt-in
fetch behavior.

acp-client resolves its conversation ID to the harness channel ID and retains
its consumer-facing pagination interface. A consumer using its own transcript
can attach and receive live events without requesting harness history. That
mode recovers tracked outcomes and can leave gaps for untracked turns completed
while the consumer missed live delivery. When the harness supplies the
transcript, the chat UI can request the newest page as part of opening the
view. Targeted recovery works with either transcript source. History reads
have no effect on model context or execution.

Both paged and live committed conversation messages expose the same stable ID
and a channel-scoped position. Forward catch-up is supported in this slice and
remains opt-in. Buffer live delivery for the affected channel, then read bounded
pages after the last persisted position up to and including the observation
revision. Deliver those pages in chronological order and merge live messages
using stable IDs. Advance the persisted position only after messages through
that position have been saved. A retry can safely resume from the last saved
position. If live delivery resumes while a gap is unresolved, keep the saved
catch-up position before the gap even if newer messages are displayed. A
consumer without a saved position can explicitly request the newest page.

Return the stored channel, turn, and actor attribution. Participant messages
carry the participant ID. Agent output and tool results carry the agent actor.
The turn's linked inputs preserve provenance when multiple participants steer
it. Internal notices retain source and destination channels. Connection tracing
and participant-filtered reads are deferred.

## Channel controls

- Create, edit, and retire channels through the existing operations. Creating
  a channel starts no turn. A retired ID cannot be reactivated.
- Suspend closes admission and lets existing work reach the suspension
  boundary. The response confirms the channel's committed suspension.
- Resume clears the individual suspension. Work becomes eligible when the
  session can run. Accepted, untaken inputs remain pending through suspension.
- Interrupt targets one exact turn. Late or stale requests cannot affect the
  next turn. The active channel can still take new work.

Suspended is the reversible inactive state for v1. If an immediate combined
action is added, interrupt and close admission as one harness transition and
leave the channel suspended. The base slice can use the existing separate
suspend and interrupt controls. Follow the existing recovery rules for any
uncertain tool effects.

## Agent and host controls

- Start opens the configured agent session through the existing host launch
  sequence and the lightweight open path. Concurrent startup requests share
  the launch. Opening a suspended session preserves its suspension.
- Suspend stops session-wide admission and waits for the existing suspension
  boundary. While it waits, allow status and targeted interrupts through the
  same connection. If a callback is holding it open, show the blocking turn
  and tool where available. The suspend response confirms the checkpoint is
  ready for a clean replacement of the process.
- Resume explicitly makes eligible channels able to run. An individually
  suspended channel stays suspended. Surface incompatibility and preserve
  the checkpoints.
- Stop immediately ends session execution and shuts down the child. An
  intentional stop suppresses automatic reopen. If the child exits without
  confirmation, recover the authoritative outcomes on the next open and
  reconcile tracked turns by ID.

For a planned update, suspend, close the child after suspension commits, open
the same session with the replacement, and explicitly resume. Reuse the public
harness client. acp-client owns orchestration and presentation for this flow.

## Config, capabilities, and usage

Use `initialize` capabilities to expose supported controls. Validate candidate
configuration through `config/validate` and apply it through the existing open
path. Keep credential values out of operator output. Aggregate the existing
durable model-call records by session or channel. Represent missing provider
usage as unknown and surface when an aggregate is partial.

## Acceptance

Use a scripted model over real stdio without provider credentials.

1. Attach Alice and Bob. Detach Alice without interrupting her turn, then
   trigger another turn on her active channel while she is detached. Reattach
   with an explicit history read and verify each committed reply appears once,
   later events arrive, and Bob's attachment remains intact. Use an existing
   harness trigger or a scripted fixture for the unattended turn.
2. Suspend Alice while Bob works. Verify Alice rejects new input, her accepted
   untaken work stays pending, and explicit resume enables it once. A stale
   interrupt leaves a newer turn alone. Verify repeated attachment and
   disposal do not change the channel's lifecycle.
3. Suspend the session while a tool is running. Observe the blocking call,
   let it settle, replace the child, reload, and resume. Verify the tool's
   effect happened once and an individually suspended channel stays suspended.
   In a separate run, stop during suspension and reconcile interrupted work.
4. Verify the consumer can distinguish disconnected, offline, suspended, and
   online with multiple working channels. Check capabilities, invalid config
   validation, and a usage summary containing missing provider usage.
5. Open a session with at least 10,000 timeline records and enough turns or
   inputs to exceed the existing full-load frame. Verify open and attachment
   read no transcript when fetching is disabled. Hold inference and verify
   storage reads for open, attachment, and targeted recovery stay bounded.
   Confirm targeted recovery still finds a tracked outcome. Request Alice's
   newest conversation page and verify the query stays scoped to her channel.
   Page backward while new
   replies arrive and verify ordering, stable attribution, and no duplicate or
   missing messages. Verify tool activity does not consume the conversation
   page budget and remains visible in the separately paged agent timeline.
6. Detach the last observer while an approval is pending and request an
   approval on a channel with nobody attached. Verify an authorized responder
   can act before expiry, an unauthorized observer cannot answer, and the
   existing expiry and disconnect rules still apply.
7. Verify shared Restart waits for targeted interruption before reopening the
   conversation. An unconfirmed stop makes Restart fail before it calls start.
   Verify the next turn and other channels are unaffected by the targeted request.
8. Place an oversized tool result between ordinary timeline records and verify
   paging advances past it. Lose the stream across an untracked turn, catch up
   explicitly from a saved position while live delivery resumes, and verify
   each missed reply is persisted once. Interrupt catch-up between pages and
   verify retry resumes from the last persisted position.

Channel restart as a separate native operation, context reset, and the full
standalone CLI remain outside this slice.
