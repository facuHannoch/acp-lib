# Re-review: R9 fixes (`scratch/r9-sdk-e594870` at 4617b36)

Reviewer: clad2a-s. Clean `git archive` of 4617b36 on `/dev/shm` (re-pulled; the head moved from e7fc233 to 4617b36 while I reviewed, and this report is on 4617b36); no `src/` edits; mutations and probes on separate copies.

Verdict: **approve the fixes with one residual bug on the same recovery path (B1', reproduced) and three untested guards in `discardExhausted`.** All seven findings from my first R9 review are fixed and mutation-proven except where listed. B1' is a start-up brick that needs the unfrozen-batch case handled; it does not undo the B1 fix.

## Gate

- Root `tsc --noEmit`: exit 0. Harness `bun run typecheck` (`src/native-harness`): exit 0.
- Plain `bun test`: **2,188 pass / 0 fail, 226 files, 35 snapshots** (matches core-p's gate on e7fc233).
- Joint one-off real-stdio file: **20/20** green (12 tests each).
- The seven new or changed tests, each 20x in isolation: all green (140 runs).
- `src/native-harness/` vs the base: empty diff. Ceilings: host 909, native/controller 591, agent-session 4,527. Schema unchanged (22).

## Fix by fix (surviving mutants re-run)

| Finding | Fix | Result |
|---|---|---|
| B1 marker blocks create | `recovery.ts`: the marker no longer vetoes `not_found` to create; the marker still marks a replacement when open later finds the session; the test covers `transport_closed` and `timeout`, expects open/create/open/create and the marker cleared | mutant restoring the old veto: **killed** |
| D1 content dedupe | `routineEvents` removed; every frame is delivered | mutant re-adding dedupe: killed (2 tests, now asserting delivery of identical events) |
| D2 routine terminal on `reminder_expired` | routines are exempt from terminal marking for fired and expired; an `expired` disposition triggers `getReminder` and only the authoritative row can make the routine terminal | exempting only fired (old behaviour): killed; no refresh: killed. Removing the extra early `return` for expired survives, but it is behaviour-equivalent (only skips an unchanged observation write) |
| D3 non-retryable startup errors | two tests: automatic reopen stops on `invalid_config` and an explicit restart succeeds after correction (budget not consumed); a cold wake stops on an incompatible harness and a later explicit start is allowed | both `terminalStartupError` mutants: **killed** |
| D4 required fields | table test for the disposition string fields | mutant clearing the field list: killed |
| D5 operator path | `conversation.reminders.discardExhausted(id)` | see below |
| D7 negotiation types | `ReminderNegotiation` and `AdvertisedReminderLimits` now live in `routine-wire.ts`, derived from the SDK's `InitializeResult` and `ReminderLimits` types (the capability keys are `Extract`ed from the SDK type); the inline copies in `sync.ts` and `wire.ts` are gone; the only cast remains the single bridge in `routine-wire.ts`, no new one | confirmed by reading and by tsc |

## discardExhausted: misuse analysis

Behaviour: refused unless the host is `stopped` or `failed`; the repository requires the stored startup batch to be flagged `exhausted` (set after the third failed attempt, the same moment the error is thrown), the reminder to belong to the calling conversation, and the reminder to appear in the frozen batch. It removes from the journal only the change ids of that reminder that are in the frozen batch, removes only that reminder's entries from the frozen batch, and keeps the rest exactly (the exact remainder is asserted). The reminder's journal row keeps its high-water mark; later creates use a new random id, so a discarded id is never reused, and a later edit of the same id would take `highWater + 1`, above anything the harness saw. Probes and mutants:
- Discard before exhaustion is refused: the new test now covers the boundary, a stored (frozen) batch at the second attempt, where `discardExhausted` returns `false` and leaves the two entries intact. Mutant dropping the `exhausted` check: **survives the previous test file and is killed only by the new boundary lines** (verified by running the mutant against the e7fc233 test file: 80/80 pass; against the 4617b36 file: fails). So the commit is the one that pins this boundary.
- Only that reminder's entries are removed and the remainder preserved: killed (two mutants).
- Not pinned: the conversation-scope check, the host-state check (`stopped|failed` only) and the high-water preservation. Removing the scope check or the state guard survives all 80 tests; the high-water mutant is equivalent on SQLite (a zero high-water skips the upsert) but is not covered for the memory repository.

Is it safe for a `maybe_sent` entry the harness may already have applied? Not safe by itself, and the guide says so ("Discard removes local intent only. Earlier entries may already have committed on the harness, so check the authoritative row after reopening"). Concretely: the failed open stops at the failing entry, but entries before it can already have committed receipts. Discarding such a create leaves the reminder alive on the harness; the next open's sweep brings it into the cache as a confirmed row (it will still fire), and re-creating it under a new id produces a duplicate. An orphan is therefore a visible confirmed row, not a hidden one; a duplicate needs the operator to recreate before checking. Because the failing entry is not identified (no `error.data`), the operator has to find it by elimination; the supported loop is discard one reminder, start (three attempts), repeat. Two caveats not in the guide: later pending entries of the same reminder are not discarded, so a discarded create can leave a pending update that will come back `not_found` as a blocked entry (visible, clearable with `discardBlocked`); and the host-state check is not atomic with the write (a start could begin between them), which is minor.

## B1' (reproduced): a frozen, non-exhausted batch plus a lost session bricks every start

`recovery.ts` now rethrows `not_found` when `frozen && !replacement`, and `discardExhausted` is only allowed once the batch is flagged exhausted. Probe: a stored startup batch from a start that stopped after one or two storage failures (process killed, so no exhaustion flag), then the harness session is lost (open returns `not_found`): **every start fails with `not_found`; `discardExhausted` returns `false`; there is no operator path** (only editing the SQLite wake JSON). The exhausted case escapes (discard everything, the batch empties, the create is allowed). The frozen batch should be permitted to go through create exactly as it goes through open (that is the "create then open with the same batch" rule); the `frozen && !replacement` veto is the leftover of the pre-B1 logic. Add a test: freeze a batch, lose the session, start, expect a create carrying the same frozen entries and the marker set.

## Docs (e7fc233)

- "Routine authoring requires an executable open in this Agent process, including for offline writes after a restart. Guard evidence stays in memory and each connection obtains it from its own executable open": matches `RoutineAdmission` (reset on every `initialize`; `routineUnavailable` is checked before any offline routine write).
- The exhaustion path (stop the harness, `discardExhausted(reminderId)`, start again to replay the remainder; returns `true` when it removed that reminder's entries; the commit warning above) matches the code.
- "Identical frames are all delivered" and the `expired` disposition note ("the client refreshes the row to learn the remaining count, next run and terminal state") match D1 and D2.
- Add to the guide: that the failing entry is not identified and the recovery is by elimination, the duplicate/orphan consequence of discarding an entry that may already have committed (it says "check", not what happens), and that later pending entries of the same reminder remain.

## Required

1. Fix B1' and add the frozen-batch-plus-lost-session test.
2. Optional but cheap: pin the conversation scope and host-state guard of `discardExhausted` and the high-water on the memory repository; mention the stale pending entries in the guide.
