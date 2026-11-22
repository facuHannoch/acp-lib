# Log: controller interface, verification pass

Spec: `11-11-SPEC-controller-interface.md`. The code is already implemented and merged (`9668cf7`, base `004cc7f`).
This pass takes it through the pipeline brief by brief (A1, A2, B1, B2): check the code against each brief, test
it, review it, and fix what the triage rule allows (`../.plan-execution/plan.md`). Written only by the
coordinator; reports and reviews are linked, not copied.

| Role | Agent | Branch |
| --- | --- | --- |
| Coordinator and gatekeeper | core-p | `controller-interface-verify-status` |
| Implementer | cod2a | `controller-interface-verify` |
| Independent reviewer | clad2a | `controller-interface-verify-reviews` |

All three branches start from alpha at `d11cd18`. The user merges into alpha after the final check. Fixes go back
into alpha before integration brief R1 starts (decided by the user, 2026-11-22).

## Entries

### 2026-11-22: setup

- Branches created at `d11cd18`; roles confirmed by the user.
- A1 assigned to cod2a (verification of the characterization tests).
- A1 report in from cod2a, `f020860` (report only; [report](reports/11-22-REPORT-A1-verify.md)): clean baseline at
  `d11cd18`, typecheck clean, 1,727 tests in 175 files (352 s); characterization file 35/35 three times, snapshot
  hash unchanged. Every case exercised; six marked "different" (other fixture or observation point). No fixes.
  Open: fixture names in the spec, the observation points for reattach and capabilities, explicit force stop, and
  a fixed 50 ms wait in the bridge test. Error notes: ID numbering order, the fixed PTY wait, sandboxed fixture
  connections.
- A1 sent to clad2a for review.
- A1 review in from clad2a, `d2ba93c` ([review](reports/11-22-REVIEW-A1-verify.md)): no blocking findings; all
  open points accepted for Limitations; characterization file 35/35 three times on a clean copy.
- **A1 gate passed** ([gate](../.plan-execution/status/11-22-GATE-A1-verify.md)): first full run had one failure
  (the bridge test timed out waiting for a status, load-dependent), second full run green, 1,402 tests in 131 files
  for `./test` (1,727 in 175 from the repo root). Flake recorded, left to the user.
- A2 assigned to cod2a.
- A2 report in, `c6c6a00` (report only; [report](reports/11-22-REPORT-A2-verify.md)): steps 1–4 present, phase
  order kept (readiness/acceptance reordered by the A2 review, as recorded), five required tests present,
  `agent-session.ts` 4,641 lines (target ~4,550, below 5,022). Typecheck clean. Full `./test`: run 1 three
  operation-lifecycle failures, run 2 one checkpointing/strategy failure, run 3 green (1,402 in 131 files). Four new
  error notes for intermittent failures. No fixes. Sent to clad2a for review, with the question whether any failure
  is a real race.
- A2 review in from clad2a, `b1d4a33` ([review](reports/11-22-REVIEW-A2-verify.md)): no blocking findings; three
  spec wording fixes; no race in `src/` behind the intermittent failures (load timeouts, and a wall-clock jump in the
  checkpoint test); the three affected files 45/45 four times.
- **A2 gate passed** ([gate](../.plan-execution/status/11-22-GATE-A2-verify.md)): full `./test` green on the first
  run, 1,402 in 131 files, 200 s.
- B1 assigned to cod2a.
- B1 report in, `79627f6` (report only; [report](reports/11-22-REPORT-B1-verify.md)): steps 1–4 present; full
  `./test` green first run (1,402, 181 s). Drift: the factory now also builds `NativeController`. Two native gaps
  reproduced offline: a native prompt drops a file part and submits only text (silent data loss, meets triage);
  an unsupported native handoff writes reset records and handoff events before refusing. Both need `src/`
  changes: escalated to the user. Sent to clad2a for review and independent confirmation.
- B1 review in from clad2a, `b93fbad` ([review](reports/11-22-REVIEW-B1-verify.md)): no blocking findings for B1.
  Both native gaps confirmed with an independent offline probe. Media: silent data loss, to be fixed;
  `NativeController.send` should throw `UnsupportedError` before any push when a message has parts the media
  flags don't allow. Handoff: a spec contradiction only (no stuck channel, no lost data); smallest fix is a
  `freshContext` check at the top of `runHandoff`, before `handoff_started`. B1 gate held until the user decides on
  the fixes.
- B2 assigned to cod2a (report only, in parallel with the decision).
- User authorized fixing the intermittent test failures (tests only: bridge, checkpointing/strategy,
  operation-lifecycle); queued to cod2a after B2. Media and handoff fixes still waiting on the user.
- B2 report in, `7c00cb7` (report only; [report](reports/11-22-REPORT-B2-verify.md)): full `./test` green on the first
  run (1,402, 165 s). The nine shared conformance cases run on the fake, HarnessController (lifecycle fixture, not
  echo) and NativeController. Gaps: steer not in the shared nine; fake usage never emitted; late output after force
  stop only weakly asserted (a probe shows the fake can get a late chunk recorded on the old turn); the fake's
  ended-turn cancel replays as cancelled; stale changelog lines. Sent to clad2a for review.
- cod2a started the flake fixes.
- B2 review in from clad2a, `e370f4f` ([review](reports/11-22-REVIEW-B2-verify.md)): no blocking findings. Late
  output after force stop: the session has no guard of its own, but real controllers never call the old handlers
  (probe: a flood fixture on a real HarnessController, force-stopped mid-stream five times, 0 chunks after);
  accepted, the spec should say dropping is the controller's contract. The fake's ended-turn cancel is a test-double
  bug. The changelog withdrawal bullet is wrong against the code. Both added to cod2a's test/doc batch, with the
  stale conformance header.
