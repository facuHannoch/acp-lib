# Native harness channel controls

Status: proposed behavior for review.

## Scope

A session can run several channels concurrently, with one active turn per
channel. A consumer can manage a single channel and its work while other
channels continue. This slice builds on the durable inbox, timeline, and
iteration checkpoints in the [persistence spec](../11-16-persistence/SPEC.md).
Implementation should start from the accepted persistence branch or a base
that includes it.

Scope covers send, withdraw, and interrupt, plus channel create, suspend,
resume, edit, and delete. Context reset, a hold that continues accepting
messages, policy changes, and model settings are separate design work.

## Messages and turns

- **Send.** Acknowledge after the harness durably accepts the input. Preserve
  the existing input ID deduplication rules. An active turn takes pending
  input at its next inference boundary. An open channel starts a new turn
  when there is pending work and no turn can take it. Turn outcomes remain
  separate from send acknowledgment. Taken input enters the timeline and
  becomes eligible for inference context.
- **Withdraw.** Remove an untaken input from pending delivery. Withdrawal
  competes atomically with take. If take won, return the owning turn ID.
  If withdrawal won, report the withdrawn outcome, retain it across restart,
  and keep the input out of the timeline. A retry with the same ID and payload
  cannot make the input pending again.
- **Interrupt.** Target a specific active turn ID. Request cancellation and
  end that turn without waiting for its inference or tool to finish. A stale
  interrupt cannot affect a newer turn. Keep taken inputs and committed
  timeline entries attached to the interrupted turn. Untaken inputs stay
  pending and are eligible to start another turn if the channel and session
  allow execution. Fence off late results. Any external effect whose outcome
  is unknown remains uncertain and is never replayed automatically.

If interrupt wins while a channel is suspending, end the turn and complete
channel suspension without a checkpoint. Untaken inputs remain pending.
If the checkpoint commits first, the turn is no longer active and interrupt
reports that it did not interrupt a turn. The checkpoint stays intact.

## Channel lifecycle

The channel's lifecycle is separate from its turn status. An open channel
can be idle or working. A suspending channel can be finishing an iteration.
A suspended channel may have a checkpoint and pending input.

| Operation | Behavior |
| --- | --- |
| **Create** | Open a channel with a stable ID and optional display name. Creation alone starts no turn. The first accepted participant message to an unused ID can also create the channel, as in the persistence baseline. |
| **Suspend** | Close admission and stop taking pending input or starting new iterations. Finish the active inference and the tools it requested, if any. Complete the turn if it can finish at that boundary. Otherwise, commit a checkpoint and mark the channel suspended. Preserve pending input in either case. |
| **Resume** | Clear the channel's individual suspension. When the session permits execution, continue the checkpointed turn under its original ID and make pending input eligible for normal delivery. |
| **Edit** | Update the display name. Keep the channel ID, history, and execution state. |
| **Delete** | Retire the channel only when it has no active or checkpointed turn and no pending input. Check eligibility and retire the ID atomically with respect to send and scheduling. Preserve the timeline and reserve the retired ID. |

Once individual suspension begins, reject new messages and inbound notices
for that channel with a stable channel-suspended error. A retry of an
already-accepted input still returns its recorded outcome. The finishing turn
can send notices to other channels where admission is open. After suspension
completes, success means the channel and any checkpoint are durable.

Keep the session suspension and individual channel suspension independent.
Session resume starts only channels eligible to run. Individually suspended
channels remain suspended. Resuming an individual channel while the session
is suspended clears its individual suspension and preserves any checkpoint
under the session suspension. Admission and execution wait for session resume.

A committed individual suspension survives restart. If the process dies
before individual suspension commits, apply crash recovery to the unfinished
turn. Mark it interrupted, report any uncertain tool effects, and preserve
untaken input. Reopen the channel for work subject to the session lifecycle.
An interrupted session-wide suspension leaves any independently committed
channel suspension and its checkpoint intact.

Deleting a channel rejects new sends, inbound notices, and explicit create
requests for the retired ID. Callers can withdraw pending inputs before
retrying deletion. Historical records still refer to the retired ID. A
checkpoint with incompatible execution configuration stays intact until a
compatible resume is possible. Deletion requires the checkpoint to be resolved.

## Persistence compatibility

Databases and archives produced by the accepted persistence revision can
open or import. Existing channels have no individual suspension. A stored
session-wide suspension and its checkpoints retain their original resume
behavior. Databases and archives created by this slice preserve individual
suspensions, withdrawn outcomes, and retired IDs.

## Public behavior and acceptance

Expose operations and observable outcomes through the session API and typed
client. Status exposes channel lifecycle, turn status, and pending input
independently. Pending work on a suspended channel remains visible as waiting
for resume. It does not make the session report active execution by itself.
Document exact wire names, error codes, and compatibility
choices in the contract decision before changing implementation.

Use deterministic barriers with a scripted model and controlled tools:

1. **Independent suspension.** Run two channels. Suspend Alice while her
   tool runs and an accepted message is pending. Reject new input and
   inbound notices for Alice while Bob continues. Reopen the session and
   verify Alice stays suspended. Resume her channel and verify that the
   completed tool does not run again and the pending message is taken once.
2. **Session composition.** Suspend and resume the session around an
   individually suspended channel. Verify it stays suspended, and that a
   channel resume during session suspension preserves its checkpoint and
   starts no work. Crash during a session-wide suspension and confirm an
   earlier committed individual checkpoint survives. Verify suspended pending
   input is visible even when no turn is executing.
3. **Interrupt and stale requests.** Interrupt a specific turn while a tool
   runs. A late result cannot advance it. Pending input may start a new
   turn, and retrying the old interrupt leaves that new turn alone.
   During channel suspension, test interruption on both sides of checkpoint
   commit. An interrupt before commit leaves the channel suspended without
   a checkpoint. An interrupt after commit preserves the checkpoint.
4. **Withdraw versus take.** Exercise each side of the race. A withdrawn
   item remains withdrawn across restart and retry. A taken item reports
   its turn ID and remains on the timeline.
5. **Delete versus send.** If acceptance wins, deletion fails while the
   input remains pending or its turn remains unfinished. If deletion wins,
   the send is rejected. Reopening preserves the retired ID and timeline.
   Verify that neither create nor first send can reuse a retired ID. Verify
   first send can still create an unused channel, and that explicit create
   and edit leave an idle channel idle with the same ID.
6. **Crash during suspension.** Kill the process before the checkpoint
   commits. Reopen with the taken inputs on an interrupted turn and
   untaken input still recoverable. Verify the channel can accept new work.
7. **Compatibility.** Open a database and import an archive produced by
   the accepted persistence revision. Verify ordinary channels still run
   and session-wide checkpoints still resume explicitly. Verify an
   incompatible individual checkpoint remains intact after attempts to
   resume or delete its channel.
