# acp-client integration contract

Date: 2026-11-20.
Status: proposed for review. See [PROTOCOL.md](PROTOCOL.md) for the wire contract
and [PLAN.md](PLAN.md) for implementation and verification.

## Goal

Run two native conversations in acp-client against one real scripted harness
over stdio. Exercise durable acceptance, steering, tool approval, interruption,
and recovery without provider credentials. This establishes a boundary both
projects can build against.

Use the reviewed model-execution stack as the reference implementation
(`02c96de`, closure `49f2974`). Reuse lazy startup, shared process ownership,
offline channel changes, and turn correlation from the
[original acp-client integration design](../../../../../../.res/somelogs.md/11-11+/library/11-11-SPEC-native-harness-integration.md).
The first test covers the behaviors below. Host tool callbacks, broader
operator controls, and long-running mock scenarios extend it in later slices.

## Ownership

| Component | Responsibility |
| --- | --- |
| acp-client | Launch and supervise the process, associate conversation IDs with channel IDs, keep prompt handles and application records, and present events to consumers. |
| Native harness | Own session and channel state, input acceptance and take, execution and permissions, and durable recovery. |
| Public harness client | Provide typed stdio requests, notifications, and connection failure. acp-client uses the public exports. |

The native adapter implements the reviewed `ConversationController` interface.
Bring that host work and the accepted harness stack onto one integration base
before implementing the adapter.

### Controller behavior

Map `turn_started` and `turn_took` to `subscribeTurns()`. The harness
can produce output before acp-client attaches its supervisor. Buffer that
turn's early output and outcome until the supervisor subscribes and calls
the `prompt()` returned by `prepareTurn()`. Preparing the turn does not
start another inference. The harness's `turn_ended` settles that prepared
prompt. acp-client finalizes and publishes the conversation outcome once.

For a native conversation, `forceStop()` uses the targeted channel interrupt
for its active turn and settles that conversation's controller work. The
shared host owns process shutdown. Other channels retain their execution
and subscriptions.

The native controller reports `startFresh()` as unsupported and exposes
that limitation through the conversation capability surface. The controller
contract currently requires the method and has no dedicated reset capability.
Define the capability and unsupported outcome at the host adapter gate.
The call leaves the channel, session, and timeline unchanged.

One acp-client agent maps to one durable harness session. Each native
conversation maps to a stable channel ID within it. Creating or showing a
conversation can happen before launch. First work starts the process. Concurrent
sends for the same agent share the same startup rather than launching competing
owners. Use the host launcher with a configured harness home that survives
process restart.

All conversations on that session talk to the same agent. Opening a new
conversation gives it a new channel and leaves the entity and its shared
timeline intact. An agent-wide context reset and a channel context reset are
deferred. Retiring a channel preserves its timeline entries.

## Startup and recovery

1. Attach event handlers and initialize the public client over stdio.
2. Load the existing session with the latest pending channel changes. Create it
   on a confirmed missing-session response. Surface configuration,
   compatibility, and ownership errors to the consumer.
3. Reconcile the returned snapshot by channel, input, turn, and message IDs.
   Buffer any live events received while applying that snapshot and merge them
   afterward. The harness orders events from recovered work after the load
   response. A revision is a snapshot boundary, and several events can share it.
4. Report suspended channels and sessions as suspended. Loading does not itself
   authorize resume.

### Changes made while stopped

Keep the original `harness_pending` design. While the harness is down, acp-client
stores the latest desired channel name, policy, suspension, or deletion.
It submits the coalesced changes with `session/create` or `session/load`.
The harness applies them before pending work can run. acp-client clears a
change only when that exact version is confirmed, so an edit made during
startup stays pending.

The batch sent with open is the startup cutoff. Send edits made after that
cutoff through the live channel API as soon as open completes. Apply those
edits before submitting fresh host work to the affected channel. Recovered
work can start before a later edit reaches the harness. A suspension in the
open batch prevents that work from starting.

A policy change governs new input that inherits the channel policy.
Previously accepted inputs retain their resolved policies. To prevent
pending work from running on startup, suspend the channel in the startup
batch. A delete that finds pending input or a checkpoint leaves that channel
suspended and reports a conflict. The rest of the session can open. The user
can withdraw waiting input or resolve the checkpoint before retrying deletion.

Session configuration is fixed for an open session. Changes take effect
on the next open through the existing configuration resolution rules.

After a crash or disconnect, the host can reopen through the same flow. Accepted
but untaken input is still pending. Taken input belongs to its original turn.
The harness reports interrupted turns and any uncertain tool outcomes. The
host restores committed replies that it missed and does not automatically
repeat interrupted work. Live text deltas are provisional. A committed reply
with the same message ID replaces a local draft on reconnect.

## Sending, approval, and interruption

Use the host's prompt record to save the stable input ID and exact payload
before calling `channel/push`. Distinguish a prompt waiting in the host queue
from a submission whose outcome is unknown. Only a receipt or reconciled
harness state confirms durable acceptance. After reopening, retry unresolved
submissions with the original ID and payload. Leave accepted, untaken inputs
pending and settle taken inputs from their owning turns.

| Harness fact | acp-client behavior |
| --- | --- |
| Push accepted | Mark the prompt handle accepted. Keep the ID and payload recorded before submission. |
| `turn_started` or `turn_took` | Associate all listed input IDs with that turn. Input may steer when taken by an active turn. Preserve the association even if the event arrives before the push response. |
| `message_completed` | Record the committed reply once by message ID. Fetch referenced text through the public client when it exceeds one frame. |
| Approval requested | Route the exact pending call to the conversation's approval handler. Respond by request ID with allow once or deny. A stale answer has no effect. |
| `turn_ended` or withdrawal | Settle the relevant prompt handles from the correlated outcome. A suspended turn remains pending until resumed or ended. |

An interrupt targets a specific channel and turn. The affected turn can end
while other channels continue. Send and turn completion remain separate.
acp-client can choose to delay submitting a prompt in its own queue. Once
submitted, the harness delivers it by its existing take rules. The first
integration uses channel suspension for explicit pauses. An expiring hold
can be revisited when a consumer operation needs it.

## First end-to-end checkpoint

Use acp-client's public conversation interface and a real scripted stdio child:

1. Open two conversations under one agent. Send concurrently and verify a
   single process and durable session are shared.
2. Send another input while one channel is working. Verify it is accepted and
   then correlated to the turn that takes it. The other channel can finish
   independently.
3. Route an approval for an existing scripted tool through the consumer.
   Verify approval dispatches that call once.
4. Interrupt one active turn and verify the other channel keeps working.
   Exercise this through conversation-level `forceStop()`. Send fresh input
   on the interrupted channel.
5. Lose the process or connection after a reply commits. Record a suspension
   for one channel while the process is down. Reopen and verify the suspension
   takes effect before that channel can run recovered work. Verify
   the host restores that reply by ID, reconciles pending and interrupted input,
   and continues on the same session without duplicating work or records.
6. Lose the push response after the harness commits the input. Reopen from
   the host's saved submission and verify that the same ID is accepted only
   once. Separately lose the open response after channel changes commit and
   verify that retrying open confirms the changes without duplicating work.

The broader integration checkpoint adds a consumer-registered callback and a
long-running mock run after those slices are available.

## Decisions before implementation

- Confirm the launcher contract for native harness processes, the startup
  deadline, and when acp-client retries a failed launch.
- Finalize the pending-change result shape in the protocol contract.
- Use the existing small-session load view for the first test. Define the
  recovery page cursor and add bounded recovery before relying on
  long-running mock sessions.
