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

## Closure and retrospective

Record the accepted revision, review outcome, verification, follow-ups and
lessons from the coordination and review cycle here at completion.
