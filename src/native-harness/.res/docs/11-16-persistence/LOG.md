# Persistence work log

See [SPEC.md](SPEC.md) for the behavior and [PLAN.md](PLAN.md) for the work and
acceptance gates.

## Entries

- **Planning.** Consolidated the spec, implementation plan and work log in one
  folder. Branch and agent assignments are pending.

- **Assignment (coordinator haurness-l).** Implementer clad1a-n owns branch
  `aiagent/native-persistence` from base `93939c3` (stdio `bb615e0`). Reviewer
  gro1a-o reviews each named stage revision directly. Base: typecheck clean,
  44 tests pass.
- **Stage 1, contracts (implementer).** Decision
  [0013](../../decisions/0013-durable-delivery-contract.md); contracts revised in
  `src/contracts/{storage,agent,session,events,protocol,context,loop}.ts`. No
  kernel, adapter or interface code changed. Gate: `bun run typecheck` clean;
  `bun test ./test` 44 pass. Contract-level account of the three review cases:
  - *Message at the finish boundary.* Storage calls are synchronous, single-owner
    transactions, so `acceptItem` and `finishTurn(completed)` commit in one
    order. Accept first: finish sees the pending item, leaves the turn running
    and returns `finished: false`; the loop calls `takePending` and infers again,
    so the item joins this turn. Finish first: the turn is completed, the item is
    pending on a channel with no live turn, and the scheduler's post-accept
    `beginTurn` starts the next turn with it. `beginTurn` returns null while a
    turn is live, and take moves an item out of pending in the same transaction
    that links it, so it reaches exactly one turn. While suspending the same
    check applies but nothing is taken: accept first means finish returns
    `finished: false`, the turn is checkpointed with the item still pending, and
    after resume that same turn takes it before its first inference. Finish
    first means the turn is completed and the item waits for a `beginTurn` after
    resume. A turn with a final tool-free response and nothing pending completes
    and cannot be checkpointed.
  - *Crash before take.* The item is committed pending and nothing else changed.
    Reopen keeps it pending with no turn link. If the acknowledgment was lost,
    resending the same ID returns the original item. It becomes eligible when
    the host starts execution after load.
  - *Crash after take.* Take committed item, timeline entry, turn link and (for
    `beginTurn`) the running turn together. Reopen marks that turn interrupted;
    the item stays `taken` on it and is never pending again. Recorded calls
    without results are listed as uncertain and not re-executed. The channel
    begins a new turn for fresh input. A crash inside the transaction lands on
    one of the two sides.
  - *Load then live events.* `session/load` reads one snapshot at revision R and
    execution is started only after the response is written, so events for
    recovered work follow it. Events carry their commit revision: those at or
    below R are already in the view and are not sent after the response; those
    above R follow it.
- **Stage 1 review (reviewer gro1a-o), `9ca6bd4`: not approved.** Accepted the
  parallel old/new types, shared turns, immediate stop on EOF and the account
  above. Nine findings, all addressed in the next revision: suspension finish
  boundary; `confirmReceipts`/`takePending` refused unless the turn is running;
  `interruptActive` for stop during suspension; open never writes the
  compatibility key; exact signature and `auto:<n>` item IDs; `session/event`
  delivery; `transfer_limit` for oversized load views and archives; revision 2
  conformance list and the 0011 note; `participantIds` wording and ignored push
  `delivery`/`wake`. One deviation from the wording of finding 6: widening the
  existing notification union breaks `src/interfaces/client.ts` at typecheck,
  which a contract-only stage may not edit, so `session/event` is delivered
  through a `subscribeSession` member on the transport and endpoint contracts.
- **Stage 1 re-review (reviewer gro1a-o), `5514934`: not approved, one finding.**
  The eight other fixes and the `subscribeSession` deviation were accepted.
  Fixed next: `exportArchive` is `busy` for the whole `suspending` state, and
  `importArchive` rejects a `suspending` archive as `invalid_archive`.
- **Stage 1 approved (reviewer gro1a-o): `6fddbe6`.** Export is limited to an
  idle or cleanly suspended session; import rejects a `suspending` archive or
  one holding a running turn.
