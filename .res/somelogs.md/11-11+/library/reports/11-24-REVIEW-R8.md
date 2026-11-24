# Review: R8 Part 2, reminders wire / wake timer / idle stop (`reminders-r8` at ebd2993)

Reviewer: clad2a-s. Clean `git archive` of ebd2993 on `/dev/shm`; no `src/` edits; mutations and probes on a separate copy.
Head re-checked before reporting: still ebd2993. Reviewed against 0031, the R8 brief, my 14 points (e204496) and core-p's rulings / plan round 10.

Verdict: **do not approve yet.** One real defect (collateral quarantine of innocent reminders) and four ruled behaviours with no test that would catch their removal.
Everything else in the 14 rulings is implemented and, where tested, mutation-proven. All fixes are small.

## Gate (my run)

- `tsc --noEmit`: exit 0.
- Plain `bun test`: **2,115 pass / 0 fail, 218 files, 35 snapshots**; no `.snap` changed (R7 head was 2,093/215: +22 tests in 3 new files).
- All 45 reminder-related tests (R7 file 23, wire 9, wake 6, idle 7): **each 20x in isolation, 900 runs, 0 failures.**
- Protected files: agent-session 4,491 (= baseline/ceiling), host 897 (down from 909), native/controller 590, controller 764, client 1,046, conversation-manager 1,012,
  agent 563, engine 1,034. None above ceilings.
- `src/native-harness/` untouched: empty diff 4dc6e79..ebd2993.
- Extraction-only commit `cefe832` is a pure move: `#launch` -> `launchNativeConnection` in `native/connection.ts`; a whitespace-normalised diff of the old method vs the new
  function shows only indentation and `this.#config`/`this.#log` -> parameters. No behaviour change.

## Rulings 1-14

| Ruling | Implemented | Proven |
|---|---|---|
| 1 no local one-off cap | yes (`perChannel` is routine-only, local cap removed) | R7 cap test replaced |
| 2 event union without collisions | local `reminder_intent_{recorded,confirmed,blocked,discarded}`, wire `reminder_changed/fired/cancelled/expired`; no shared kind | test "separate live intent and wire events"; CHANGELOG note |
| 3 cache without journal FK, staging column, schema 22 in place | yes (`reminder_cache` standalone, `staging_order UNIQUE`, `reminder_staging_clock`) | wire test seeds agent-created rows; R7 real v21 upgrade test still passes |
| 4 never brick the open | local per-entry validation + quarantine, rejected batch quarantined and not resent, 100 cap and 900 KB frame budget | mutants killed (see below); **defect D1** |
| 5 no spin on a past deadline while running | supervisor arms only for `stopped`/`starting`; 1 s floor; shared restart budget | `running-eligible` mutant killed (5 tests), budget mutant killed |
| 6 unsupported/routine entries off the wake | yes (`supported === false`, `"at" in schedule` filter) | unsupported is redundant-guarded; **routine filter untested (G4)** |
| 7 receipt/row ordering | `observation` counter + `observedAtSend` + `receiptVersion`; receipt seeds only if nothing was observed since send | both mutants killed |
| 8 new reminderId for a blocked create | `update` of a blocked never-applied create is `not_found`; create always `randomUUID()` | covered in wire/service tests |
| 9 session replacement | `OpenResult.sessionId` or fresh create; unacked `maybe_sent` back to `pending` (frozen wire kept), rows flagged `unreconciled`, fence reset | both mutants (never / on every reconnect) killed |
| 10 `routines_unavailable` | thrown for `every`/`cron` creates and schedule edits before any write; legacy routine entries quarantined | create refusal tested; legacy path untested (G4) |
| 11 explicit grace 300000..86400000 | local bounds from negotiated limits | killed |
| 12 idle stop without the explicit-stop flag | `#idleStop` never touches `#stopped`/`#stoppingExplicitly` | **untested (G1)** |
| 13 `reminders_due` before acting on the stop reply | `await reminderSync.settled()` before closing; notifications are queued synchronously from the transform | **untested (G2)** |
| 14 close/stop semantics | `Agent.close()` closes supervisors first and the stored wake remains; explicit `stop()` keeps the wake armed; owner-only arming via `ownsReminderWake` | mutants killed (close, owner, stop-end-refresh) |

Also verified: 60 s clamp with 1 s floor (mutant killed), early wake / backward jump recheck (killed when both checks are removed; each is individually redundant), one explicit
timer (no `AbortSignal.timeout`), strict payloads (`acceptedAt` on create killed), batch order by staging order and 100-entry chunking, replay of exact receipts before high water,
conflict/stale recorded blocked, `invalid_cursor` budget of 3 then `unreconciled`, completed sweep marks absent rows `missing` (never while an entry is unresolved),
events and sweeps for deleted conversations ignored (store guard killed), fire dedupe killed, harness-owned `blocked` row state allowed to update/resume.

