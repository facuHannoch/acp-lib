# Re-review: R8 fix (`reminders-r8` f0e7420, then 25f9d2d) against a003ab6

Reviewer: clad2a-s. Clean `git archive` on `/dev/shm`; no `src/` edits; mutations on a separate copy.
Note: the head moved while I reviewed: f0e7420 (src + tests) then **25f9d2d (test-only: splits the G4 assertion so one entry cannot mask the other)**. I re-ran the gate and the G4 mutants on 25f9d2d.

Verdict: **approve.** D1, G1-G3, D2 and D3-D7 are fixed and each new test kills its mutant. One small residual (G4b below) and one display caveat (D3b); neither needs to
block the `joint-r8-rh2` merge. No source change is required from this review.

## Gate (25f9d2d)

- `tsc --noEmit`: exit 0. Plain `bun test`: **2,124 pass / 0 fail, 219 files, 35 snapshots** (R8 ebd2993 was 2,115/218), no `.snap` changed.
- The 11 new or changed tests, each **20x in isolation (220 runs, 0 failures)**; the G4 test re-run 20x on 25f9d2d as well.
- Protected files: agent-session 4,491, host 905, native/controller 590, controller 764, client 1,046, conversation-manager 1,012, agent 563, engine 1,034. None above ceilings.
- `src/native-harness/`: untouched (empty diff 4dc6e79..25f9d2d).

## Items

| Item | Fix | Mutants (re-run) |
|---|---|---|
| D1 channel-batch `invalid_params` must not quarantine | the retry now runs without reminders first; success then `rejectedBatch`, failure `restoreStaged(originals)` and rethrow. `stage()` records the originals; `restoreStaged` rewrites an entry only if it is still `maybe_sent`. Test: peer rejects the channel batch; open throws; journal equals the pre-open snapshot; `reminder_batch_rejected` not logged | no-restore killed; quarantine-first (old order) killed; no-quarantine-after killed |
| G1 idle stop sets `#stopped` | test asserts `host.explicitlyStopped === false` after the idle stop | killed |
| G2 `settled()` before acting on the stop reply | test delays `updateDeadline`, emits the deadline before the stop reply, asserts the host is still `running` and ports not disconnected until the write is released, then wake = the new deadline | killed |
| G3 logging | tests assert `reminders_due_revision_conflict` and `reminder_receipt_conflict` for `stale` and `conflict` | both killed |
| G4 routine/legacy off the wake | wake asserted per entry (25f9d2d) | **a** routine filter killed; **b** see residual |
| D2 stdio filter | `reminders-notifications.test.ts`: 1-byte chunks incl. split UTF-8, passthrough, unknown `reminder_future` and malformed `reminders_due` dropped; and a real child process through `launchNativeConnection` | filter off killed (2 tests); `notify` wiring removed killed; malformed no longer dropped killed |
| D3 no guessed expiry policy | rows with no history get `expiryPolicy: { kind: "unknown" }`; a schedule edit omits `expiresAfter` | revert to guess killed |
| D4 idle stop = `#lost` port path | `port.disconnected()` for each port after a successful idle stop | killed (same test as G1/G2) |
| D5 fail-fast R7 schema 22 | at version 22 the migration checks `staging_order`, `receipt_version`, `reminder_staging_clock` and throws "created by an unreleased R7 build; recreate the database for R8" | removing the check killed |
| D6 exhausted wake, nothing outstanding | `#wakeFailure` (diagnostic, `host.failure`) replaces `failed`; `reminderWakeState` reads `failed` so the supervisor stops re-arming; cleared (budget reset) by the next `ensureStarted()`; with outstanding work it still goes `failed` and calls `port.failed` | three mutants killed (always-fail, no clear, no wake-state) |
| D7 | documented in `rejectedBatch` ("a successful retry isolates the reminder batch; quarantine it whole") | n/a |

The notification filter is also stricter now: it matches `reminder*_` kinds by prefix and drops them even if malformed (before, a malformed reminder frame ended the connection); field types
of the four wire events and the `reminder_changed` channel match are validated.

## Residual and caveats (non-blocking)

- **G4b:** the `Number.isSafeInteger(schedule.at)` guard in `isWakeSchedule` survives (54/54). The production behaviour is correct (I probed it: a valid reminder plus a malformed string-`at`
  legacy entry keeps the valid wake, 1,120,000; without the guard the wake becomes `null`), because one non-finite candidate poisons `Math.min` in `deriveReminderWake`. The test covers
  each malformed entry alone, where NaN also serialises to `null`. Add a "valid + malformed legacy keeps the valid wake" assertion, and consider making `deriveReminderWake` skip non-finite candidates (defence in depth).
- **D3b (display):** for an unknown-policy reminder the provisional expiry after a schedule edit is `null`, the same value that means "no expiry". Until the harness row arrives a consumer
  reading `expiry === null` sees "never expires". Prefer the existing `{ kind: "harness_default" }`-style marker (or an explicit `unknown`) for the provisional display. The wire is correct (no `expiresAfter` sent).
- After D1's restore-and-rethrow a following `not_found` from the open starts the fresh create with no reminders (`staged = []`); the entries are back to `pending` and go out on the next live dispatch. Fine, but worth knowing for R-H2.
- `host.failure` now also returns the wake diagnostic while `state` is `stopped`; no production code reads it elsewhere (grep), only the tests.

Nothing here requires a change to the commit being merged into `joint-r8-rh2`; G4b and D3b can be follow-ups.