- **Stage 2, storage (implementer).** `src/state/storage/{engine,memory,sqlite,archive}.ts`,
  shared suite `test/conformance/storage.ts`, `test/storage-{memory,sqlite}.test.ts`.
  One engine implements the contract over a small row interface, so both
  adapters share every rule; SQLite adds the schema, the exclusive file lock
  and publish-by-hard-link for create and import. Not connected to execution.
  Gate: `bun run typecheck` clean; `bun test ./test` 86 pass, 0 fail (44
  existing, 18 conformance per adapter, 6 SQLite-only). SQLite-only checks:
  another process's live owner is refused and SIGKILL releases it; SIGKILL
  while running and while suspending leaves taken input on an interrupted
  turn with its uncertain call, untaken input pending, retries deduplicated
  and the channel able to begin turn 2; junk, foreign and future-format files
  are refused byte-for-byte unchanged; failed creates/imports leave no files;
  an injected mid-transaction failure rolls back the whole take. Deviations:
  none from the contract. Note: the SQLite tests take about 9 s because every
  commit is fsynced.
- **Stage 2 approved (reviewer gro1a-o): `f2e7873`.**
- **Stage 3, delivery and recovery (implementer).** The scheduler
  (`src/kernel/channels.ts`), loop and session assembly now run on storage; the
  memory-only `Agent`/`TurnRunner`/`HarnessSession` types and
  `shared-context.ts` are removed. The local chat adapter holds each request by
  following events to the turn that took its item. The protocol server adds
  `session/load`, `session/messages`, `session/status`, durable push
  acknowledgments and `subscribeSession`; the scripted server takes
  `--home <directory>` for SQLite sessions. Later context states unfinished
  turns and their uncertain calls. Gate: `bun run typecheck` clean;
  `bun test ./test` 104 pass, 0 fail, run four times. Real child processes,
  each killed with SIGKILL from inside immediately after a named commit
  (`test/crash.test.ts`): before take the input is pending and runs once after
  reopen; after take it stays on one interrupted turn and is not run again; a
  tool effect with no committed result is reported uncertain and the effect log
  still has one line after fresh work; a committed reply the client never
  received is returned by load; the load response precedes live events, which
  all carry later revisions; a second process is refused. A message racing
  completion is swept across 40 interleavings twice (`test/persistence.test.ts`):
  each item reaches exactly one turn, and all three outcomes occur. Deviations
  and limits: `suspend`, `resume` and `stop` exist on the session but are not
  reachable from the protocol and have no end-to-end test until Stage 4; stdin
  EOF still drains; `bun run start` still uses memory storage until Stage 6.
  Events are not durable: a killed process may not have flushed events it
  published, which is why load is the recovery path.
- **Stage 3 review (reviewer gro1a-o), `1191c4c`: not approved, two findings.**
  Fixed next. The loop now records the assistant message, publishes it, then
  confirms Seen, so a crash between the two commits leaves the reply durable
  and the receipt unadvanced (new child-process test at `appendMessage:1`).
  Message paging fails only when the first record of a request cannot fit a
  frame; a fitting page before an oversized message is returned whole.
- **Stage 3 approved (reviewer gro1a-o): `44fd9d5`.**
- **Stage 4, suspension (implementer).** `session/suspend`, `session/resume`
  and `session/stop` on the protocol server and client, lifecycle
  notifications through `subscribeSession`, and a `hold` scenario tool that a
  test can keep running. The kernel paths were written in Stage 3; this stage
  exposes and tests them. Gate: `bun run typecheck` clean; `bun test ./test`
  115 pass, 0 fail, run six times. `test/suspension.test.ts`, on both
  transports unless noted: two channels with running tools suspend only after
  the tools finish, each checkpoints without inferring, and the hold log shows
  each tool once; after reopen nothing runs or is published for 150 ms and
  pushes are refused until resume; on resume the pending message joins its
  channel's resumed turn (one `turn_took`, one turn), no tool call repeats and
  fresh work runs. A checkpoint under another system prompt loads but fails
  resume as `incompatible` with the load view byte-identical before and after.
  Stop during a running tool answers at once, reports the turn interrupted
  with its uncertain call, keeps pending input, and a late release changes
  nothing. In-process: stop during suspension resolves the suspend as
  `stopped` and interrupts the checkpointed turn; suspension during inference
  completes a tool-free answer and checkpoints a tool-requesting one; a notice
  accepted during suspension starts no inference until resume. Stdio only: a
  child killed after a checkpoint commit and before suspension commits reopens
  as running with that turn interrupted. One correction during the stage: the
  loop no longer publishes a failed tool event for a turn that stop already
  ended. Stdin EOF still drains, as agreed with the reviewer.

## Closure and retrospective

Record the accepted revision, review outcome, verification, follow-ups and
lessons from the coordination and review cycle here at completion.
