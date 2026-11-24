# Review: joint R9 real-stdio acceptance (`joint-r9-acceptance` at ba2cb95)

Reviewer: clad2a-s. Clean `git archive` of ba2cb95 on `/dev/shm`; no edits to the branch; mutants and probes on separate copies.

Verdict: **the two new tests are sound and exercise the real harness child; approve them as the first slice of R9 acceptance. R9 acceptance is not complete: most of the contract's routine behaviours have no real-stdio test (list in section 4).** I found no defect in the library or the runtime. If the intent is "joint acceptance done", the gaps below should be filled or explicitly waived.

## (1) Parity

- `src/native-harness/` vs the approved runtime `174c7c4`: **empty diff.**
- Non-harness diff vs alpha `15f27b1`: **one file**, `test/native/reminders-joint.test.ts` (+94 lines: a `guard` option on the joint helper, two hooks, two tests). No library change, no fixture change, no new file.

## (2) Gate

- Root `tsc --noEmit`: exit 0. Harness `bun run typecheck`: exit 0.
- Plain `bun test`: **2,228 pass / 0 fail, 233 files, 35 snapshots.**
- Whole joint file x20: **20/20** green (14 tests each: the 12 one-off tests plus the 2 new). Each new test isolated x20: **40 runs, 0 failures.**
- Ceilings unchanged: host 909, native/controller 591, agent-session 4,527.

## (3) Do the tests use the real harness and prove their claims?

Both use `spawnHarness` (the real harness CLI in a child, real SQLite home, real stdio, the harness's own client); the only seam is the harness's fake-clock environment variable, as in the one-off joint tests.

**Counted routine across a reconnect with an exhausted guard** (guard 1, `every: 600000, count: 2`): confirmed create shows `remainingCount: 2`; with the harness stopped and its clock at the first instant, the next start fires occurrence 1 (notice id `reminder-notice:<id>:<iso>` asserted) and, after the unattended turn finishes, the routine is `active` with `remainingCount: 1`. After a second stop/start at the second instant: the open reports `unattendedTurnGuard: { maxConsecutiveTurns: 1 }` confirmed by **this** connection (`routineAdmission.available` asserted `false` before the open call and `true` after), the config of the reopen omits `limits` (bound value), the row is still `active` with `remainingCount: 1`, `nextDueAt` is `null` (exhausted channel contributes no deadline), `reconcileChannel` shows **no** second notice; a participant `push` then releases it and exactly two fires are recorded, in order, with both notice ids confirmed by `reconcileChannel`, and the final row is `completed`, `remainingCount: 0`, `nextRunAt: null`. That proves: two real occurrences, exact ids and counts, the persisted exhausted guard withholding the second occurrence until participant input, evidence cleared and reconfirmed per connection, and count consumed exactly once per occurrence.

**Held create and pause** (guard 3, stopped host): offline create + pause leave the wake index empty and no cold timer; at the next start the open carries no reminder entries (`reminderChanges` empty) and the harness has no such reminder; the trace is exactly `open, create, update` with the guard asserted confirmed before each live change; the hook makes the due occurrence fire before the live pause is sent, and exactly one notice (the first occurrence) is recorded; the final row is `paused`, `remainingCount: 1`, `nextRunAt: null`. That proves the held activation stays out of the open, the live order, and that one occurrence is permitted between create and pause (the documented window).

## (5) Mutants (the two new tests; the full joint file where noted)

Killed: evidence persisting across connections (both tests fail); held create included in the startup batch; per-reminder ordering of the held pause removed; live hold removed before guard confirmation; resending `limits` on the reopen; dropping the guard configuration (both tests). Explicit-stop drain: removing `settled()` before `kill()` in `stop()` is **killed** by an existing joint test (`explicit stop adopts a starting connection...`).
Survived: marking a routine terminal from the `reminder_fired` event (the tests read the row through `get`, which refreshes from the harness, so a transient wrong cache state is never observed; unit-covered); the wake filter flag for held creates (`routineGuardConfirmed`), because the paused follow-up already excludes the entry from the wake in the held test (the unit test with an unpaused held create covers it); `settled()` before acting on the idle-stop reply (as in the one-off joint tests, only unit-covered).

## (4) Gaps against the brief and contract: NOT covered by a real-stdio test

I verified three of these by probe against the real harness (not committed tests); the rest are untested at this level.
- **Probed OK:** a different `unattendedTurns` value on reopen in a new process returns `invalid_config` (host stays stopped); the same value reopens fine; `"unlimited"` then `9007199254740991` and the reverse both reopen with `maxConsecutiveTurns: 9007199254740991`. These need to become committed tests.
- **Dispositions:** no `routine_disposition` event (`missed`, `catch_up_limit`, `overlap`, `expired`, `coalesced`) is asserted anywhere; missed-run policies (`coalesce`, `skip`, `each`) and `overlap` (`skip`, `queue`) are untested; expiry of occurrences and the authoritative terminal row after a counted expiry; the refresh path triggered by an `expired` disposition.
- **Calendars:** no cron routine, no timezone, no DST gap/fold, no explicit `startAt`, no `until`; `count`/`until` replacement; returned explicit `startAt`; replacement fence.
- **Held-activation split beyond create+pause:** held resume and held schedule replacement against old-calendar due work; offline cancel/pause beating due work in the startup batch for a routine (the startup-batch half of the split is only shown negatively, by the empty batch in the held test); a cold wake with routines.
- **Migration / blocked:** `routine_migration_blocked` and the blocked row with `timezoneMigration`; `unattended_guard_required` from a real harness (guard absent); `proof_budget`.
- **Failure paths:** `storage_failure` on a live routine change and on the startup batch (exact frozen retry, `reminder_batch_retry_exhausted`, `discardExhausted`), the create-then-fail marker; whether the runtime can force these was not attempted.
- **Refusals:** kind change (one-off to routine, `every` to `cron`) and routine options on a one-off are only unit-tested locally; no real-harness refusal.
- **Event path with real frames:** the joint helper injects `connect`, so routine events travel through the harness client; the production launcher plus the stdio filter with real `routine_*` frames is not exercised (the one-off production test exists, a routine one does not).
- **Overlap recovery:** only the guard-exhausted recovery is covered, not a recovery with an overlapping notice still running.

## Notes

- The acceptance file lives inside the existing one-off joint file; the title says 12 plus 2 tests. Splitting the routine acceptance into its own file would keep the one-off file's 20x repeats short and make the routine suite extensible.
- Both tests depend on the harness fake clock (`peer.time`), so they prove the library's behaviour against the real runtime's logic, not real wall-clock scheduling of a recurring job.
