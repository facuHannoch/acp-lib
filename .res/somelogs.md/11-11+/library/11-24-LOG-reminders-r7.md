# Log: reminders, acp-client library side (R7)

Plan: `11-24-PLAN-reminders-acp-client.md` (revision 5 and addenda). Brief: `briefs/11-24-BRIEF-R7-reminders-library.md`.
Roles: core-p coordinator (`integration-r456-status`), cod2b-t implementer (`reminders-r7`; cod2a-r was assigned first and
never started Part 2), clad2a-s reviewer (`reminders-r7-reviews`). Base: alpha `f0eb7d8`.

## Entries (2026-11-24)

- Part 1 grounding report (cod2a-r, `ced1eff`) approved; clad2a's review (`02945d1`) required: wake includes `maybe_sent`,
  client-allocated reminderId with high-water, memory `durable` bit, reminders-only delete test, and amended rulings (offline cron
  marker, validation wake, edit keeps expiry policy, suspended setter). Gate command corrected to plain `bun test`.
- haurness-l pinned the deadline fence (session-keyed, equal-revision mismatch flagged, open does not reset) and the acceptance
  anchor issue (`acceptedAt` stored and carried).
- Part 2 (cod2b-t, `1a5dd5f`, `6a2a4ea`): core-p clean-copy gate green (2,081/215). clad2a review `2671ad9`: not approved: 5
  surviving mutants, per-access service, terminal-state edits accepted, startAt/expiry validation, coverage gaps.
- Follow-up (`4cf07a9`): core-p gate run 1 had 3 failures plus one snapshot under heavy machine load (one was the harness approval
  test; the other two were not captured), run 2 on the same copy green: 2,093 pass, 0 fail, 215 files, 35 snapshots, no `.snap`
  changed; protected files not grown (agent-session 4,491 = ceiling). clad2a re-review `6810396`: APPROVE; all five mutants killed.
- Startup-channel flake ('an invalid batch is rejected whole...') is PRE-EXISTING (x60 under load: 16 failures on `f0eb7d8`, 20 on
  `4cf07a9`; unloaded 1/50 vs 0/50); a timing race in the harness fixture; needs a separate fix by the harness track.

## Carried to R8
Backoff for a past validation wake (restart budget 3/60 s, no spin); log equal-revision mismatch; the live request seam has no
AgentConfig binding yet; widened `AgentSessionEvent` union to note in release notes; add one assertion that update/pause/resume
while a cancel is pending/maybe_sent is refused with `conflict` (minor, non-blocking).

## R8 and R-H3 (2026-11-24)

- Decision 0031 (`34969fd`) released; brief R8; conformance report (cod2b-t `e0caeaa`), clad2a review `e204496` (14 points), core-p
  rulings and haurness-l clarifications (plan rounds 9, 10).
- R8 Part 2 (cod2b-t): `cefe832` extraction, `c47dae2` wire/reconcile, `af47cd1` cold wake, `423a3d4` idle stop, `ebd2993`
  hardening. core-p clean-copy gate on `ebd2993`: typecheck clean, plain `bun test` 2,115 pass / 0 fail / 218 files, 35 snapshots;
  protected files not above ceilings (host.ts 897/909); no change under `src/native-harness/`. clad2a review in progress.
- Harness R-H2 approved `d9f24b8` (`aiagent/cod1a-reminders-rh2`); R-H3 joint testing released. Merged into `joint-r8-rh2`
  (`5e98d46`): clean textually, FAILS typecheck at `src/native/recovery.ts(64)`: our `reminderChanges` entry type is not
  discriminated by op like the harness `CreateParams`/`LoadResultOpenParams`. Fix and joint real-stdio acceptance assigned to cod2b-t.
- R9 (routines) still needs a separate harness R-H4 contract review.

- R8 reviews: clad2a `a003ab6` (not approved: D1 plus survivors), fix `f0e7420`, test-only `25f9d2d`; follow-up review `4de27e9`: APPROVE.
  core-p clean-copy gate on `25f9d2d`: typecheck clean, plain `bun test` 2,124 / 219 files, 0 fail, 35 snapshots; host.ts 905/909;
  `src/native-harness` diff empty. cod2b-t's own R8-only run of `25f9d2d` hit the pre-existing startup-channel flake twice
  (approved harness d9f24b8 fixes that assertion); core-p's run did not.
