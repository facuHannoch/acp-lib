# Re-review: R7 follow-up (`reminders-r7` at 4cf07a9) and the startup-channel flake

Reviewer: clad2a-s. Clean `git archive` of 4cf07a9 on `/dev/shm`; no `src/` edits; mutations on a separate copy.

Verdict: **approve.** All requested items are fixed and now covered; the flake is pre-existing and unrelated to R7. One minor test gap remains (below), not blocking.

## Gate

- `tsc --noEmit`: exit 0. Plain `bun test`: **2,093 pass / 0 fail, 215 files, 35 snapshots** (2,081 + 12 new tests); no `.snap` changed.
- Reminder test file: 23 tests; whole file green; **each of the 23 tests 20x in isolation: 460 runs, 0 failures**.
- Protected files: agent-session 4,491 (exactly at the ceiling, not above; was 4,490), native/controller 590, agent 563; none exceed ceilings.

## Surviving mutants and findings from my report

| Item | Result |
|---|---|
| M1 drop `maybe_sent` from wake | now killed (`a maybe-sent change still contributes after recomputing the wake`) |
| M12 drop paused exclusion | killed (`a paused change has no validation wake and resume restores it`) |
| M17 remove setter from channel `desire` tx | killed (`SQLite channel desire sets the suspension fence in its transaction`) |
| M18 remove setter from `confirmChange` | killed (`SQLite channel confirmation sets ...`) |
| M19 recompute expiry on every edit | killed (`text edits, pause and resume do not drift default expiry`, default policy, clock advanced) |
| Finding 2 validation wake dominance | kept as designed and now pinned: `validation wakes use the earlier of launch deadline and due time`, plus a code comment that R8 must rate-limit a past wake through its restart budget. Acceptable; carry it into the R8 brief. |
| Finding 3 accessor | fixed: no owner now throws `ReminderError` (`reminders_unavailable` for native, `reminders_unsupported` otherwise). Mutant (remove the throw) killed. |
| Finding 4 terminal reminders | fixed: update/pause/resume of cancelled/completed/expired give `conflict`; a repeat cancel returns the confirmed view without writing; unknown id stays `not_found`. Mutant killed. |
| Finding 5 startAt / 0 ms | fixed: `every.startAt` needs the 2-minute lead (99,999 / 100,000 / 219,999 rejected, 220,000 accepted); expiry duration must be > 0. Both mutants killed. |

Also verified: the delete mutant (`persistence.transaction(remove)` removed) is killed; removing the 21 -> 22 migration step kills 18 tests.

## Coverage gaps from my report

- **Events:** `reminder events reach observers after the journal commits` reads the committed row through a second readonly connection at each emit and asserts
  the exact sequence created / confirmed / changed / blocked / cancelled / confirmed with stored state. Good.
- **Accessor and capabilities:** real owned native and ACP conversations: native `reminders: true`, ACP `false` with typed `reminders_unsupported` and no provider
  launch; state shared with `agent.reminders.list()`; the ownerless case is tested.
- **Real 21 -> 22 upgrade with data:** the test gunzips a stored schema-21 file (552 KB; I confirmed `schema_migrations` = [21], 1 conversation row, no
  `reminder%` tables), opens it with `SqliteAgentPersistence.open`, checks the conversation survives, versions are [21, 22], reminders list empty. Real file, real
  data. (Provenance "created by f0eb7d8" is asserted in a comment, not provable from the file; the content checks above hold.)
- **SQLite delete rollback:** a trigger aborts the conversation soft-delete; reminders, wake, channel intent and conversation all roll back, then succeed after
  the trigger is dropped. Real atomicity, not a stub.
- **Wake pin:** present (above).

Remaining minor gap: **F4b**, removing the `conflict` for an update/pause/resume while a cancellation is pending or maybe_sent survives (23/23 pass). The terminal
test only covers confirmed-terminal states. Add one assertion (update after `cancel` with the cancel still in flight). Not blocking.

## The startup-channel flake: pre-existing, not caused by R7

Test: `src/native-harness/test/startup-channel-changes.test.ts`, "an invalid batch is rejected whole and leaves every channel as it was" (`pending [] vs ["a2"]`).

- Cause by reading the test: after the rejected batches it calls `load` and expects `pending: ["a2"]`, but the harness is recovering that input concurrently
  (`until(... turn_ended ...)` follows the status assertion), so on a slow run `a2` has already been consumed. It is a timing race inside the harness's own
  in-process fixture.
- The test imports only `src/native-harness` and its helpers; **R7 changes nothing under `src/native-harness`** (empty diff, f0eb7d8..4cf07a9) and nothing in the
  acp-client persistence wrapper is reachable from it.
- Empirical, same test file, 8 tests per run, f0eb7d8 vs 4cf07a9:
  - Under load (14 CPU busy-loops on 12 cores): **f0eb7d8 16 of 60 runs failed, 4cf07a9 20 of 60.** Every failure is the same test with the same diff.
    The difference is within noise.
  - Unloaded, 50 runs each: **f0eb7d8 1 of 50 failed; 4cf07a9 0 of 50.** So the flake exists on the baseline even without load.
- Conclusion: pre-existing race, not an R7 regression. Worth a separate fix (wait for the recovered turn before reading `status`, or assert pending as `[]` or `["a2"]`)
  but not part of R7.

## Carry to R8

Rate-limit/back off a past validation wake; log equal-revision mismatch; the `live` seam still has no `AgentConfig` binding; list the widened `AgentSessionEvent`
union in release notes.
