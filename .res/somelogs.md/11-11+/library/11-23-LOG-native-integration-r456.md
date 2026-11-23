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
