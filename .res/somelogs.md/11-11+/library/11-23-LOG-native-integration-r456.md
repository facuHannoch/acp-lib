# Log: native harness integration, R4–R6

Spec: `11-11-SPEC-native-harness-integration.md`, "Remaining work: implementation plan": R4 (ACP cancellable connect and
`providerStart`), R5 (native usage and billing-grade metering), R6 (small gaps from the integration log), in that
order (decided by the user, 2026-11-23). Rules: `../.plan-execution/plan.md`. Written only by the coordinator.

| Role | Agent | Branch |
| --- | --- | --- |
| Coordinator and gatekeeper | core-p | `integration-r456-status` |
| Implementer | cod2a | `integration-r456` |
| Independent reviewer | clad2a | `integration-r456-reviews` |

All three branches start from alpha at `fe7d28c` (the orchestrator through O3b, O5b and O6 step 2 merged). Baseline:
`bun test ./test`, 1,589 tests in 149 files, green with `TMPDIR` on `/dev/shm` (gates use a RAM-backed `TMPDIR`: on disk,
different tests time out under machine load). R4 is an outline: its step 0 grounds the code and writes the full brief.

## Entries

### 2026-11-23: setup

- Branches created at `fe7d28c`; R4 (grounding and the full brief) goes to cod2a when the live run is done or waiting on
  the user.
- From here the coordinator keeps both tracks on this status branch (`integration-r456-status`, which now contains
  `orchestrator-status`); the orchestrator log is `11-22-LOG-orchestrator.md`, this file is for R4–R6.
