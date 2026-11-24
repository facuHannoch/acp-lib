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
- R5 docs follow-up (`a9b3ae1`) reviewed by clad2a (`bc0836b`): every note landed accurately, nothing overclaims; two
  nits (`earlierEvidencePending` means awaiting confirmation that the earlier turn ended; "unavailable host" missing from
  the changelog's unavailable cases).
- R6 step 0 (`dd67d45`, [report](reports/11-23-REPORT-R6-grounding.md)) reviewed by clad2a (`ddec61c`): three of the four
  items are real gaps, the stall clock is not. **Withdrawal is a real defect**: `withdrawWaiting` removes an accepted,
  unclaimed item and settles the prompt cancelled, but the input is already in the harness inbox, so the harness still
  runs it; the wire already has `channel/withdraw` (idempotent: withdrawn or taken) and the host calls it, the session
  never does. Decisions (coordinator): withdrawal is the priority, `not_found` on a pushed submission is UNRESOLVED
  (the stdio server dispatches concurrently; a withdraw can overtake its push), a durable "withdrawing" intent and a
  close/reopen test, an audit of `interrupt({clearQueue})`, stop and close, and a `taken` answer follows the turn; the
  stall clock step is dropped (a regression test only: `stallLimitsFor` returns false limits for backend supervision);
  receipts and the real-process stream test stand (partial text then the hold tool); a new public event variant needs a
  changelog, guide and exhaustive-switch check; the size extraction comes first (`agent-session.ts` is at its ceiling).
  Question to haurness-l: is per-channel order guaranteed between push and withdraw, or a tombstone planned (no harness
  change needed). cod2a amends the brief and starts step 1.
- haurness-l answered the R6 ordering question: **option (c)**. The harness wire makes no per-channel ordering guarantee
  between `channel/push` and `channel/withdraw` for in-flight requests on one connection, and no tombstones for unknown
  ids will be added. `withdraw` is atomic against take for a committed inbox item; `not_found` means no matching item
  was committed at lookup time (for an unresolved push: not a cancellation, not proof of non-acceptance); only
  `withdrawn` confirms cancellation of an accepted item; `taken` reports that take won. Rules for R6: retain the
  withdraw intent across reconnect, suppress push replay once withdrawal is requested, resolve via the push outcome or a
  bounded reconcile/retry with the original channel and item id; test the ambiguity with a controlled peer or barrier
  (no claim of reproducing overtaking on the stock server). Documented as an assumption in R6.
- R6 step 1 in from cod2a (the amended brief `069efba`/`b13417c`, the pure extraction `5602999`, the withdrawal
  `592a2c1`, report `81574bc`, the R5 doc nits `e7d90e6`) and reviewed by clad2a (`4240f02`): the withdrawal protocol is
  correct (intent before the request, push replay suppressed, `taken` follows the turn, `not_found` unresolved, a
  controlled-client ambiguity test, eight of nine mutations killed; coordinator gate 1,659 in 156 files, sizes at or
  below ceilings, harness tree untouched). Three fixes before it passes: (1) decision: stop and close must best-effort
  `channel/withdraw` the conversation's submitted, unclaimed items (bounded, then reject): clad2a measured that after
  stop an accepted unclaimed input was run by the harness in a new unobserved turn (real spend after stop); document
  `taken` and a down host; (2) the handle rejection is an untyped error where stop used to settle cancelled results: a
  typed error or the cancellation result, and a changelog line; (3) the surviving mutation (interrupt clearing
  submitted native inputs). Minor: clear `withdrawing` once `taken`; the changelog should say the default submission
  store is memory.
- R6 complete from cod2a: step 1 `592a2c1` (withdrawal) with the shutdown follow-up `212e462`; receipts `76cd233`; the
  real-stdio stream gate `ee78c68`; final report `2e1869f` (coordinator gate on `2e1869f`: typecheck clean, 1,668 in 158
  files green RAM-backed, sizes at or below ceilings, harness tree untouched). clad2a's reviews (`4240f02`, `3466c64`):
  shutdown re-check clean (a silent host with six unclaimed items takes 1,015 ms: one shared grace); receipts correct
  (two conversations with interleaved steers: no bleed, no duplicates, monotonic); the stream gate deterministic
  (50 of 50). One required decision: stop now REJECTS a running native prompt with `NativeInputStoppedError` where it
  used to settle `{ status: "cancelled" }` with the partial text. Decision (coordinator): narrow the rejection to inputs
  never taken by a turn; a running (taken) prompt keeps the previous cancelled-result behaviour; changelog accurate;
  report notes that a real-process strict prefix can't be scripted. Then a short check and the pre-alpha with R5's docs
  and all of R6.
- R6 stop narrowing (`ac33f2d`, report `ac09144`) checked by clad2a (`80736cb`; coordinator gate 1,670 in 159 files green,
  sizes unchanged). The discrepancy: clad2a was wrong, cod2a was right: on `a9b3ae1` a stop mid-turn returned
  `{ status: "cancelled" }` with EMPTY text, no messages and no metering record (the records had "Partial reply.");
  `2e1869f` rejected; `ac09144` returns cancelled with "Partial reply.", one message and a cancelled metering record.
  So it IS a (benign) change from the old behaviour and the changelog must say so (a mid-message stop still returns
  empty text). Mixed stop and close, a 30-round take-wins race, pre-submission prompts and the typed error only for
  never-taken inputs all verified. Three fixes: the changelog; a stop racing an in-flight `message_completed` gives
  `AgentSessionOperationError` where `a9b3ae1` returned cancelled (settle it as cancelled); a test for the `taken`
  answer during the grace (the `noteTaken` mutation survives).
- R6's last follow-up (`92a02d2`, report `fde102b`) checked by clad2a (`8e11514`): **R6 approved**, with two small items
  (coordinator gate 1,671 in 159 files green RAM-backed). Side by side on `a9b3ae1`, `ac09144` and `fde102b`: a stop
  mid-turn after a completed message now returns cancelled with the partial text and a cancelled metering record (was
  empty text and no record); a stop with the completion held settles cancelled with empty text (a regression to
  `AgentSessionOperationError` in `ac09144` fixed); a streamed message stopped halfway is identical on all three;
  mixed stop and close and a 30-round take-wins race clean. Open: in the held-completion stop, `fde102b` drops a
  completion arriving after settle, so nothing is persisted although the harness committed the message (the older
  commits persisted a failed record): asked cod2a to verify that the next open's recovery restores the reply exactly
  once (test and changelog) or persist it; plus a test for the late-completion guard and the changelog's metering
  sentence. The pre-alpha waits for that short follow-up.
- The stopped-reply recovery (`1b1472d`, report `97b44e3`) checked by clad2a (`3aaa53a`): clean for the case it targets, **R6
  approved**. On `fde102b` a stop with the completion held left only the in-progress snapshot after a reopen though the
  harness had committed the message (a real loss); now the exact stopped turn is checked within one five-second
  deadline and the committed reply persisted by provider id (the caller still gets cancelled with empty text). One
  record across two same-Agent reopens, a late live completion and two new-Agent opens; a silent host: stop 5,009 ms;
  nothing committed: no record; two conversations: no cross-attribution. A narrower case is not restored at stop (a
  second conversation's turn whose events were also in flight: restored on a new Agent open); three survivors (the
  deadline, the provider-id dedupe, the unknown-turn check); the worst-case native stop with a silent host is about 6 s.
  **Gate passed** ([gate](../.plan-execution/status/11-23-GATE-R6.md)): 1,672 in 159 files. `pre-alpha` built with R5's
  docs and all of R6.
- R6's last follow-up (`f45fdab`, report `bb87489`) checked by clad2a (`ee20196`): approved (coordinator gate 1,675 in 160
  files green RAM-backed). The Bun 1.3.14 issue reproduced: `AbortSignal.timeout(2000)` used by two sequential requests
  that each add and remove an abort listener never fired in 6 s (exactly 2,000 ms with a listener left attached); the
  one explicit timer fixes it (5,002 ms across requests); the full-stack worst-case stop took 6,023 ms; the three
  surviving mutations killed; one more survives (removing `clearTimeout`: a leak test needed). A related finding in R5's
  ledger reader: `NativeUsageLedger.readTurn` builds its 15 s budget from `AbortSignal.timeout` and uses it for every
  page, so a hung later page is bounded only by the client's own 30 s timeout. Small fix assigned to cod2a (a single
  timer, a two-page test, leak tests, drop the "when the submission is still tracked" qualifier, grep for other uses);
  then the pre-alpha.
