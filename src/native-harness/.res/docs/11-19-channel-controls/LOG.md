# Channel controls log

Branch `aiagent/native-channel-controls`. Base: persistence closure `3a236ac`
(approved behavior `9d9de35`). Spec and plan cherry-picked from `326ab17` as
`640ece1`. Implementer: this branch; reviewer: gro1a-o; coordinator: haurness-l.

## Stage 1: contract and decision

Decision `0014-channel-controls-contract.md`; type-only edits to
`src/contracts/{storage,agent,session,events,protocol}.ts`. No implementation.

Gate: the contracts compile alone (`tsc --strict` over `src/contracts/*.ts`).
`bun run typecheck` for the whole package fails only in the files that implement
or consume the changed contracts, as AGENTS.md expects of a contract-first
change: `state/storage/{engine,archive}.ts`, `kernel/channels.ts`, `index.ts`,
`interfaces/protocol/load.ts`, and tests that read event fields or build
`StoredChannel`. Stages 2 to 4 clear them; each stage gate returns to a green
typecheck.

### Contract-level traces (storage transactions are totally ordered)

| Race | Commit order A first | Commit order B first |
| --- | --- | --- |
| Suspend vs take | `takePending` first: items join the running turn; `beginChannelSuspend` then sets `suspending`; the turn checkpoints with them. | `beginChannelSuspend` first: `takePending`/`beginTurn` fail `channel_suspended`, items stay pending; the turn checkpoints or completes (completion refused while pending, so it checkpoints). |
| Interrupt vs result commit | `appendMessage` first: result recorded, then interrupt ends the turn; only calls still unanswered are uncertain. | `interruptTurn` first: turn interrupted, `appendMessage`/`confirmReceipts` refused `invalid_state`; the call is uncertain and never replayed. |
| Interrupt vs checkpoint (channel `suspending`) | `checkpointTurn` first: channel `suspended` with checkpoint; interrupt returns `interrupted: false`, checkpoint intact. | `interruptTurn` first: turn interrupted, channel `suspended` without checkpoint, pending kept; `checkpointTurn` fails `invalid_state`. |
| Withdraw vs take | `withdrawItem` first: `withdrawn`, never taken, a retry via `acceptItem` returns it withdrawn. | take first: `withdrawItem` returns `taken` with turn ID, item stays on the timeline. |
| Delete vs send | `acceptItem` first: item pending, `deleteChannel` fails `channel_busy`. | `deleteChannel` first: `retired`; `acceptItem` fails `channel_retired`. |
| Session resume around a suspended channel | `resume()` skips turns of `suspended` channels and does not check their key. Channel stays suspended, checkpoint intact. | `resumeChannel` while session suspended: clears channel suspension only; checkpoint stays under the session suspension; the later `resume()` continues it. |

Other compositions: a crash before channel suspension commits leaves `suspending`
(returned to `open` on open) with the running turn interrupted and pending
items kept; a crash during session suspension interrupts checkpoints of non-
`suspended` channels only, so an earlier committed channel checkpoint survives;
checkpoint survival is derived (session `suspended` or channel `suspended`), so
no owner marker has to be kept consistent.

### Compatibility (written before implementation)

Format 2 databases open and are upgraded in the recovery transaction; archive
version 1 imports; existing channels are `open` with no individual suspension;
session-wide suspension and its checkpoints resume as before. See decision 0014.

### Stage 1 review round 1 (gro1a-o, `1f90c97` not approved)

Fixed in the next commit: withdraw covers notices; snapshot items include withdrawn
items; retired channels' turns are rejected on import and never resumed
(`resume()`, `resumeChannel`); wire export and stop comments match storage; omitted
interrupt reason is `"interrupted by request"`. The red full typecheck is accepted
until Stage 4's gate.

## Stage 2: storage and recovery

Both adapters (memory, SQLite) implement revision 3 through the shared engine
(`engine.ts`, `archive.ts`); SQLite adds format 3 tables and the in-place format 2
upgrade, which runs inside the recovery transaction (statements are prepared
lazily so a format 2 file can be read before the upgrade).