- R4 step 0 in from cod2a, `ba36596` ([report](reports/11-23-REPORT-R4-grounding.md); the full brief); review from
  clad2a, `b6b9378`: accurate, ready to implement, no blockers. Verified: `stop()` reaches only the installed client;
  `reconnect` installs before it validates; `setMode` publishes the replacement before tearing down the source; a
  handoff target's stop is unreachable while startup hangs; the Agent-close ordering gap is real (the initial create is
  in neither `openings` nor `live`). Eight additions: bypass `bringUp`'s auth-preserving catch on cancel; guard
  `onCrash` by attempt identity; dispose a late `launcher.prepare` result; PTY in or out of scope; a post-await check
  before every install; a second start while one is in flight; keep the optional caller signal; assert the child pid
  is dead. Size gate: the attempt registry in a new module; `controller.ts`, `client.ts` and `agent-session.ts` must
  not grow; A1 hash unchanged. **R4 released** (after cod2a's small orchestrator fixes).
- R4 steps 1–3 in from cod2a (step 1 `83e6d3d`/`2b49b7c`; step 2 `0c4d12e`; step 3 `504eaf1`: `providerStart` and the
  `deferred` reopen status; report `ec298c5`); clad2a reviewed all of it (`7e651f9`, `0371dc6`): meets the brief, no
  blockers (60 randomized race rounds and 40 close rounds: no late install, no leaked process; sizes: session 4,495,
  client 1,046, controller 764, manager 1,012; the manager baseline at `fe7d28c` is 1,013, so that gate is met by one
  line). **Coordinator gate failed** on a clean copy of `ec298c5` (`TMPDIR` in RAM): typecheck clean, 1,613 pass and
  1 failure: step 3's new test `checkpoint recovery > creates and seeds a new provider session when the recorded one is
  missing (first use)` (the recorded recovery checkpoint id differs from the one the test read); alone it fails 3 of 6
  runs, so it is a race, not load. clad2a's full run passed (timing). cod2a to find the cause (a test race or a real
  bug in first-use recovery), prove it with 20 isolated runs, and fold in clad2a's notes. Lesson: run every new test of
  a commit 20 times in isolation.
- The R4 follow-up (`491cf66`, report `cb6f959`: the first-use recovery test fix, a test race found by clad2a: a queued
  checkpoint lands before the first-use recovery but after the eager one; plus clad2a's R4 notes) passed the coordinator
  gate: 20 of 20 isolated runs of `test/checkpointing/recovery.test.ts`, the full suite 1,616 in 151 files, RAM-backed.
  clad2a is reviewing it.
- R5 step 0 in from cod2a, `4e07939` ([report](reports/11-23-REPORT-R5-grounding.md); the full brief): the in-turn
  parity gate works on the existing wire; native `billing_required` certification needs harness work (token category
  semantics, reported cost, a sealed per-turn manifest, between-turn ownership). Heads-up sent to haurness-l; with clad2a
  for review.
- clad2a reviewed the R4 follow-up (`195e929`): every note addressed, every new or changed test 20 of 20 isolated; new
  finding: `test/acp-connect-cancellation.test.ts` > "stop cancels ACP setMode and reaps its process" failed 3 of 50
  whole-file runs on `cb6f959` (0 of 60 earlier). cod2a found the cause: the ACP leaf rejected with
  `ConnectionCancelledError`, then the outer attempt signal was aborted but its reason (and `throwIfAborted`'s thrown
  value) was undefined (the progress observer was not in the path); fixed in `d752262` (the typed cancellation is kept
  on the attempt; report `c2ba881`). Coordinator gate on `c2ba881`: 0 failing runs of 50, typecheck clean, 1,617 in 151
  files green RAM-backed; sizes unchanged (session 4,495, client 1,046, controller 764, manager 1,012). With clad2a.
- cod2a amended R5's brief per clad2a's five gaps (`f4d9fab`) and starts R5 step 1.
- The user merged `pre-alpha` (`ae71995`: the live-run files, the smoke runner hardening and the ACP busy-worker restart
  test) into alpha. Pending for the next one: R4 (`c2ba881`), the orchestrator follow-up (`1a769da`) and R5's brief
  amendment; R5 step 1 (`47e2750`, report `7e537af`; coordinator run `7e537af`: typecheck clean, 1,624 in 152 files
  green RAM-backed, sizes unchanged) awaits clad2a's review.
- R4 final reviews by clad2a (`1cc3984`: the cancellation fix holds: 0 of 50 whole-file runs, 84 random stops across
  seven paths, mutation-checked) and the orchestrator follow-up (`2cdc35e`: no findings). **R4 gate passed**
  ([gate](../.plan-execution/status/11-23-GATE-R4.md)): 1,618 in 151 files. `pre-alpha` rebuilt with R4, the orchestrator
  follow-up and R5's amended brief (R5 step 1 awaits clad2a's review).
- The user merged `pre-alpha` (`173e4e7`: R4, the orchestrator follow-up and R5's amended brief) into alpha. R4 is
  complete; R5 step 1 is with clad2a; 2a, 2b and 4 follow; then R6.
- R5 step 1 reviewed by clad2a (`fc655b2`): meets its gate, no blockers (the full suite 1,624 in 152 files; each of the
  seven new tests 20 of 20 isolated; the eight protected files exactly at their ceilings; three new files, 80, 110 and
  56 lines, referenced by nothing yet). Their independent probe over a real stdio harness (four scripted attempts, a
  tool turn with three calls and a retried transient failure): exactly four inferences staged with ids `1:0`, `2:0`,
  `2:1`, `3:0`, tokens matching the script (714 of 714); seven of eight mutations caught. So the existing wire is enough
  for the in-turn parity gate. **Step 1 gate passed** (coordinator: 1,624 in 152 files, RAM-backed). 2a released with
  five notes: a call-level seal test; an empty turn is not proven zero; a detached pull's request outliving the 15 s
  budget (30 s host timeout); serialize `pullTurn` per channel; nothing treats `native-harness-unverified` as verified.
- haurness-l (R5 harness dependency): the missing billing-grade accounting guarantees (provider and category
  semantics, a complete sealed per-turn manifest including failed attempts, between-turn ownership and admission) are
  scoped as a separate harness design owned by the harness track (Cod1a drafting, Clad1a reviewing, when scheduled).
  R5 stays on in-turn parity over the existing wire plus the refusal: native `billing_required` stays refused; method
  availability or parity alone is not certification; between-turn support is not claimed before a producer and bounded
  pull or idle behaviour exist. No harness work requested from our track.
- R5 step 2a in from cod2a, `f56de5e` (report `28da8d5`): the native pull connected to the turn's metering close on the
  existing record path; parity exact (three calls, four attempts, 714 tokens: 674 input and 40 output, matched against
  the script and the ledger; the other channel's 44 tokens did not bleed). Coordinator run: typecheck clean, 1,635 in
  153 files green RAM-backed; sizes at or below the ceilings (`agent-session.ts` 4,493, `host.ts` 909, `engine.ts`
  1,051). It edits two files in the harness tree (`src/native-harness/src/interfaces/client.ts`: an optional
  `AbortSignal` on `HarnessClient.request` and `modelCalls`; `test/helpers/scenario.ts`): asked haurness-l for review;
  held out of the next `pre-alpha` until they agree. With clad2a for review.
- R5 step 2a reviewed by clad2a (`2c5691e`): meets its gate, no blockers (1,635 in 153 files; the 360 harness tests; the
  ten new tests 20 of 20; all five notes closed; six rounds of two channels closing at once gave exact per-channel
  totals, 6,042 and 30,342, no bleed; a failed metering save gave no double count; nine mutations killed). Notes:
  document that undispatched turns are `unavailable`, not zero; a turn with unmeasured attempts is still
  `usage.status` "metered" (add a reason or a status); the `billing_required` refusal should name the capability; the
  harness client change needs haurness-l's confirmation (Clad1a reviewing). **Coordinator gate passed**; the next
  `pre-alpha` holds until Clad1a's verdict. 2b released, with haurness-l's constraint: no between-turn support claimed.
- Clad1a approved the harness client change in step 2a (`f56de5e`): `finish()` is settle-once on every path (pre-abort,
  response vs abort in both orders, timeout, transport close, send throw, `close()`; eight probe tests against a fake
  transport), with one item to add before alpha: harness client tests for the abort paths (none in the diff); and a
  doc note that `cancelled` means the caller stopped waiting, not that the call wasn't applied. cod2a adds both in a
  small commit before 2b; then `pre-alpha` can take 2a. (Clad1a also saw intermittent harness-suite failures under
  load, on the base too: not a regression.)
- C1/N1 (`2aff51c`: seven fake-transport client tests and the doc note) confirmed by Clad1a (the seven pass 5 of 5 runs and
  all fail on the base `7e537af`; nothing missing against their eight probes); the harness-side hold is released by
  haurness-l. **Gate passed** ([gate](../.plan-execution/status/11-23-GATE-R5-2a.md)). `pre-alpha` built with R5 steps 1 and
  2a; the exact SHA goes to haurness-l for confirmation before the user merges. R5 step 2b (`0fdb886`, report `9fb2b2e`;
  coordinator run: 1,639 in 154 files green, sizes unchanged) is with clad2a.
- haurness-l confirmed the exact `pre-alpha` (`b77c3d7`: R5 steps 1 and 2a and the harness client tests and doc; alpha
  `173e4e7` fast-forwards; source and tests identical to the tested `2aff51c`); it waits for the user's merge.
- R5 step 2b (`0fdb886`, report `9fb2b2e`) reviewed by clad2a (`38c5f33`): meets its stated gate (1,639 in 154 files; four
  new tests 20 of 20; the cursor from persisted evidence with interleaved channels, a restart and a gap; a failed final
  commit left a write-ahead record committed once, with no double count), **but not approved**: (1) a paid turn's usage
  can be lost silently: with both the staging write and the commit failing for turn 1, a later prompt gave 220 tokens
  instead of 330 with nothing flagging it (later closes read only their own turn id); (2) after one gap the cursor never
  advances; (3) four mutations survive (the cursor advancing without a terminal turn, no dedupe in `record()`, no recovery
  at close, the cursor ignoring its `channelKey`); (4) `agent-session.ts` 4,495 and `engine.ts` 1,059 grew past the 2a
  numbers. Decision (coordinator): a row behind the cursor is retired only once its outcome is durably recorded (accounted,
  or recorded as `unaccountedEarlierCalls`, or recorded as unmeasured for a terminal turn or a closed channel), never on a
  guess. Follow-up to cod2a; step 4 and R6 held.
- The user merged `pre-alpha` (`b77c3d7`: R5 steps 1 and 2a, the harness client abort tests and doc) into alpha. R5 2b's
  follow-up (`3ef44c2`, report `4bbefcb`: the lost-usage fix, the gap-retirement rule, SQLite schema 21; coordinator run
  1,646 in 154 files green RAM-backed) is with clad2a.
- R5 step 2b follow-up (`3ef44c2`, report `4bbefcb`) reviewed by clad2a (`d7edd6d`): recommends approval. Verified on a
  real schema-20 database written by alpha `173e4e7` (an ACP prompt plus a delivered worker assignment) opened twice:
  versions 20 and 21, one 21 row, every other table byte-identical, the worker delivery state intact; schema 21 adds one
  nullable column `metering_records.native_metering_proof_json` (idempotent). Probes over real stdio: both writes
  failing (in-process and after a reopen): the earlier 110 tokens show on turn 2's record as `unaccountedEarlierCalls`
  and are not repeated on turn 3; eight closes after a gap are bounded; a late-sealed attempt is counted once; a failed
  save during retirement commits once; two channels closing at once, exact. Nine mutations killed. Design point:
  those 110 tokens appear in no aggregate (totals 253 = 220 + 33; `unallocatedUsage` empty; coverage partial).
  Decision (coordinator): accrue earlier-unaccounted tokens once into the existing unallocated accrual, named
  "unaccounted usage of an earlier turn" (not between-turn support), and cap the proof column; then a short re-check;
  then step 4 (docs) and R6.
- R5 step 2b's final follow-up (`c271475`, report `147bd63`) approved by clad2a (`d93d139`, no findings): totals plus
  unallocated cover everything known to have been spent with no double count (turn 3: 253 attributed plus 110 unallocated
  = 363 after both writes failed; two channels closing at once exact); the proof cap tested at 127/128/129 ids and at
  the 32 KiB boundary; nine mutations killed; a record from the intermediate source still reads. **Gate passed**
  ([gate](../.plan-execution/status/11-23-GATE-R5-2b.md)): 1,649 in 155 files. `pre-alpha` rebuilt with R5 step 2b (the
  harness tree untouched). Step 4 (docs) and R6 released.
- R5 step 4 (docs and close-out) in from cod2a: `910b7fd` (the native source, the evidence shape, schema 21, pricing and
  failure behaviour, the two retention limitations: `CHANGELOG-metering.md`, `CONSUMER_GUIDE.md`), `d6c35b8` (the final gate
  result in the R5 report: 1,649 in 155 files); alpha `b77c3d7` merged at `9a0e0fd`. Nothing under `src/` or `test/`
  changed. With clad2a for a docs review; cod2a is writing R6's grounding.
- R5 step 4 docs reviewed by clad2a (`465552d`): accurate, no overclaim (no between-turn support, no certification,
  `billing_required` refused; the gate table and line counts exact; nothing under `src/` or `test/` changed; the new
  guide section is prose), but four sentences are imprecise and several limitations are missing (the harness-dependency
  list in the guide and changelog; `unallocatedUsage` means unaccounted usage of an earlier turn; a truncated proof can
  list an already-counted attempt as unmeasured; the schema change is one-way; `MeteringPreflightError`;
  `earlierEvidencePending`; where `state.totals` is read). Docs-only fix assigned to cod2a; then a short check and the
  pre-alpha with the whole of R5.
