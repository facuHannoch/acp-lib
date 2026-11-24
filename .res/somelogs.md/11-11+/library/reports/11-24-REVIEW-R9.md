# Review: R9 routines, library side (`reminders-r9` at 5c485da)

Reviewer: clad2a-s. Clean `git archive` of 5c485da on `/dev/shm`; no `src/` edits; mutations and probes on separate copies. Reviewed against 0032 + pin `c8facc2`, my 12 conditions (`11-24-REVIEW-R9-conformance.md`) and core-p's rulings. (The first pass at c71bfa5 was superseded by the new head; this report is on 5c485da.)

Verdict: **do not approve yet: one real bug (a persisted marker can brick every later start) and two behaviours that contradict your rulings (content dedupe of routine events; routine terminal state on `reminder_expired`).** Everything else in the conditions is implemented and, with three exceptions, mutation-proven.

## Gate

- `tsc --noEmit`: exit 0. Plain `bun test`: **2,182 pass / 0 fail, 226 files, 35 snapshots** (matches cod2b-t).
- Joint real-stdio file (one-offs): **20/20 whole-file runs green**, 12 tests each time. Routine real-stdio acceptance awaits the approved harness runtime.
- New or changed tests (17: 14 in `reminders-routines`, the held-wake test, the schema-22 old-row decode test, the transport-shim test): **each 20x in isolation, 340 runs, 0 failures.**
- Ceilings: host 909/909 (zero net), native/controller 591, agent-session 4,527, others unchanged. `src/native-harness/` untouched vs alpha (empty diff). SQLite schema version still 22 (no bump).

## Conditions, one by one

| # | Condition | Result |
|---|---|---|
| 1 | table rebased on the pin | done (conformance report grew by 26 lines) |
| 2 | local cron shape-only | done in 5c485da: five fields of `[0-9*,/-]` only (the first revision had a full bounds parser; replaced). Mutant allowing letters: killed |
| 3 | kind change rejected before any write | `invalid_schedule` for one-off/routine and `every`/`cron` changes (service, before enqueue) |
| 4 | negotiation before sending `limits.unattendedTurns`; `invalid_config` and missing capability non-retryable | negotiation: done (`configForOpen` throws `HarnessIncompatibleError`, validates the value before marking any entry sent). Non-retryable: implemented (`terminalStartupError`: `#reopen` pops the budget and fails; the wake path records a diagnostic) but **untested**: removing either branch survives all 74 tests (below) |
| 5 | frozen batch composition, bound, exhaustion; live `storage_failure` keeps ids | done: the batch is stored in the wake-index JSON (`startupRetry`), replayed exactly for 3 attempts, then `reminder_batch_retry_exhausted` (terminal); live `retryKey` reuses the same reminder id and changeId. Freeze, bound (3 to 4), and retryKey mutants: all killed |
| 6 | no `invalid_params` strip for `storage_failure` | done (storage failure returns before the strip path) |
| 7 | first-open table, held predicate with the wake filter in one commit, evidence never persisted, terminal outcomes, create-then-fail marker | held predicate and wake filter: done, all mutants killed (see below). Evidence is in memory per connection only and reset by every `initialize`: confirmed. Marker: **bug B1** |
| 8 | no tuple dedupe; event order | order: preserved (disposition before fire, migration event before the row). **Dedupe: violated (D1)** |
| 9 | event plumbing | allowlist, required fields (except `count`/`reason` presence, see below), stdio filter regex `^(reminders?|routine)_`, host route: done; allowlist and regex mutants killed |
| 10 | routine fire leaves the routine active; rows round-trip | fire exemption mutant killed; rows decode `remainingCount`, `missedRuns`, `overlap`, `timezoneVersion`, `timezoneMigration`, explicit interval `startAt`. Expiry events: **D2** |
| 11 | gate | above |
| 12 | docs | S4 verified below |

Rulings: no local one-off cap (still removed); ONE routine minimum = the negotiated `minIntervalMs` for interval, first start and `until` (mutant moving the first-start check back to the 2-minute lead: killed); typed adapter confined to `routine-wire.ts` (see below).

## Findings

**B1 (bug, reproduced). The "replacement attempted" marker can brick every later start.** `openOrCreate` persists `replacementAttempted = sessionId` before `session/create`. If that create fails for any reason other than success (probe: `transport_closed`; a timeout is the same path), the marker stays. On the next start `open` returns `not_found` again (the session was never created) but the code only creates when `!replacement`, so it rethrows `not_found` on every start from then on. Probe: first start `transport_closed`, marker stored, second start fails with `not_found`, `creates === 1`. The marker should only force "treat as replacement when it is later observed", never block the create; clear it when the create failed without publishing (any non-`storage_failure` error), or make the guard `!== configuredId` apply only after a published create.
Add a test for exactly this sequence (create fails with a non-storage error, next start creates).

**D1 (contradicts the ruling "no tuple dedupe"). Routine events are deduped by content.** `sync.ts` keeps `routineEvents` and suppresses a `routine_disposition`/`routine_migration_blocked` whose field set was already seen in the session. Probe: two identical dispositions delivered through `notification`: **1 of 2 reaches the consumer.** Two tests pin the suppression ("suppresses exact live duplicates", and the dispositions-before-fires test fails when dedupe is removed). The pin says these events are live-only with no contractual tuple id; the two delivery routes are alternatives, not duplicates; and a hold that is repaired and recurs with the same versions would be silently dropped. The set is also unbounded for the session. Remove the dedupe and change the two tests.