- Joint R-H3 (cod2b-t): `joint-r8-rh2` `b01c096` = R8 `25f9d2d` + approved harness `d9f24b8` + protocol fix `5fa49cd` + the real-stdio
  acceptance file `reminders-joint.test.ts`. core-p clean-copy gate: typecheck clean, plain `bun test` 2,146 / 223 files, 0 fail,
  35 snapshots; host.ts 908/909, native/controller.ts 591/599, others at baseline; no harness source change against `d9f24b8`.
  cod2b-t: whole joint file 20/20 and each test 20/20; Clad1a independently confirmed the harness side at the same SHA
  (40/0 on the five reminder files, 3 extra joint runs). clad2a independent review of the joint tests: in progress.
- Non-blocking residuals (clad2a): G4b `isSafeInteger` guard in `isWakeSchedule` untested; D3b unknown-policy display expiry `null`.

## Alpha 4dad65e, R8.5 and R9 (2026-11-24)

- Alpha `4dad65e` = R7 + R8 + joint acceptance + docs, merged by core-p at the user's go-ahead.
- R8.5 typed harness client (`reminders-typed` `b2b4fbe`): clad2a approved (`reminders-typed-reviews`); core-p gate 2,164/225.
- R9 routines, library side, against decision 0032 (`973a522`) plus the approved pin `c8facc2`, SDK `e594870` + `4df4634` (Clad approved):
  cod2a-r conformance report `e7f1f6e`; clad2a conformance review `5dded26` (12 conditions, 9 missed rules); cod2b-t Part 2 stages and
  fixes; clad2a reviews R9 (`not approved`: marker-blocks-create bug, event dedupe, expiry terminal, gaps), R9 follow-up (one residual
  bug B1'), R9 final: APPROVE on `a55b574`. core-p clean-copy gate on `a55b574`: root tsc clean, plain `bun test` 2,191 pass / 0 fail /
  226 files, 35 snapshots; host.ts 909/909, native/controller 591, agent-session 4,527 (alpha's own); harness subtree identical to the
  approved SDK `4df4634`. Routine real-stdio acceptance awaits the independently approved R-H4 runtime (not available yet).
- Rulings kept: first-open split (non-activating changes in startup, activations held until THIS connection's open proves the guard;
  evidence never persisted); no routine event dedupe; routine expiry only via `routine_disposition expired`; local cron check is
  shape-only; ONE 10-minute minimum; guard setting optional with no default; `discardExhausted` operator path.

## R9 joint acceptance (2026-11-24)

- R9 library candidate merged into alpha (`15f27b1`) with the `"unlimited"` guard option; approved R-H4 runtime `174c7c4` composed onto it.
- Joint slice 1 (cod2b-t `ba2cb95`, reviewed by clad2a, Clad1a confirmed the harness side): integrated as alpha `51abd7f`. Gate: root tsc clean,
  plain `bun test` 2,228 / 233, 35 snapshots; harness subtree identical to the approved runtime.
- Joint slice 2 (cod2b-t `3447e64`, base `51abd7f`): clad2a APPROVE (no defects). core-p gate: root tsc clean, plain `bun test` 2,237 / 234,
  35 snapshots; only `test/native/reminders-routines-joint.test.ts` changed; harness diff 0. Covered with the REAL harness child: guard
  invalid_config/same value/"unlimited" both spellings; unattended_guard_required; missed/coalesced/expired dispositions with
  authoritative rows (no reminder_expired/fired for routine expiry); overlap skip after a crash; migration hold (event, blocked row,
  idempotent reopen); kind-change and routine-options-on-one-off refusals; offline cancel/pause beating due work; routine cold wake.
- Not covered real-stdio: catch_up_limit and `each`, overlap queue, until, explicit startAt, a cron routine firing, DST, migration
  proof_budget/repair/revalidation (the fixture is synthetic data: zone `Unavailable/Legacy`), held resume/replacement vs old-calendar due
  work, idle stop with routines, real storage_failure (no deterministic seam; covered by scripted tests). Surviving mutant: the stdio
  filter matcher alone (the client's own route delivers the same frames).