- The ledger deadline fix (`a058cce`, report `6e6930c`) checked by clad2a (`24b26d2`): clean. A 1.5 s budget with page 1 at
  300 ms and page 2 silent now rejects at 1,502 ms (it never fired in 8 s before); an endless run of slow pages rejects
  at 1,501 ms; no timer is left (the process exits in 0.07 s); no `AbortSignal.timeout` remains in `src`, `test` or
  `smoke-tests`; the leak mutations are killed. Coordinator gate on `6e6930c`: 1,678 in 162 files green RAM-backed, sizes
  unchanged, the harness tree untouched. **Spec 2 (R1 to R6) is complete**; the final `pre-alpha` is built. One nit
  (a pre-existing metering test hangs instead of failing if the timer regresses) is assigned.

### 2026-11-23: spec 2 merged; release documentation

- The user merged `pre-alpha` (`510e2a7`: R5 step 2b and its follow-ups, R5's docs and all of R6) into alpha. Spec 2 (R1
  to R6) is complete; the only commit not in alpha is cod2a's test guard `8ba7662` (a bounded guard on a metering test).
- Release preparation for trying `~agents` end to end: a type-check of `agents-core` (libs/agents) against the new tree
  in a scratch copy found four migrations it needs (`defaultPermission` removed in favour of `permissions`; the launcher's
  new `native-harness` kind; `connection` is now the interface, use `harnessConnection()`; a persistence context type
  gained fields). The consumer guide is stale (`defaultPermission` examples; "scripted harness" wording; no sections for
  permissions and events, `providerStart`, the orchestrator, worker delivery, receipts); `CHANGELOG-controller-interface.md`
  isn't in the package's `files`; the pack holds 513 files (4.6 MB) including 103 internal design docs. The user asked for the
  guide and a migration note from 0.12.1 to now; version, tag and pack exclusions still wait for the user. cod2a writes,
  clad2a reviews, on `release-docs` and `release-docs-reviews` (from alpha `510e2a7`).
