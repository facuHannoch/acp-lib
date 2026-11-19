# Channel controls contract (storage revision 3)

## Problem and options

A session suspends as a whole (0013). Consumers also need to suspend, resume,
create, rename and delete one channel, withdraw an untaken input, and interrupt
one turn, while other channels run. Options for individual suspension: (a) reuse
the session lifecycle per channel and key checkpoints to an owner marker;
(b) a channel lifecycle that composes with the session lifecycle and decides
checkpoint survival from the two states. Chosen: (b), no owner marker.

## Choice

- **Channel lifecycle** (`StoredChannel.lifecycle`): `open | suspending | suspended
  | retired`, independent of session lifecycle and turn status. `suspending`
  always has a running turn. Effective **admission** needs session `running` and
  channel `open` (notices also while the session is `suspending`). Effective
  **execution** (take, begin, resume of a turn) needs session `running` and
  channel `open`. Session check comes first, so a send during both is `not_running`.
- **Checkpoint survival** needs no new field: a checkpointed turn is kept across
  reopen and `interruptActive` iff the session is `suspended` or its channel is
  `suspended`. A turn is resumed by `resume()` iff its channel is not `suspended`,
  and by `resumeChannel` iff the session is `running`.
- **Atomic completion.** The transaction that checkpoints, completes, fails or
  interrupts the running turn of a `suspending` channel also makes it `suspended`.
  There is no separate "complete" call and no window between the two.
- **New operations** on `SessionStorage` (each one transaction, allowed in every
  session lifecycle): `createChannel`, `editChannel`, `beginChannelSuspend`,
  `resumeChannel`, `deleteChannel`, `withdrawItem`, `interruptTurn`. Session API:
  `PersistentSession.channels` (`create/edit/suspend/resume/delete/withdraw/
  interrupt`). Wire: `channel/{create,edit,suspend,resume,delete,withdraw,interrupt}`.
- **Errors.** New `channel_suspended` (send, notice, take, begin on a suspending or
  suspended channel), `channel_retired`, `channel_busy` (delete). Create of an
  existing channel with a different name is `already_exists`; the same request
  returns `created: false`. Retry of an accepted input never gets
  `channel_suspended`; it returns the recorded outcome.
- **Withdraw.** Pending `received` becomes terminal `withdrawn` (new
  `ItemMilestone`): not pending, no turn, no timeline entry, kept for dedup, so a
  retry with the same ID and payload returns it withdrawn. If take committed first
  the result is `taken` with the turn ID and nothing changes. Messages only.
- **Interrupt** names `(channelId, turnId)`. Only `running` is interrupted; a
  checkpointed or ended turn returns `interrupted: false` and is untouched, so a
  stale ID cannot reach a newer turn. A `suspending` channel is `suspended` in the
  same transaction without a checkpoint. `interruptActive` (stop, crash recovery)
  keeps an individually `suspended` channel and its checkpoint and returns a
  `suspending` channel to `open`.
- **Delete** retires the ID (`retired` is final, record and timeline kept) only
  with no running or checkpointed turn and no pending item; otherwise `channel_busy`.
  A retired ID rejects send, notice, create. First send to an unknown ID still
  creates the channel. Idle explicit create and edit never start work.
- **Status.** `ChannelStatus` adds `lifecycle`, `displayName`, `waitingForResume`.
  Pending work on a suspended channel is `waitingForResume` and does not make
  `execution` `working`.
- **Export/import.** Running-session export also requires no checkpointed turn
  and no `suspending` channel. Import rejects `suspending` channels and other
  states `open` would interrupt.

## Compatibility and verification

Revision 3 is format 3 and archive version 2. `open` accepts format 2 and
upgrades it in the recovery transaction: every channel `open`, unnamed, no
withdrawn items, no retired IDs; existing session-wide suspensions and
checkpoints keep their behavior because no channel is `suspended`. Format 3 is
not readable by the earlier revision. `importArchive` accepts archive versions 1
and 2 (`SessionArchiveV1` is import-only); export writes 2. Wire additions are
optional or new: old clients ignore `lifecycle`/`waitingForResume` and unknown
milestone `withdrawn` appears only for items they cannot have withdrawn.
Verification: conformance tests on memory and SQLite adapters, SQLite reopen,
interrupted suspend, persistence-revision fixtures, archive round trip, then
scheduler and end-to-end barriers per the SPEC.