**D2 (risk, probe). A routine goes terminal on `reminder_expired`.** The cache handler maps `reminder_expired` to `status: "expired", nextRunAt: null` for any reminder; only `reminder_fired` has a routine exemption. Probe: a confirmed active routine row, then a `reminder_expired` event: the cached row becomes `expired` with no next run. If the harness emits `reminder_expired` for an expired occurrence of a routine (0032 counts expired occurrences and gives them a disposition), the library would mark a live routine dead until the next refresh. Apply the same exemption (rely on `reminder_changed`/the authoritative row for routines) and ask haurness-l whether routines emit `reminder_expired` per occurrence.

**D3 (untested, behaviour looks right). `invalid_config` and `HarnessIncompatibleError` must not burn the restart budget.** Both mutants (remove the `#reopen` terminal branch, remove the wake-path terminal branch) survive. Add a scripted-peer test: open fails with `invalid_config`, the host fails once, the budget is not consumed, explicit `restart()` retries. Note the behaviour change: `HarnessIncompatibleError` at open is now also terminal in `#reopen` (it used to be retried up to three times), which looks like an improvement.

**D4 (untested). Required-field check for dispositions.** Removing the `routine_disposition` required-field list survives (74/74); the `count` and `reason` validations are tested, the string fields are not. Add the table-driven frames the R8.5 review asked for.

**D5 (design note). `reminder_batch_retry_exhausted` has no escape hatch.** The frozen batch is kept in the wake index and re-used by every later start (each explicit start retries three more times), so a deterministic storage failure makes the host unstartable until the harness home or the journal changes; entries are `maybe_sent`, so `discardBlocked` cannot clear them. The guide says only that the batch "remains unacknowledged for the next explicit start". State the operator path (what to restore or delete), or give the exhausted batch a quarantine route after N failed starts.

**D6 (UX, accepted by ruling but verify docs). The pause or cancel after a held activation is held too** (`held.has(id)`), so: an offline create followed by pause is sent live in order and a due occurrence may commit between the two requests; an offline schedule replacement can take effect after overdue old-calendar work. Both are documented in S4 and covered by tests (killing `held.has(id)` and the coalescing change). The earlier `conflict` rejection was removed in 5c485da, so a user can now pause or cancel while an activation is pending; a cancel of an entirely unsent create erases it locally.

**D7 (adapter). Confined and temporary as asked.** The extended request/row/result/event types and the single `as unknown as RoutineTransport` bridge live in `routine-wire.ts` (`routineTransport` is the only cast; used from `recovery.ts` and `sync.ts`). The adapter builds every routine request with `satisfies RoutineChange` (compile-checked against the one-off harness type it extends). Not confined: `sync.initialize` re-declares `routines?`/`unattendedTurnGuard?` capability fields inline, and `negotiatedLimits` re-declares `maxRoutineCatchUp` in `AdvertisedReminderLimits`; both should come from the same file when the type-only harness widening lands. When it lands, delete the bridge and the extensions together; the cast will otherwise hide drift.

## Mutation results (reminders, routines, wake, wire, notification, idle tests, 74 tests)

Killed: held predicate (4 tests); wake guard flag; supervisor index confirmation flag; routine entries counted by the wake filter (5 tests); held-routine same-reminder ordering and the stop-coalescing rule; marker not set before create (the partially-published-create test); freeze removed; retry bound 3 to 4; retryKey reuse removed; routine fire marking completed; cron letters accepted; first-start minimum moved to the one-off lead; stdio filter regex; allowlist; dedupe removal (which, as noted, fails two tests that pin the wrong behaviour).
Survived: `invalid_config`/incompatibility terminal handling in `#reopen` and in the wake start (D3); the `routine_disposition` required-field list (D4).

## S4 docs (every claim and sample checked)

- Both samples compile with `satisfies ReminderCreate`; a deliberately invalid sample (`count` and `until` together) is rejected by the type, and `limits.unattendedTurns` types in `AgentConfig.harness.config` (a string value fails).
- Verified in code or probes: count XOR until, first occurrence = acceptance + interval and ten-minute minimum, cron five numeric fields with the harness doing the zone and spacing proof, `missedRuns`/`overlap` defaults, 600,000 ms minimum and caps (20, 10), the capability/effective-guard gating (`conversationCapabilities.routines` only after an executable open confirms the guard), `invalid_config` for invalid or differing values and `HarnessIncompatibleError` for an unsupported peer, `storage_failure` + same-id retry, `reminder_batch_retry_exhausted` after three attempts, `unattended_guard_required` as a harness block, the held-activation behaviours and their two caveats, event order, and "no migration/disposition replay". The error table, new event rows and the schema-22/format-8 sentence match the code; schema stays 22 and a pre-routine one-off journal row decodes unchanged (new test).
- Needs fixing: the guide must say routine authoring is unavailable until an executable open in this process has confirmed the guard, including offline after a restart, because the evidence is never persisted ("prior negotiation" is easy to misread); the exhaustion row needs the operator path (D5); and once D1/D2 are fixed, say that identical routine events are all delivered.

## Required before approval

1. Fix B1 and add the failed-create-then-restart test.
2. Remove content dedupe (D1) and update the two tests.
3. Exempt routines from terminal marking on `reminder_expired` (D2) and ask haurness-l; add the test.
4. Tests for D3 and D4; decide D5.
5. Docs edits above.