- Release docs (`da4e0c0`: `CONSUMER_GUIDE.md`, `MIGRATION-0.12-to-0.13.md`, the `files` allowlist, the report) reviewed by
  clad2a (`0cac532`): accurate and nearly complete; the new guide examples compile and run; a real 0.12.1-written schema-16
  database opens at schema 21 twice and 0.12.1 then refuses it; the scratch type-check numbers confirmed (112, 125, 13 in four
  groups, restored byte for byte). Fixes before release: (1) the byte-identical baseline proves types only: agents-core's own
  tests fail on alpha until its test doubles gain `harnessConnection()` (`steer-delivery.test.ts` 9 pass to 1,
  `user-chat-acceptance.test.ts` 11 to 9); name the doubles in the note; (2) `README.md` still documents the removed
  `defaultPermission`, ships in the package, and its Quick start fails to compile; (3) `PersistenceCapabilities.channels` is a
  required member new since 0.12.1 (list every new required member); (4) split the checklist into breaking changes vs new
  features and add the verified surface (no export removed: 828 in 0.12.1, 913 in alpha, all kept); (5) unlisted type-level
  breaks (`MeteringProvenance.source`, the adapter types widened to `Adapter | NativeAdapter`, `PromptHandle.withdrawAsync`
  required, `AgentEvent` widened); (6) the guide lacks the worker event kinds, the delivery states and an experimental label
  on the orchestrator. Packaging, for the user's decision: the pack is 515 files, 4.61 MB, with no secrets; it ships
  `src/native-harness/.res` (internal docs, a marketing draft, sandbox transcripts), 708 KB of harness tests, twelve files
  containing the author's absolute path, and a smoke-test README link that points outside the package.