## Mutation results (45 tests, 4 files)

Killed (35): stage order; batch 101; rejected-batch quarantine; reject-and-retry; local quarantine; receipt order; receipt version; replacement never / on every reconnect;
fence mismatch; fire dedupe; orphan guard (store); sweep attempts; completeSweep; explicit grace bounds; create `acceptedAt`; supervisor running-eligible; no 60 s clamp; both
wall-clock rechecks removed; no restart budget; close supervisors; owner-only; explicit-stop refresh; idle: no wait for `ensureStarted`, window max, held channel/reminder
intents, pending approval; sending entries without marking `maybe_sent` (hangs, i.e. caught).

**Survived:**
- G1 `#idleStop` sets `#stopped` after `{stopped:true}` (ruling 12): 45/45 pass.
- G2 remove `await reminderSync.settled()` before acting on the stop reply (ruling 13): 45/45 pass. The existing test ("reads deadline notifications ahead of the reply") does not slow the
  deadline write, so ordering is never actually at risk.
- G3 equal-revision mismatch log and `stale`/`conflict` defect log removed: 45/45 pass. The brief says "ignore and LOG".
- G4 `"at" in schedule` wake filter (legacy/routine entries must not wake): 45/45 pass. No test creates a routine-shaped journal entry; there is no legacy R7-shape test at all.
- Redundant or benign (not gaps): orphan guard in `notification` (duplicate of the in-transaction check), `reminderWakeState` masking during an explicit stop, `eligible()` re-check
  after the index read (covered by the `wake()` checks), local-busy re-check in `#idleStop` (covered by `window()`), explicit-stop guard in `#idleStop`.

## Findings

**D1 (defect, confirmed by probe): `invalid_params` caused by something other than the reminder batch quarantines innocent reminders.** In `openOrCreate`, any `invalid_params` with staged
entries calls `reminders.rejectedBatch(staged)` before the retry. I made the peer reject the CHANNEL batch with `invalid_params` (a `HarnessClientError`): the open still throws, and the
already-journaled reminder ends up `blocked / invalid_params` and has to be discarded and recreated by the user. Order the recovery so the quarantine happens only when the retry without
the reminder batch succeeds (otherwise restore the entries to their previous state and rethrow). Add the probe as a test.

**D2 (untested real path): the stdio notification filter has no test.** `separateReminderNotifications` and the `notify` wiring in `launchNativeConnection` are the only way `reminders_due` and the
four wire events reach the host with the real transport (the bundled transport validates and would tear down on unknown kinds). The scripted peer bypasses both. I probed it by hand: correct
across chunk splits, passes other frames through untouched, consumes only `reminders_due` and the four reminder event kinds; a malformed line throws and ends the stream (same as the bundled
transport). It needs a unit test (split chunks, passthrough, malformed), since an R-H2 regression here would silently kill the connection.

**D3 (minor): rows with no local history get a guessed expiry policy.** `fromWireReminder` without a prior derives `duration` or `unlimited` from `expiresAfter` even when the harness defaulted it, so a host
schedule edit of an agent-created reminder shows a provisional expiry from a duration while the wire sends no grace (the harness recomputes). Confirmed rows are corrected by the harness row.

**D4 (minor): idle stop skips the loss-path cleanup.** `#lost` calls `port.disconnected()`; `#idleStop` only nulls the connection, stops approvals, kills and sets `stopped`. Ports are idle by
construction, but the parity is undocumented and untested (no test observes a port after an idle stop and a restart).

**D5 (note): the in-place schema-22 change leaves an R7-era 22 database inconsistent.** `CREATE TABLE IF NOT EXISTS` does not add `staging_order` or reshape `reminder_cache`; a dev database created by
`pre-alpha-r7` fails on first use. Accepted by ruling (R7 unreleased); say so in the notes, and consider failing fast with a clear error instead of an SQL error.

**D6 (note): a wake that exhausts the budget turns the host `failed`.** `startForReminder` -> `#failReopen` flips a healthy idle-stopped host to `failed` and calls `port.failed(...)` on every
conversation, so consumers see failures until `restart()` for a background timer's sake. This matches the brief ("then surfaces `HarnessUnavailableError`"), but confirm it is intended.

**D7 (note): one `invalid_params` reject quarantines the whole staged batch** (up to 100 valid entries) rather than bisecting; acceptable given local pre-validation, but D1's fix makes it safer.

## Required before approval

1. Fix D1 and add the channel-batch probe as a test.
2. Tests that kill G1, G2 (delayed deadline write so the wake armed after the stop reply uses the new deadline), G3 (assert the logs), G4 (routine and legacy-shaped entries produce no wake and no wire).
3. Unit test for the stdio notification filter (D2).
4. Answer D5/D6 in the notes; carry D3/D4 as known limits or tests.