Choices the contract left open, all inside what 0014 and the review accepted:
- `beginTurn` on an unknown channel is now `not_found` (the contract text); it was
  `null`. One existing conformance expectation changed for that.
- Channel `participantIds` view and `StoredChannel` carry `displayName` only when set.
- Create stores the trimmed name. Interrupt and withdraw take their channel ID and
  answer `not_found` for a mismatch.
- `engine.ts` is 501 lines: every rule of the contract lives there by design (one
  engine for both backends); splitting it is deferred to avoid churn mid-review.

Gate: `bun run typecheck` has errors only in `index.ts`, `kernel/channels.ts`,
`interfaces/protocol/load.ts`, `test/agent.test.ts` (Stage 3 and 4 own them).
`bun test ./test`: 164 pass, 0 fail (134 before; 30 new storage cases).
New conformance (memory and SQLite, SQLite reopens the real file): suspension and
admission, checkpoint survival, idle suspend, interrupt vs checkpoint/finish/late
results, stale interrupt, withdraw (message, notice, take-first, retry, reopen),
create/edit/delete/retired IDs, session resume skipping a suspended channel
(including an incompatible key), channel resume during session suspension, stop
and crash recovery, interrupted channel suspend, export rules, archive round trip
of the new records, archive v1 import, invalid archives. SQLite only: format 2
fixture built from the verbatim old schema (suspended and unclean), failed
upgrade leaves the file byte-identical, retired channel holding a checkpoint is
left by `resume()`.

## Stage 3: scheduler

`kernel/channels.ts` gains `ChannelControls` (create, edit, suspend, resume,
delete, withdraw, interrupt) and `index.ts` exposes it as `session.channels`.
Storage still decides every race; the scheduler only reacts to commits.
- A channel suspension is a pending promise per channel, settled by the commit that
  checkpoints, completes, fails or interrupts its turn (`settleChannel`), which is
  also when `channel_state` is published. `checkpoint()` now stops a turn at its
  boundary for either suspension.
- Interrupt commits first, then aborts the turn's signal and frees its slot, so the
  channel's pending input can start the next turn while the old tool is still
  running; the old turn's late result is refused by storage (`invalid_state`) and
  unwinds. A stale interrupt is a storage no-op.
- Session `resume()` re-reads the pending set from open channels only; an
  individually suspended channel keeps its checkpoint and backlog and does not keep
  the session from reporting idle. `resumeChannel` starts a returned checkpoint
  turn even before `start()` (storage already marked it running).
- `stop` returns an uncommitted channel suspension to `open` and answers its caller
  `stopped`.
- Status adds `lifecycle`, `displayName`, `waitingForResume`; a backlog on a
  suspended channel does not make `execution` `working`.

Gate: `test/channel-controls.test.ts` (8 tests, 8 clean repeats): Alice suspends
with Bob running, rejects input and notices, survives a reopen and takes her
backlog once with the recorded tool not rerun; interrupt with a late-returning
tool and stale retries; interrupt vs checkpoint on both sides during suspension;
session suspend/resume around a suspended channel and channel resume during
session suspension; withdraw vs take; create/edit/suspend/delete and retired IDs
across reopen; stop during channel suspension. `bun test ./test`: 172 pass, 0
fail. Typecheck errors remain only in `interfaces/protocol/load.ts`,
`test/agent.test.ts`, `test/e2e.test.ts` (Stage 4).

### Stage 3 review (gro1a-o, `9cc6892`, not approved)

Gro found that resuming a checkpoint before `start()` incorrectly set the global
started flag, enabling other channels and preventing `start()` from pumping their
backlog. The follow-up keeps the resumed turn's executor without setting that
flag. A reopen regression checks existing and newly accepted inputs remain
untaken until `start()`, then run exactly once. Implementer handoff: cod1a-m on
branch `aiagent/cod1a-native-channel-controls`, based on `9cc6892`.