- Release docs fixes (`b8d627b`) re-checked by clad2a (`8964e86`): clean, **the release docs are done**. All six items landed;
  the list of newly required members is complete (`PersistenceCapabilities.channels`, `PromptHandle.withdrawAsync`,
  `AgentEventBus.subscribeWorkers`); the README Quick start compiles and runs; agents-core's types return to the 0.12.1
  baseline byte for byte and its two runtime tests return to full pass with the documented test-double edit. **Gate
  passed** ([gate](../.plan-execution/status/11-23-GATE-release-docs.md)): 1,678 in 162 files. Combined with cod2a's test
  guard `8ba7662` into `pre-alpha`. Alpha had moved by two docs-only commits (the reminders and routines spec).
- The user asked to merge `aiagent/haurness-l` (seven commits beyond alpha: context stages 3 and 4, harness instructions and
  session management, CLI start options and debug tools; 102 files, mostly the harness tree). Trial merge into the release
  candidate (`merge-haurness-l`, `f32c5a2`; `pre-alpha` stays at `d407820`): one content conflict, in the orchestrator spec's
  durable native completion paragraph (their side is an older wording; kept this branch's). Coordinator gate on the merge
  (`TMPDIR` in RAM): typecheck clean; 1,677 pass and **1 deterministic failure** (20 of 20 alone): `test/native/checkpoint.test.ts:1209`
  "operator stdio reads stay bounded on 10,000 records, catch-up retries from the committed position" expects zero full
  storage snapshots; it passes on `aiagent/haurness-l` alone (16 of 16 in that file) and on `pre-alpha` alone. Cause (from the
  RPC trace `push, status, push, modelCalls, status`): acp-client's R5 turn-close pull calls `session/model-calls`, whose
  harness handler makes the storage take a full snapshot (O(history)), which their bounded-reads work forbids. The fix
  belongs on the harness side (a focused, paged `session/model-calls` read). Harness suite on the merge: 381 pass, 0 fail.
- haurness-l confirmed the finding (`session/model-calls` takes a storage snapshot; the existing `readCalls` also decodes the
  full SQLite model state) and assigned the focused, bounded read to Cod1a (Clad1a reviewing); the wire stays (`after` and
  `limit`; our reader keeps filtering by channel and turn). The merge of `aiagent/haurness-l` is held until the reviewed SHA;
  Cod1a told the patch base (`aiagent/haurness-l`) and the combined verification state (`merge-haurness-l`, `f32c5a2`: the
  10k checkpoint test plus `bun test ./test`).
- The bounded `session/model-calls` read (Cod1a: decision `e45c097`, code `31ffb79` on `aiagent/haurness-l` `7fa4075`; trial
  `0df01b0` on `f32c5a2`) approved by Clad1a. Coordinator gate on `0df01b0` (`TMPDIR` in RAM): typecheck clean, root 1,678 and
  harness 382 green, the 10,000-record checkpoint test passes (0 of 10 failing; it failed every time on `f32c5a2`), snapshots
  unchanged. **Gate passed** ([gate](../.plan-execution/status/11-24-GATE-haurness-l-merge.md)). The new `pre-alpha` is the
  release candidate merged with `aiagent/haurness-l` and the fix; the previous one is kept as `pre-alpha-prev`.
