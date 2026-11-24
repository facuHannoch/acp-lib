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