- B1 and B2 gates held: one combined gate will run on the commit with the fixes (the code under test is otherwise
  identical to `d11cd18`).
- User authorized both native `src/` fixes: refuse unsupported media in `NativeController.send` before any push
  (checked against the media flags, so M2 image support only flips a flag), and refuse an unsupported fresh handoff
  at the top of `runHandoff` with a bare `UnsupportedError`, before any event or record. Queued to cod2a after the
  test/doc batch.
- Test/doc batch in from cod2a (`d3f7544`, `6f7fddf`, `49aa652`, `a12a47d`, `3c6dc8f`, `66fa496`; report `f30f3e3`,
  [report](reports/11-22-REPORT-flake-fixes.md)): the bridge waits on events, the checkpoint deadline uses a
  monotonic clock, lifecycle bounds raised with event waits, the fake's ended-turn cancel fixed with a new case,
  changelog and conformance header corrected. No `src/` or snapshot changes. Each touched file five times green;
  full `./test`: run 1 four other timeouts (committed event bus tests, new error notes), runs 2 and 3 green, 1,403 in
  131 files. Sent to clad2a for review; cod2a started the native fixes.
- Flake-fix review in from clad2a, `189eea6` ([review](reports/11-22-REVIEW-flake-fixes.md)): no blocking findings;
  each fix removes its timing cause, except the two continuation tests, which only get a longer bound (accepted:
  they await real work and have no fixed delays); fixture changes opt-in; the new fake case fails on the old fake.
  The event bus and native host timeouts are load (default 5 s exceeded, teardown errors after); if they recur,
  give those files explicit bounds.
- Native fixes in from cod2a (`6f4c6c6` media preflight in `NativeController.send`, queued, steered and
  multi-message tests; `9bfaf27` fresh-handoff refusal before any event or record, bare `UnsupportedError`, options
  extracted to `src/handoff-options.ts`; report `9016c0c`, [report](reports/11-22-REPORT-native-fixes.md)). Two
  full `./test` runs green, 1,406 in 131 files; snapshots unchanged; `agent-session.ts` 4,641 → 4,604, `host.ts`
  761. Sent to clad2a for review.
- Native fixes review in from clad2a, `b3519fb` ([review](reports/11-22-REVIEW-native-fixes.md)): no blocking
  findings; the new tests fail on the old code; both probes now refuse. M2 note: native send pushes only text, so
  turning on image support must forward the parts in the same change.
- **B1 and B2 gate passed** ([gate](../.plan-execution/status/11-22-GATE-B-verify.md)) on `9016c0c`: two full
  `./test` runs green, 1,406 in 131 files; no snapshot changes; no large file grew.
- **Spec 1 verification complete.** Ready for the user to merge `controller-interface-verify` (and this log and the
  reviews) into alpha.

### 2026-11-22: rebase onto alpha `713a76a`

- alpha fast-forwarded `d11cd18` → `713a76a` (harness operator controls `95670a2`, long-running mock `e13b405`,
  callback policy names `aca1fe5`, generic external notices `f522072`), at the user's request through haurness-l;
  the spec 1 acceptance runs move to it. Operator controls replaced the `session/load` and `session/messages` wire
  paths. Trial merge with `9016c0c`: conflicts in `src/native/controller.ts` and `test/native/checkpoint.test.ts`.
  `host.ts` grew on alpha 761 → ~1,040 (not this pass's change).
- cod2a assigned the merge into `controller-interface-verify` (merge commit, no history rewrite), the conflict
  resolutions, a check of test assumptions on the new wire paths, and a full re-run; clad2a to review it.
- Not counted: generic notices are not the worker-backend recovery proof; durable worker delivery stays open
  (orchestrator O1, O3, O5).
- Merge in from cod2a, `4cd3ce9` (report `32d30d0`, [report](reports/11-22-REPORT-alpha-713a76a-merge.md)): both
  conflicts resolved, keeping both sides; the media preflight runs before the lazy attach and every push. Review
  from clad2a, `de0b059` ([review](reports/11-22-REVIEW-alpha-713a76a-merge.md)): no blocking findings;
  `NativeController.send` is the only library path to a push; no test assumes the old wire paths; alpha's
  rehearsal test is intermittent on alpha itself.
- **Gate passed on `4cd3ce9`** ([gate](../.plan-execution/status/11-22-GATE-alpha-713a76a-merge.md)): run 1 one
  unrelated failure (SQLite cross-process ownership), run 2 green, 1,426 in 132 files.
- **Spec 1 verification complete on alpha `713a76a`.** Ready for the user to merge.

### 2026-11-22: alpha `ac52dbc`

- alpha moved `713a76a` → `ac52dbc` (`27c7166`: alpha's rehearsal test stabilized with explicit barriers and deadline
  diagnostics, approved by Clad; `ac52dbc` its log). Test files only; trial merge with `4cd3ce9` clean. The
  deadline-before-settlement case is instrumented, not root-caused (haurness-l). cod2a to merge and re-run, clad2a
  to review, then the gate on the merge commit.
- Merge in from cod2a, `035b7d7` (report section `58389dd`); review section from clad2a, `a951e4e`: no blocking
  findings, `src/` diff identical to the previous merge, rehearsal 6 × green.
- **Gate passed on `58389dd`** ([gate](../.plan-execution/status/11-22-GATE-alpha-ac52dbc-merge.md)): 1,426 in 132
  files on the first run.
- Combined branch `pre-alpha` (implementation, reviews and status) for the user to merge into alpha.
