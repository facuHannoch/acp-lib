# Independent review: A2 turn path

Reviewed implementation `524af30eaf0cf170a83ecc87b5cec35860ab0b5b`, A1 baseline
`9de0ca3`, and corrected beta spec `fcd1fd49b6bf844724fb86a3040b0866e0ec4488`.
A2 commits: `0383681` (step 1), `b5d13a9` (step 2), `d8c1fe2` (step 3),
`47d9931` (step 4), `cffce98` (snapshot-only), and `524af30` (report).

**Verdict: do not pass A2 or release B1.** The independently run final typecheck and
full suite are green, and the snapshot-only diff satisfies the exception. However,
there is a reproduced observable ACP behavior regression, an ineffective unknown-ID
guard in the dispatch path, and a fixed-delay test contrary to the plan. Return the
blocking findings below to the implementer. The independently reproduced pre-existing
snapshot race also needs the owner's decision; a green run does not remove that risk.

## Findings, ranked by severity

### P1 — Yielding before provider readiness changes prompt/force-stop behavior

**`src/agent-session.ts:2296`–`:2299`.** `controller.send()` emits `turn_started`
synchronously and returns an already-resolved promise, but the new `await` yields
before `ensureProvider()` begins. Previously `ensureProvider()` was called immediately
after the public event, before `prompt()` returned to its caller. A caller can now stop
the controller in that new gap, causing the subsequent `ensureProvider()` to reconnect
and dispatch a turn that previously failed. This violates A2's preserved operation order
and the spec's no-new-ACP-behavior requirement.

Independent offline reproduction: create a detached `AgentSession` with the existing
`echo-prompt-agent.ts`, call `const handle = session.prompt("hello")`, immediately call
and await `session.connection.forceStop()`, then await the handle. On A1 `9de0ca3`, the
handle rejects with `AgentSessionOperationError: AgentController is not started — call
start() first`; events are `turn_started`, `turn_failed`. At `524af30`, the handle
resolves `completed`, with `turn_started`, `provider_reconnected`, `turn_completed`.
The result was identical in four A1/A2 paired runs. The temporary reproduction script
is `/tmp/controller-a2-immediate-stop.ts`; it uses the offline fixture only. This is a
real scheduling difference, not a snapshot formatting issue.

Preserve the original readiness/dispatch semantics while meeting synchronous harness
turn reporting and acceptance requirements, and add a regression covering this boundary.
Do not change the snapshot to accommodate the new result. Investigate other interrupts,
stops, and listener-triggered activity at the same new scheduling point.

### P2 — The production unknown-message check is tautological

**`src/agent-session.ts:2292`; `src/conversation-turns/turn-run.ts:24`.** The session
calls `checkTurnRun(run, (id) => run.messageIds.includes(id))`; each value being
checked is necessarily in that very array. Consequently any new, unknown ID in a run
passes. `AgentController.send` (`src/controller.ts:308`) validates emptiness and
duplicates but has no independent known-message validation either. A bad combined run
can thus be announced with an ID no session message owns, contrary to the required
unknown-ID bug check and settlement contract.

The test at `test/conversation-turns/turn-path.test.ts:164` verifies the helper with a
separate hand-written `known` predicate; it does not exercise the predicate used by the
real pump. Validate against independently maintained or original queued-message state,
and add an integration-level test that injects or otherwise exercises an unknown ID
through the actual session/controller dispatch boundary. Preserve queue order and the
first-message turn ID.

### P2 — Finalization ordering test uses a fixed delay instead of an event barrier

**`test/conversation-turns/turn-path.test.ts:139`–`:145`.** The slow `afterPrompt`
test waits `Bun.sleep(100)` to give an incorrectly advanced queue an opportunity to run.
A heavily delayed wrong implementation can pass this timing window, and the execution
plan explicitly requires event-based waits rather than fixed delays. Use a bounded,
explicit test-controlled finalization gate and observe/verify queued operation ordering
around its release. Keep the assertion that both `turn_completed` and the next config
operation wait for `afterPrompt`; do not weaken it.

## Pre-existing managed-steer snapshot race: owner decision required

The implementer reports differing orders between `presentation_recorded` and
`metering_recorded` in the managed combined-steer A1 case. I independently reproduced
a mismatch on unchanged A1 `9de0ca3` on run 2 and A2 `524af30` on run 4 of the filtered
`managed two steer` characterization, with no snapshot update. In both of my failures,
the swapped events belonged to the **second, completed** turn: its assistant
in-progress `presentation_recorded` and `metering_recorded` reversed. The report's
example describes the cancelled first turn's settled tool, so the observed race is not
limited to that exact pair. Four and two trials are not a frequency estimate and do not
establish whether A2 changes the rate.

The race predates A2; the final suite below happened to pass. It still makes the
strict snapshot gate intermittent and can disguise an ordering regression. The spec
requires retaining ordering/IDs and using event-based synchronization, not sorting,
separating, deleting, or regenerating assertions to conceal the difference. The
implementer's option (b), separate per-kind sequences, weakens the cross-kind ordering
assertion and therefore needs an explicit user/spec decision; do not adopt it by
interpretation. Option (a) changes source/order outside the A2 constraints and likewise
needs the required scope decision; option (c) accepts intermittent failure and needs an
owner decision. A test/fixture barrier preserving the existing ordering assertions may
be viable if it genuinely establishes the required order, but feasibility was not
proven here. Escalate the tradeoff; no source or snapshot change was made in review.

## Step, scope, and ownership assessment

- **Step 1:** the extraction keeps the major phase sequence: managed metering preflight
  before durable records; detached append before metering; wrapped handlers, supervised
  dispatch, assistant records and metering, then owner finalization. Context in
  `src/conversation-turns/context.ts:44` is grouped by concern and does not pass the
  whole session, but is broad (roughly 35 members); this remains the spec's noted
  hidden-coupling risk. The A1 snapshots did not change through this step.
- **Step 2:** contracts include acceptance-returning `send`, optional `turnId`,
  `TurnTook` and the corrected event union; typecheck is green at the final commit.
- **Step 3:** controller reports synchronously, prepares without starting, and delegates
  prompt/output/cancel/force-stop through the prepared provider; internal prompts keep
  their supervisor path and no turn events. The supervisor subscribes before `prompt()`.
- **Step 4:** the session registers state before `send`, owns completion after
  `runTurn` finalization, abandons on failures, and clears steering/run state in
  `finally`. Combined-run causes and per-turn record IDs are covered. The added
  `await` changes a real operation-order boundary (P1); known-message validation is
  ineffective in the production call (P2). Backend-scheduled turns and `turn_took`
  handling are explicitly deferred to B2, as scoped, and have not been validated as
  functioning native behavior here.
- Scope check: no diff under `src/persistence/`, `src/agent/adoption/`, or
  `src/agent-conversation-continuation.ts` from A1 to the reviewed commit. Earlier
  beta merges are documentation only; the heartbeat fix was already in A1. Final
  `agent-session.ts` is 4,594 lines, below the hard 5,022-line acceptance limit.
- `git diff --check 9de0ca3..524af30` reports one trailing blank line at
  `src/agent-session.ts:4594`; minor formatting, not an independent gate blocker.

## Snapshot integrity and independent gate evidence

`cffce98` changes only `test/conversation-turns/__snapshots__/characterization.test.ts.snap`:
237 additions, no removals. An independent parser removed exactly 39 inserted
`cause: { kind: "messages", messageIds: [...] }` blocks immediately preceding
`turn_started`; the resulting bytes equal the `47d9931` snapshot exactly. Thus no
previous order, IDs, records, or text changed in that snapshot commit. Its final SHA256
is `d25f05a19cadeb8ff2a310ee85fca41d47323576bec64f39eb6025cc844aca1a`. A1 error
strings remain pinned. The step 1 and step 3 ranges show no snapshot changes.

| Check | Independent result |
| --- | --- |
| Final `bun run typecheck` | clean |
| Temporary tsconfig including new conversation-turn tests | clean |
| Final complete `bun test` | **1,139 pass / 0 fail, 114 files, 35 snapshots, 92.59s** |
| Snapshot-only commit | 39 cause blocks; exact prior bytes after removing those blocks |
| A1/A2 immediate force-stop comparison | reproduced four times each; outcomes differ as P1 |
| Filtered managed-steer snapshot | A1 fails on run 2; A2 fails on run 4; same independently observed swap |
| Step 1 and step 3 individual full-suite gates | implementer reports green; not independently rerun at those historical commits |

The numerical final typecheck/full-suite gates hold for this particular run. The
behavior, invalid-run validation and event-wait requirements do not all hold, so the
brief as a whole is not accepted. Historical step gate results are attributed to the
implementer, not silently claimed as independent checks.

## Limits and handling

Tests ran from isolated `git archive` copies under `/tmp`, with installed dependencies
linked and offline fixtures only. No snapshot was regenerated or loosened. No
implementation branch checkout, `src/` edit, live harness run, push, merge into beta,
or protected-path/worktree/process change occurred. The independent race probes ran
while the full suite was executing in a separate process using the same temporary A2 archive; their results show
possible orderings, not production frequency. A2 requires correction and another
review before the coordinator's gate; B1 remains held.

## Follow-up review — `524af30..babc5b1` (2026-11-13)

Reviewed fix `e7f2d79` and updated implementer report `babc5b1`. The earlier
findings and original gate evidence above are retained as history.

**Follow-up verdict: A2 is not ready for the coordinator's passing gate; B1 remains
held.** The original normal-path force-stop regression and unknown-ID membership check
are fixed, and the finalization test now uses a test-controlled event gate. However,
the session can treat a rejected send as a successful turn, the new membership check
does not establish exclusive ownership of a run, and the gated test's failure path
leaves its gate unresolved. The first independent full-suite run was also red on a
snapshot ordering mismatch in an additional case. Findings below should return to the
implementer; snapshot instability remains subject to the owner's decision.

### P2 — A send rejection after a synchronous turn report is discarded

**`src/agent-session.ts:2307`–`:2319`.** If a controller reports a matching
`turn_started` synchronously and then returns a rejected `send` promise, this branch
attaches a logging-only catch and continues to prepare and execute the turn. Thus the
prompt may settle successfully even though acceptance failed. A report before promise
settlement is not proof of successful acceptance for the general asynchronous `send`
contract. In particular, inferring controller scheduling policy solely from the timing
of an event couples it to a fact the interface does not expose.

Independent fault-injection reproduction (`/tmp/controller-a2-rejected-send.ts`):
wrap the real offline echo controller's `send` to emit the normal synchronous turn
report and then return `Promise.reject(new Error("acceptance rejected"))`. The prompt
resolves **completed** and the public events are `turn_started`, `turn_completed`;
the rejected acceptance is not reported to the caller. The current real
`AgentController.send` itself promises an already-resolved acceptance, so this probe
injects an acceptance failure rather than demonstrating a failure from the unmodified
ACP implementation. The handling is nevertheless unsafe at the new interface seam and
would hide a controller acceptance failure. A late rejection can also arrive after the
turn has completed.

Preserve the original synchronous readiness check while making actual dispatch and
settlement honor `send` acceptance, including synchronous turn reporting followed by a
rejection. Add a bounded regression asserting failure, no false `turn_completed`, and
proper turn abandonment/cleanup. Do not restore the prior P1 yield before invoking
provider readiness.

### P2 — Accepted membership does not prove message ownership by a run

**`src/agent-session.ts:2301`–`:2303`; `src/conversation-turns/turn-run.ts:24`.**
The independent accepted-ID set correctly rejects genuinely unknown IDs and removes
normal messages when their own promise settles. It does not check that every known ID
was taken from the queue into this run, that the run respects queue order, or that an
ID cannot occur in two runs. The assertion in the comment that queue order is checked
is therefore stronger than the implementation.

Independent fault injection (`/tmp/controller-a2-duplicate-ownership.ts`): with one
slow prompt and two separately queued prompts A and B, wrap `steering.prepareRun` only
for A to append B's still-queued accepted ID to A's `parts`. The guard allows the run:
its reported causes are `[first]`, `[A, B]`, then `[B]`; all three prompts complete,
and B's ID has appeared in two turns. This is a deliberately malformed internal run,
not a claim that normal `combinePrompts` currently constructs it. It shows the guard
cannot enforce the spec's one-dispatched-message/one-turn and queue-order invariants
against a run-construction bug, the class of bug the guard is intended to catch.
Validate against the actual messages selected into the run, or another independently
maintained ownership/order representation; add a dispatch-level regression for a known
but still-queued ID. Keep the existing unknown and duplicate tests.

Normal-path cleanup was independently probed using the existing offline echo and steer
fixtures: `acceptedMessages.size` returned to zero after successful completion,
provider failure, withdrawal, queue-clearing interrupt, combined steer fan-out, and
stop with a queued message (`/tmp/controller-a2-registry-probe.ts`). These tests and
inspection of each wrapped `resolve`/`reject` support cleanup for those paths; they do
not establish correctness for every injected malformed run or future backend scheduling.

### P2 — A failed event-gate assertion leaves cleanup waiting on the held turn

**`test/conversation-turns/turn-path.test.ts:170`–`:193`.** The fixed 100ms sleep is
removed and the success path uses a bounded wait for entry and a test-controlled
finalization gate. But the gate itself is released only after three assertions. If any
of them fails, `release()` is never called; cleanup calls `agent.close()`, which waits
for the still-held turn, and the queued config promise can reject without a handler.
The gate is not bounded on this failure path, contrary to the plan's bounded-wait rule.

I tested this in a separate archive with **only the test assertion changed** to expect
a deliberately wrong phase, under an eight-second process timeout. The intended
assertion failed, followed by an unhandled `configuration change cancelled before it
started` error and an `afterEach` timeout at about five seconds. No repository source or
snapshot was changed. Release the gate in `finally` (and observe/settle the queued
promise on failure) so a regression produces the intended assertion without hanging
cleanup. The success-path assertions check current queue state synchronously and final
observable order; they do not by themselves prove every possible asynchronously
advanced scheduler would have run before the test releases the gate.

### Snapshot ordering: additional independent full-suite failure

The first complete independent run at `babc5b1` was **1,141 pass / 1 fail, 114 files,
91.47s**. The failure was **Agent-owned `an internal command`**, not the previously
reported managed combined-steer case: the in-progress assistant message snapshot and
the metering record swapped order in both the committed bus and SQLite records,
including record sequence numbers. The committed snapshot was untouched. Targeted probes of this case passed 30/30 runs on unchanged A1 and 30/30 on the
follow-up; these results do not prove the mismatch is new or rule out a rare race. Its relationship to the already escalated managed
race and the earlier Agent-owned record-write race is unresolved; do not assert that
it is the same cause without further evidence. The implementer's reported 1,142-pass
run remains evidence of one green run, not proof that this ordering is deterministic.
An independent complete rerun passed **1,142 / 0, 114 files, 35 snapshots, 93.12s**.
Both results matter: the numerical full-suite check passed on rerun, while the first
full run demonstrates a still-unresolved intermittent ordering mismatch. No reordering,
sorting, or snapshot update is authorized by this review.

### Original findings and verification

- **Original P1, prompt then force-stop:** resolved for the observed ACP boundary.
  An independent replay of the original probe against the follow-up again rejects with
  `AgentSessionOperationError` and emits `turn_started`, `turn_failed`, matching A1.
  The new full-suite regression tests for this and listener-triggered stop pass. The
  rejected-acceptance finding above is a separate failure introduced by the chosen
  handling, not a reason to restore the old unconditional await before readiness.
- **Original P2, unknown-ID tautology:** resolved for unknown membership: IDs are
  registered at acceptance, checked against `acceptedMessages`, and deleted through
  each prompt's resolve/reject wrapper. The new injected-unknown dispatch test passes.
  Exclusive run ownership and order remain unverified and can be violated as above.
- **Original P2, fixed-delay finalization test:** the fixed sleep is gone and normal
  success-path order is asserted with a gate, resolving the delay concern. The
  failure-path cleanup defect above remains.
- Source typecheck and a temporary tsconfig including the conversation-turn tests are
  clean. All ten turn-path tests pass. The first complete run was red and the second
  was green, as stated; the red result is not erased by the rerun. The snapshot and normalizer diff from `524af30` to `babc5b1`
  is empty; the unchanged snapshot SHA256 is
  `d25f05a19cadeb8ff2a310ee85fca41d47323576bec64f39eb6025cc844aca1a`.

All probes used offline fixture agents and temporary archive copies, with no reviewer
edits to repository source or snapshots, no implementation checkout, no live harness,
push, merge into beta, or protected path/worktree/process change. B1 remains held.

## Second follow-up — `babc5b1..b74658d` (2026-11-13)

Reviewed fix `f54dc05` and updated implementer report `b74658d3cc8780aa7610cbf0a14ea4b3992557df`
against the follow-up above. The earlier findings and test results remain historical evidence.

**Verdict: A2 remains blocked; B1 remains held.** The independent numerical typecheck and
full-suite checks pass, and the previous three fault probes are addressed on their tested
paths. A rejected acceptance can still remain unsettled indefinitely while provider
readiness is pending, as independently reproduced below. The separately escalated A1
snapshot-order issue remains unresolved; this review does not decide or waive it.

### P2 — A rejected acceptance waits behind a hung provider reconnect

**`src/agent-session.ts:2315`–`:2329`; `src/agent-session.ts:3571`–`:3583`.** The
session now observes the `send` promise immediately, starts `ensureProvider()` without
the earlier pre-readiness scheduling gap, and awaits acceptance before dispatch. This
fixes the previously reproduced false success when readiness resolves. But the awaits
are sequential: `await this.ensureProvider()` must finish before `await accepted` can
propagate a rejection already known to the session. The attached empty catch prevents
an unhandled rejection without settling the prompt.

Independent offline reproduction (`/tmp/controller-a2-rejected-reconnect.ts`): start a
real detached session on the existing lifecycle fixture configured with
`LIFECYCLE_HANG_CONTROL=session/load` and persistent fixture state; force-stop the
provider; wrap the real controller's `send` to synchronously report its normal turn and
return a rejected acceptance promise; then prompt, causing the provider to reconnect
and wait on the deliberately unanswered load. After 500ms the prompt remains pending,
only `turn_started` has been observed, and `acceptedMessages.size` remains 1. Calling
`stop()` also remains pending after a further second, and the prompt still has not
settled. The offline probe itself was externally bounded at eight seconds and exited
with timeout code 124; no live harness was involved.

The send rejection is fault-injected: the unmodified current ACP controller guarantees
an already-resolved promise after its synchronous report. The hanging reconnect is a
real existing fixture behavior. This is an interface acceptance-failure and cleanup
race, not a claim that the unmodified current `AgentController.send` rejects. It
contradicts the follow-up's requirement that a rejected send cannot leave its prompt
unsettled and the plan's bounded-wait rule. If reconnect eventually fails first, its
error can also mask the already-rejected acceptance.

Start provider readiness synchronously to preserve the A1 boundary, but independently
observe and act on acceptance failure even while readiness is pending. Ensure the turn
is abandoned, its message and queue settle once, and any concurrently started reconnect
is safely handled or torn down without late unhandled work. Add a bounded regression for
rejected acceptance concurrent with held reconnect, including stop/cleanup. A simple
reordering that reinstates the original force-stop regression is not sufficient.

### Previous finding dispositions

- **Synchronous report then rejected acceptance:** fixed when provider readiness
  completes. The original fault probe now rejects with `acceptance rejected`, emits
  `turn_started`, `turn_failed`, and does not complete; the new regression passes.
  The pending-readiness race above remains open.
- **Original ACP readiness boundary:** the immediate prompt-then-force-stop probe
  again matches A1 (`turn_started`, `turn_failed`, rejected prompt). An additional
  microtask-scheduled force-stop comparison across A1, the prior follow-up, and this
  commit gave the same failure/event sequence. This covers those boundaries, not all
  possible operation interleavings.
- **Known-but-still-queued message:** resolved for the demonstrated malformed run.
  `src/agent-session.ts:2304` builds an independent queued-ID set; the registry tracks
  accepted order and dispatched state, and `checkTurnRun` rejects unknown, repeated,
  already dispatched, still queued, or out-of-order IDs. The prior injected duplicate
  ownership probe now rejects with `which is still queued`; the committed integration
  test additionally verifies the queued message subsequently runs once. Inspection
  confirms combined prompt fan-out reaches each original wrapped `resolve`/`reject`.
  A separate normal-path probe found registry size zero after success, provider failure,
  withdrawal, queue-clearing interrupt, combined steering, and stop. Acceptance-order
  checking is tied to the current FIFO/contiguous-steer policy; a future backend
  scheduler needs its own explicit semantics.
- **Gated-test failure cleanup:** resolved. Gate release is in `finally`, and the
  turn and queued-config promises are observed from creation. In an independent
  temporary archive, deliberately breaking the phase assertion now produced only that
  assertion failure in 137.67ms (266ms test process), without an unhandled rejection
  or `afterEach` timeout. No production source or repository test was modified.

### Independent checks and limitations

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean |
| Temporary tsconfig including conversation-turn tests | clean |
| Complete `bun test` | **1,144 pass / 0 fail, 114 files, 35 snapshots, 92.50s** |
| Turn-path tests in complete run | all 12 pass, including two added regressions |
| Snapshot/normalizer diff `babc5b1..b74658d` | empty |
| Snapshot SHA256 | `d25f05a19cadeb8ff2a310ee85fca41d47323576bec64f39eb6025cc844aca1a` |
| `git diff --check babc5b1..b74658d` | clean |
| `agent-session.ts` | 4,623 lines, under the 5,022 hard limit |

The complete suite passed on this run. It does not erase the independently observed
prior full-run Agent-owned internal-command ordering failure, nor resolve the separately
escalated managed-steer ordering race. No repeated stress run or claim about their
frequency is made here; no snapshot was changed or regenerated. Tests ran in temporary
`git archive` copies with offline fixtures. No implementation branch checkout, reviewer
source edit, live harness, push, merge into beta, or protected path/worktree/process
change occurred. Return the open acceptance race to the implementer; retain B1 hold
until the new review and coordinator gate and outstanding owner decisions.

## Third follow-up — `b74658d..1ec6710` (2026-11-13)

Reviewed fix `9e0f457` and implementer report `1ec6710`, especially its second
follow-up and open question 3. Earlier findings and gate results remain as history.

**Verdict: the independent numerical checks pass; a passing A2 gate is pending the
owner/coordinator decisions below. B1 remains held.** The prior rejected-acceptance
prompt-settlement defect is fixed, and the regression detects the previous behavior.
The prior concern also required bounded queue/stop cleanup: that portion is not
resolved for a permanently unanswered reconnect. The underlying ordinary stop hang
predates A2, so fixing it may change ACP behavior outside the A2 brief; do not silently
expand scope or claim the hang is new.

### P1 — Permanently unanswered reconnect leaves queue and stop unsettled

**`src/agent-session.ts:2328`–`:2333`, `:2365`–`:2369`; `src/controller.ts:263`–`:265`,
`:401`–`:420`.** Provider readiness now starts synchronously and is combined with
acceptance via `Promise.all`, so an acceptance rejection fails the prompt promptly.
If readiness remains pending, the queue operation intentionally waits for it after the
prompt settles, preventing a second reconnect. There is no deadline or reachable
cancellation in this path. If the in-flight `session/load` never answers, the queue
never advances and `stop()` waits for the active operation indefinitely. The controller
only installs its new client after `bringUp` resolves, so stopping the current client
does not necessarily terminate the connection being brought up.

Independent offline comparison (`/tmp/controller-a2-stop-held-comparison.ts`) uses the
existing lifecycle fixture with `LIFECYCLE_HANG_CONTROL=session/load`, persistent
fixture state and a force-stop before the prompt:

| Source / scenario | Prompt before stop | `stop()` after 500ms | Prompt after stop | Events / registry |
| --- | --- | --- | --- | --- |
| A1 `9de0ca3`, no injected send failure | pending | pending | pending | `turn_started` |
| A2 `1ec6710`, no injected send failure | pending | pending | pending | `turn_started`; accepted registry size 1 |
| A2, synchronous report then injected rejected acceptance | rejects `acceptance rejected` | pending | remains rejected | `turn_started`, `turn_failed`; registry size 0 |

These are bounded observations, not proof of an infinite wait by themselves; the code
has no timeout and the fixture never answers. The processes were explicitly ended after
the observations. No send failure was injected in the first two scenarios, confirming
the ordinary reconnect/stop hang on A1 and current code. The third scenario establishes
that the new fix settles the prompt and cleans its registry entry but leaves its queue
operation and stop waiting on the same readiness promise. It therefore only partially
resolves the cleanup requirement recorded in `f9919ad`.

The added regression releases the held load **before** calling stop. It proves the
reconnect is not duplicated, the queued message completes after release, and stop then
finishes; it does not test a permanently unanswered load. I also independently called
stop **before** releasing a held reconnect after an injected rejection, then released
it: stop completed, the controller was disconnected, the accepted registry was empty,
and events were `turn_started`, `turn_failed` with no `provider_reconnected`.

**Decision needed:** the plan says nothing waits forever, while A2 also prohibits new
ACP behavior and changes outside its scope. A bounded/cancellable in-progress reconnect
and its stop teardown may require an owner-approved separate fix or a spec/plan
clarification. The prompt-settlement improvement is valid, but the provider merely
answering or its process ending is not a time bound. Escalate this conflict and the
queue/stop limitation; do not silently waive it or treat the released-fixture test as
proof of permanent-hold cleanup. No source fix is authorized or made by this review.

### Dispositions and concurrent safety

- **Rejected acceptance during pending readiness:** fixed for prompt settlement.
  `Promise.all([ready, accepted])` rejects promptly and the session abandons the turn,
  emits `turn_failed`, rejects the handle, and removes its registry entry. Both
  promises have rejection handlers, and the separate readiness-settlement observer
  absorbs its later rejection. Waiting for an outstanding readiness before draining the
  next operation prevents concurrent reconnects when the provider eventually answers;
  the committed regression checks exactly one reconnect and a queued prompt completing
  after release. Permanent-hold cleanup remains the P1 issue above.
- **Regression sensitivity:** copied only the new test and its updated offline fixture
  into a separate `b74658d` archive. The test fails on prior source at its 2s bound
  waiting for the refused prompt (0 pass / 1 fail, 2.17s). The same test passes at
  `1ec6710` (1 pass / 0 fail, 199ms process time). The intentional fixture release in
  test cleanup allowed the prior-code run to exit.
- **Original ACP timing:** the implementer reports ten A1-matching boundary scenarios;
  the fix starts `ensureProvider()` before the `Promise.all` await. The original
  immediate force-stop test remains in the passing full suite. This is not a proof of
  every interleaving; no change in baseline behavior is inferred from passing cases.
- **Ownership, settlement, and snapshots:** no follow-up change to the accepted-message
  ownership checks or A1 snapshots. Previous follow-up's normal-path registry and
  malformed-run results still apply. The rejected prompt's entry was independently
  observed removed during held readiness. No snapshot or normalization file changed
  from `b74658d` to `1ec6710`.

### Snapshot-order evidence and owner decision

The implementer reports 20 characterization-file runs on each revision: Agent-owned
internal-command order mismatches **3/20 on A1, 0/20 on `9e0f457`**; managed combined
steer **1/20 on A1, 3/20 on `9e0f457`**. These are implementer-reported samples, not
independently rerun in this review. They support that both mismatches can appear in A1,
but are too small to establish equal rates or prove A2 has no effect on their rate.
Our earlier independent full follow-up run failed the Agent-owned internal-command
snapshot once; our earlier managed-steer probes reproduced a mismatch on A1 and A2.
A prior 30-run filtered A1 internal-command probe passed and does not disprove a rare
failure. The owner decision on strict ordering remains open; no snapshot was loosened or
regenerated, and a passing full run is not a resolution of nondeterminism.

### Independent checks

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean |
| Temporary tsconfig including turn-path tests and lifecycle fixture | clean |
| Complete offline `bun test` | **1,145 pass / 0 fail, 114 files, 35 snapshots, 93.93s** |
| New held-reconnect regression, current source | 1 pass / 0 fail; 199ms process time |
| Same test/fixture on prior `b74658d` source | 0 pass / 1 fail; 2s refused-prompt timeout, 2.17s process time |
| Snapshot and normalizer diff `b74658d..1ec6710` | empty |
| Snapshot SHA256 | `d25f05a19cadeb8ff2a310ee85fca41d47323576bec64f39eb6025cc844aca1a` |
| `git diff --check b74658d..1ec6710` | clean |
| `agent-session.ts` | 4,634 lines, below the 5,022 hard limit |

The full suite is green in this particular run. The unanswered-reconnect cleanup and
snapshot-order questions require owner/coordinator disposition before treating the
brief as passed. All tests used temporary archives and offline fixtures; no source or
snapshot edits, implementation checkout, live harness, push, merge into beta, or
protected path/worktree/process change was performed.

## Final review — `d7303d8` against beta `95e9cf2` (2026-11-13)

Reviewed final implementation `d7303d87bdd4840d4119ba41fa5ae06833a56cdb`, dedicated
exception `1ad325d`, the updated A2 report and the user-confirmed owner decisions on
`95e9cf249dbef18ee2a3d59322010a7447158058`. Earlier reviews remain historical.

**Verdict: do not pass A2 yet; B1 remains held.** The independent numerical checks
pass and the earlier accepted stuck-connect limitation is represented as decided. The
exception implementation can hide an unauthorized Agent-owned bus reorder, and the
new explicit contractual watcher does not establish all of the orders it claims.
Study 1 also discarded information needed to establish that there were no unclassified
errors. Return these findings before the coordinator's gate; do not loosen snapshots.

### P1 — Agent-owned bus canonicalization can hide a completed-snapshot reorder

**`test/conversation-turns/characterization.test.ts:434`–`:445`, `:473`–`:488`.**
The approved Agent-owned exception is metering versus the same turn's **last
in-progress assistant snapshot record** only. The raw records path checks role and
status when `sequenced` is true, but the compact `committedBus` path invokes the same
function with `sequenced = false`. At `:481`, `!sequenced` bypasses both role and
status checks. Any same-turn `message` ID containing `:snapshot:` can therefore be
moved across metering on the bus, including a **completed** assistant snapshot, which
is outside the authorized exception. The bus and records are canonicalized separately;
`assertRun` checks only unique bus IDs and membership in the records (`:204`–`:206`),
not that the bus order represents the actual record statuses/order.

Independent synthetic probe in a temporary test-only archive: hold the raw sequenced
record list fixed as `[completed assistant snapshot, metering]`; compare two bus lists
`[completed snapshot, metering]` and `[metering, completed snapshot]`. Both pass the
raw `watchContract.assertRun` checks, and `withNonContractualPairsInOneOrder` produces
the **same** value for both. The temporary test passed with 23 assertions, demonstrating
that an unauthorized reorder and bus/records disagreement can be concealed from the
snapshot comparison. This is a fault-injected comparison, not a claim that the live
fixture emitted that regression.

Use the actual raw record identity/role/status when deciding whether a bus item is the
allowed last in-progress snapshot; preserve all other bus ordering and verify the bus
against the raw records. Add positive tests for the two authorized orders and negative
tests for completed/non-assistant snapshots, wrong turns, other intervening records and
bus/record disagreement. Keep raw sequence checks and the exact approved scope.

### P2 — Explicit completion and provider-result checks miss required cases

**`test/conversation-turns/characterization.test.ts:107`–`:115`, `:144`–`:152`,
`:190`–`:194`.** The promised explicit check that completion follows the last
presentation is evaluated *during* `turn_completed`, immediately after pushing that
completion into the timeline. A presentation not yet emitted cannot already have a
later index, and there is no later full-timeline assertion for this relation. A
synthetic watcher probe emitted `turn_started`, metering, `turn_completed`, then a
same-turn presentation: `violations` stayed empty and `assertRun` passed. In a real
captured run, the remaining strict snapshot may still catch a late event captured
before snapshotting; that is not the separate explicit temporal assertion requested,
and the watcher alone does not establish the bound.

The provider-result check instruments only `conversation.connection` at watch setup
and iterates only markers that happen to exist. A controller installed by a handoff is
not wrapped, and absence of a marker causes no failure; forced/rejected provider paths
are also omitted, as the report acknowledges. Likewise, the Agent-owned final-record
presence check (`:154`–`:159`) is evidence that *a* final record was committed, not
that `afterPrompt` itself has returned: no `afterPrompt` start/end is observed in this
watcher. The existing dedicated turn-path test does explicitly hold `afterPrompt` and
checks a config operation and `turn_completed` after release; it is useful coverage but
does not make the per-case watcher claim true for handoff/replaced controllers or all
persistence paths.

Assert each completed turn's final presentation against completion on the **complete**
captured timeline; require appropriate result/outcome evidence for every applicable
turn including controller replacement; and explicitly observe finalization completion
where required. If a forced turn has no provider result to observe, document and
escalate the exact applicable outcome requirement rather than silently skipping it.
Keep bounded event barriers and retain the existing targeted finalization test.

### P2 — Comparative study 1 cannot establish that all other failures were classified

The committed report's counts have a useful comparable design: two interleaved studies,
with raw captures before canonicalization, the same respective instrumentation on A1
and A2, all three managed positions reported separately including zeros, and
Agent-owned before/after counts. I inspected `/tmp/a2-fix/instrument.py`,
`instrument2.py`, `collect.sh`, `collect2.sh`, `collect2b.sh`, and the four JSONL
dumps. Each dump has 1,750 captures, exactly 35 named cases × 50, and independent
recounting of both combined-steer turns and the Agent-owned internal command matches
the reported tables. The largest reported per-position difference is 2/50; these
small samples do not establish equal rates. A1 always runs immediately before A2 in
each pair, a possible order/load bias, and study 2 adds synchronous transcript reads
and a promise observer to **both** versions, as disclosed.

However, study 1's `/tmp/a2-fix/collect.sh` pipes each test's combined output through
`grep '^\\(fail\\)'` and `sed`; it does not preserve raw output or the Bun exit code.
Unhandled errors between tests, setup/teardown diagnostics, or a nonzero process exit
without a `(fail)` line cannot be recovered from `fails-a1.txt` / `fails-a2.txt`.
The 35 captures per iteration do not prove there was no later unhandled error. Thus
`REPORT-A2.md`'s claim that study 1 had only the listed failures cannot be independently
established from the retained evidence, despite the user requiring unclassified
failures separately. Study 2 retains filtered `error` and `(fail)` lines but overwrites
its full per-run log and likewise does not retain each exit status. Preserve complete
per-run output and exit codes for any supplementary comparison needed to classify all
failures; report unknowns honestly rather than treating missing diagnostics as zero.
The sentence claiming “200 A1 and 200 A2 runs” is also inconsistent with the retained
four 50-run dumps: two studies total **100 A1 and 100 A2**, 200 runs combined.

## Snapshot, scope and accepted decisions

- `cffce98` remains an isolated snapshot-only cause commit: removing exactly its 39
  inserted cause blocks restores the preceding snapshot bytes. `1ad325d` is a separate
  two-file test/snapshot commit; no later snapshot change appears through `d7303d8`.
  The implementer's line-multiset check on its 14 changed snapshots establishes
  equal line and sequence-number multisets, but by itself does not prove unchanged
  object associations or authorized order. The bus counterexample above shows why
  semantic negative checks are necessary.
- The managed canonicalizer moves metering only across contiguous same-turn **response**
  presentations, never across user presentations or other kinds/turns. This is narrower
  than the owner's maximum allowance and is defensible: user presentations are written
  before dispatch, and maintaining their order retains a stronger guard. Noncontiguous
  otherwise-permitted arrangements may still fail; this is a coverage limitation rather
  than permission to reorder unrelated events.
- Raw Agent-owned sequence numbers are checked increasing and unique before any
  canonicalization, and managed transcript `seq` is checked `1..n`; the snapshot also
  retains sequence values. Inside an allowed adjacent Agent-owned pair the canonical
  representation reassigns the pair's two existing sequence values, so their association
  with those two records is intentionally not pinned. Other values are compared by the
  snapshot. The bus status/identity bug above extends beyond that intended allowance.
- The owner explicitly accepted the existing ACP stuck-connect/reconnect hang as a named
  bounded-wait exception. No source changes after the last reviewed `1ec6710` alter that
  fix; prompt rejection and non-overlapping reconnect behavior remain as previously
  inspected. The exception does not authorize unrelated unbounded waits. Event-gated
  tests remain bounded on the checked paths; earlier failure-cleanup regression was
  independently verified in the preceding review.
- A2's earlier step and scope evidence remains in previous sections: no source change
  under `src/persistence/`, adoption, or continuation paths, and `agent-session.ts`
  remains below 5,022 lines. B1 remains held until review and the coordinator gate.

## Independent final checks

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean |
| Temporary tsconfig including conversation-turn tests and lifecycle fixture | clean |
| Complete offline `bun test` | **1,145 pass / 0 fail, 114 files, 35 snapshots, 100.59s** |
| Characterization and turn-path focused run | **48 pass / 0 fail, 35 snapshots, 15.04s** |
| Final snapshot SHA256 | `47686d4ca0451cf89802c9df52d22d453c238f811b9864cd72358663bfd971e6` |
| Completed-snapshot bus negative probe | unauthorized opposite orders canonicalize identically and both pass raw checks |
| Late-presentation watcher probe | watcher and its explicit `assertRun` accept a presentation after completion |
| Cause-only commit | 39 blocks removed restores exact preceding snapshot bytes |
| Comparative capture recount | four 1,750-entry dumps; selected per-turn managed and Agent-owned counts match report |

Tests and synthetic probes used temporary `git archive` copies and offline fixtures;
only temporary test files were altered for the probes. No repository source edits,
implementation branch checkout, live harness, push, merge into beta, or protected
path/worktree/process change occurred. Numerical gates are green for the runs above;
the exception-scope and contractual-assertion findings prevent A2 acceptance.

## Final-fixes review — `26c7868` (2026-11-13)

Reviewed consolidated exception `5eeb54c1cb6a1f2253886ddc6e727b70995eaded` and
report `26c78680b404b421eeb105c555bce9cc21533aad` against beta `95e9cf2`, the
owner decisions, and prior review `72406be`. The prior report remains historical;
`1ad325d` was replaced by the consolidated commit and the old implementation head is
retained on `controller-interface-pre-consolidation-d7303d8`.

**Verdict: the numerical tests pass and the unauthorized bus normalization is fixed,
but the explicit contractual watcher still has two acceptance gaps and one failure-path
instrumentation defect. Do not pass A2 yet; B1 remains held.** These are test/evidence
findings; this review does not claim a newly observed production regression.

### P2 — A provider-dispatched failed turn can have no metering and still pass the explicit check

**`test/conversation-turns/characterization.test.ts:213`–`:239`.** Completed turns
must have one `metering_recorded`, but for a failed turn that reached the provider,
`:237`–`:239` explicitly accepts `"not metered"`. The map loop at `:213` checks the
counts of events that exist; it does not require one for a provider-dispatched failed
turn. The separate strict snapshot may catch missing metering in a particular captured
scenario, but the owner specifically requires a separate per-turn assertion of records
and metering once and metering after provider outcome.

Independent temporary synthetic watcher probe: emit `turn_started`, invoke a controller
prompt that returns a rejected promise, await the rejection, then emit `turn_failed`
with **no** metering event. `watchContract.assertRun("detached", {})` returns without
throwing. This proves the explicit assertion misses the absence. Pre-dispatch failures
are different: the spec explicitly allows a metering preflight rejection without a
record. A failure of metering persistence itself may also need a distinct explicitly
identified case; do not require a nonexistent record in such a case by assumption.
Require one metering record/event for applicable provider-dispatched failed turns,
assert its outcome order, and add positive and negative failure-path tests or escalate
a genuine metering-failure exception for decision.

### P2 — “Final assistant message” assertion accepts only an earlier message

**`test/conversation-turns/characterization.test.ts:178`–`:193`.** In Agent-owned mode,
`some` accepts any `<turn>:assistant:N` committed record; managed mode accepts any
terminal assistant transcript line; detached mode compares only a cumulative assistant
line count with a cumulative ended-turn count. None establishes that the **last**
assistant message of a multi-message completed turn was recorded before that turn's
completion. The strict snapshot retains the actual captured records and can catch a
missing record in the covered fixtures, but that does not make the explicitly required
per-turn final-message assertion true.

Independent temporary synthetic watcher probe: emit a completed result with two
assistant messages, provide only the first committed final record, and otherwise
provide provider-outcome, metering, and completed `afterPrompt` markers. Both
`violations` and `assertRun` pass. Assert the expected final message/ordinal for the
specific turn, not just the presence of some earlier message or a global count, and
include a multi-message negative case. Preserve the real records and sequence checks.

### P2 — A synchronous controller prompt throw is not recorded as an outcome

**`test/conversation-turns/characterization.test.ts:118`–`:125`, `:232`–`:239`.**
The wrapper records `provider_called` and then calls `prompt(...args)` before attaching
outcome handlers. If it throws synchronously, no `provider_outcome` marker is recorded;
the watcher later fails its own assertion even if metering and `turn_failed` are
correct. This is a real possible controller behavior: `AgentController.prompt` calls
`requireCurrent` before returning a promise (`src/controller.ts:285`–`:291`), and the
original immediate-force-stop probe exercises a not-started failure boundary.

Independent temporary synthetic watcher probe: make `prompt()` synchronously throw
`not connected`, catch it as the supervisor would, then emit metering and `turn_failed`.
The watcher rejects the timeline because it never recorded an outcome. Record a
synchronous throw as the outcome while rethrowing the same error, and test it alongside
promise rejection and forced completion. This is a false test failure / incomplete
failure-path observation, not an assertion that production swallows the exception.

## Disposition of prior final-review findings

- **Unauthorized Agent-owned bus reorder:** resolved for the probed scope.
  `canonicalOwnedRecords` now selects the allowed pair from raw record kind, role,
  status, turn and last-in-progress identity, requires bus IDs in the same raw order,
  and swaps that exact pair on the bus. Independent seven-test synthetic probe passes:
  both allowed orders converge; completed/non-assistant/wrong-turn snapshots and
  intervening records remain distinct; bus disagreement throws; managed three-position
  forms converge without crossing another turn. The 15 committed pair-rule tests also
  pass in the focused/full runs. Their representative negative cases are meaningful;
  the snapshot exception remains narrower for managed user presentations, which is a
  defensible stronger guard, and nonadjacent alternatives still fail rather than hide
  other ordering.
- **Late presentation and `afterPrompt`:** the watcher now checks the complete timeline,
  rewraps a replacement controller on its first `turn_started`, and observes the
  Agent-owned `afterPrompt` promise. Independent synthetic negative probes confirm a
  late presentation, a missing provider outcome, and still-pending `afterPrompt` are
  rejected; positive probes confirm a replacement controller and a rejected provider
  promise are observed. The remaining coverage and synchronous-throw gaps are above.
  The existing real held-finalization test remains an independent ordering check.
- **Comparison evidence:** the earlier studies now explicitly label missing diagnostics
  and exit codes unknown and correct their total to 100 A1 plus 100 A2 runs. Study 3
  retains one complete output log, exit code and 35 raw captures for each of 50 A1 and
  50 A2 runs; odd/even pairs reverse execution order. I independently read all 100 exit
  files and logs: 50/50 exit zero on each version, no `(fail)`, `Unhandled`, or
  `error between tests`, and 35 captures per run. The instrumented A1 and A2 test files
  are identical and differ from final characterization only by test-name tracking and
  raw capture; pair-rule/normalize hashes match. Removing 39 allowed cause blocks from
  the final snapshot exactly reproduces the A1 study snapshot. Independent recount of
  combined-steer turns and Agent-owned internal-command counts matches the report,
  including zeros in all three managed positions. Largest reported per-position
  difference is 2/50; no material shift is evident in these samples, which cannot prove
  equal rates. Instrumentation, filesystem writes and synchronous transcript checks can
  affect timing, but are applied to both versions; finite samples and environment remain
  limitations.

## Snapshot, scope, and accepted reconnect limitation

`cffce98` remains the separate cause-only commit. `5eeb54c` is the single consolidated
exception commit, containing characterization test, snapshot, pair-rule and its tests;
no later test/snapshot changes occur through `26c7868`. Its snapshot is byte-identical
to the previously reviewed exception snapshot; normalization remains unchanged.
The accepted Agent-owned pair's two actual sequence numbers are checked on raw records
for order/uniqueness, then their association with the two allowed records may be
canonicalized; other sequence/content/ID assertions remain strict. The managed rule
moves metering only across contiguous same-turn response presentations, never user
messages, unrelated events or another turn.

The owner-accepted existing ACP connect/reconnect hang is a named bounded-wait
exception, not a general exemption. The previously reviewed prompt rejection and
non-overlapping reconnect behavior is unchanged since `1ec6710`; no source changes
occur in the dedicated exception or final report commits. Earlier event-gate cleanup
fix and accepted stuck-connect behavior remain as previously documented. No new
snapshot-order waiver is inferred.

## Independent verification

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean |
| Temporary tsconfig including turn tests, pair-rule and lifecycle fixture | clean |
| Complete offline `bun test` | **1,160 pass / 0 fail, 115 files, 35 snapshots, 92.87s** |
| Characterization + turn-path + pair-rule | **63 pass / 0 fail, 35 snapshots, 15.72s** |
| Independent pair-rule positive/negative probes | 7 pass / 0 fail |
| Watcher synthetic probes | late presentation, missing outcome and pending finalization are rejected; replacement controller and rejected promise observed; three gaps reproduced above |
| Study 3 retained evidence | 100/100 exit zero; 35 captures each; selected per-turn counts independently match |
| Snapshot SHA256 | `47686d4ca0451cf89802c9df52d22d453c238f811b9864cd72358663bfd971e6` |
| Snapshot identity / `git diff --check` | prior exception snapshot identical; diff check clean |

Full/focused tests and synthetic probes ran in temporary `git archive` copies with
offline fixtures; only temporary test files were changed for probes. No repository
source edits, implementation branch checkout, live harness, push, merge into beta, or
protected path/worktree/process change occurred. Numerical tests are green; the
explicit contractual-assertion findings must be resolved before the coordinator can
pass A2.

## Watcher-fixes review — `120210f` (2026-11-13)

Reviewed consolidated exception `2f3b073`, report `120210f`, prior review `54ced2e`,
beta `95e9cf2` and the owner decisions. Earlier review sections remain historical.

**Verdict: the prior three watcher counterexamples are addressed and independent
numerical tests pass, but two additional explicit-assertion gaps remain. Do not pass
A2 until the gaps and the separately escalated metering-write question receive their
appropriate disposition; B1 remains held.** These findings concern the test watcher
and contract evidence, not a newly established production regression.

### P2 — Detached final-message check can reuse an identical previous turn's line

**`test/conversation-turns/contract-watch.ts:140`–`:146`.** At completion, the
watcher selects the last assistant line in the entire detached transcript and checks
its message texts against the current result. It does not check that this assistant
line was appended for the current turn. If the previous turn produced the same text
and the current turn's assistant line is missing, the previous line satisfies the
check even when the current turn's user line comes after it.

Independent temporary synthetic test (`/tmp/controller-a2-detached-duplicate.test.ts`):
the transcript contains a prior assistant message `same`, followed by the current
turn's user message, with **no current assistant line**. A current completed turn whose
result also contains `same` gives `violations = []`, and `assertRun("detached", {})`
passes. The actual characterization snapshot still compares captured transcript lines
and can catch a missing line in its covered fixtures; this is the separately required
per-turn final-message assertion, and its claimed positional identification is not
sufficient when messages repeat.

Track a turn-specific transcript boundary (for example the relevant user/assistant
segment or an independently recorded offset before the current turn's assistant
append), and require the final assistant line to belong to that segment as well as
matching all messages. Add a negative repeated-text case and a correct two-turn positive
case. Keep detached transcript ordering and content strict.

### P2 — An unobserved pre-dispatch phase is labeled “before metered operation” from error text alone

**`test/conversation-turns/contract-watch.ts:196`–`:207`.** For a failed turn with
no `provider_called` marker, any error other than the preflight or metering-carrying
name prefixes is classified as “failed before the metered operation” and expected to
have no metering. The watcher does not observe whether `metering.open()` actually
succeeded; an error name alone does not establish that boundary. This is an implicit
classification, distinct from the explicit `expectMeteringWriteFailure` override.

Independent runtime fault probe (`/tmp/controller-a2-postopen-classification.test.ts`):
create a real managed session on the offline echo fixture, count successful
`metering.open()` calls, and make `v2Transcript.beginOperation()` throw a plain
`Error` immediately after the metering open succeeds. The prompt fails, the open count
is **1**, no provider call occurs, and the watcher nevertheless accepts the run as one
that failed before the metered operation. The probe passed with seven assertions; only
runtime methods in the temporary test process were wrapped. This establishes the
classification is factually wrong; it does not by itself decide whether the existing
pre-dispatch persistence-failure path must produce a metering record or authorize a
production behavior change.

Observe the metering-open/pre-dispatch boundary directly or represent it explicitly,
then make expectations for an opened-but-not-dispatched failure distinguishable from a
failure before opening. Escalate the expected record behavior if the spec does not
settle it. Add positive/negative tests for both sides of the boundary. Do not silently
infer that missing metering is allowed from a generic error prefix or from the
declared-only metering-write override.

## Prior findings and owner question 4

- A provider-dispatched failure without metering now fails the explicit watcher; one
  metering after a promise rejection or synchronous throw passes, duplicates and early
  metering fail. The wrapper catches a synchronous throw, records an outcome and
  rethrows the **same error**, and returns the **same promise** on async paths. The 27
  committed synthetic watcher tests include positive/negative cases and pass in the
  independent full/focused runs. The implementer reports individual temporary mutation
  checks; I inspected the synthetic cases and report but did not independently repeat
  each mutation.
- Agent-owned and managed final-message checks now use the current turn's final ordinal
  and text, including multi-message negative cases. The detached repeated-text
  counterexample above remains. These checks are separate from strict snapshot content.
- Metering-write failure policy remains open question 4 for the owner. The synthetic
  declared `close` / `record` overrides are not used by any current characterization
  case (`rg` found no call there); their mere presence does **not** authorize missing
  metering. I do not decide that policy. The post-open fault above reveals a separate
  implicit classification that does not use the override. No existing characterization
  case injects that fault, so the green numerical run is not evidence resolving it.
- The previous late-presentation and `afterPrompt` timeline fixes, pair-rule negative
  tests, raw bus/record agreement and accepted existing ACP stuck-connect exception are
  unchanged. No new unbounded-wait exception is inferred.

## Snapshot and comparison evidence

`2f3b073` is the single consolidated exception commit on the implementation branch,
with `cffce98` still separate. The old implementation head is preserved on the named
pre-watcher-fixes branch. Relative to `5eeb54c`, only the characterization watcher
extraction and new watcher/test files changed: source, snapshot, pair-rule, pair-rule
unit tests and normalizer are byte-identical. Snapshot SHA256 remains
`47686d4ca0451cf89802c9df52d22d453c238f811b9864cd72358663bfd971e6`; no snapshot was
regenerated in review. The numerical and strict-scope checks from the preceding review
remain applicable to those unchanged files.

Study 3's retained A1/A2 comparison used the **same prior watcher** on both versions;
our previous review checked all 100 exit files/logs and selected per-turn counts.
For the changed watcher, the implementer ran Study 4: 20 A2-only instrumented runs.
I independently checked all 20 exit files/logs and dumps: all exit zero, no fail or
unhandled diagnostic, 35 captures each; Agent-owned internal-command order is 18
metering-first / 2 snapshot-first, matching the report. The Study 4 watcher file matches
this commit and the characterization diff is only the same dump/name instrumentation.
The supplementary A2-only sample supports that the final test runs and captures the
known alternatives; it is **not** a paired final-watcher A1/A2 comparison and cannot
establish unchanged rates after the instrumentation changes. Study 3 remains valid
for its shared prior instrumentation and unchanged production source; synchronous
watcher work may itself affect timing. Finite samples and the always-possible noise
remain limitations. All three managed positions and zeros are recorded in the prior
A1/A2 comparison; no equality of rates is inferred.

## Independent checks

| Check | Result |
| --- | --- |
| Source and test/fixture typechecks | clean |
| Complete offline `bun test` | **1,187 pass / 0 fail, 116 files, 35 snapshots, 104.03s** |
| Characterization, turn-path, pair-rule and watcher | **90 pass / 0 fail, 14.55s** |
| Detached repeated-text synthetic probe | watcher accepts missing current assistant line |
| Managed post-open pre-dispatch fault probe | actual open count 1; watcher accepts it as before-open, no declaration |
| Study 4 retained evidence | 20/20 exit zero, 35 captures each, no fail/unhandled diagnostic |
| Snapshot / pair rule / source | unchanged from `5eeb54c`; diff check clean |

Tests used temporary archive copies, synthetic conversations, and offline fixture
agents. No repository source/snapshot edits, implementation branch checkout, live
harness, push, merge into beta, or protected path/worktree/process change occurred.
The two watcher gaps require a follow-up before the coordinator can accept the brief;
B1 remains held.

## Boundary follow-up: `c33f5b6`, consolidated exception `8ac866e`

**Verdict: return the watcher to the implementer; B1 remains held.** The independently
run full and focused numerical gates and both typechecks are green, but the watcher can
still silently misclassify an unsettled open and erase a rejected opening attempt. Owner
questions 4 and 5 also remain decisions for the owner; case declarations are exact
expectations, not authority to settle the specification. Coordinator acceptance remains
separate. The earlier two boundary counterexamples are fixed for their tested paths.

### Findings

1. **P2 — An open still pending is classified as never opened.** In
   `test/conversation-turns/contract-watch.ts:121`–`130` the map is updated only when
   `open` settles. At `:264`–`:267`, absence is treated as failure before the operation
   was opened. In an independent synthetic offline probe, start a turn, call an open
   returning an unresolved promise, then emit `turn_failed`: `assertRun` passes with no
   metering. Resolve that same promise and the identical assertion now correctly rejects
   an undeclared open-before-dispatch case. This is fault injection, not evidence that
   today's production code emits this sequence. The check cannot distinguish no call from
   a call whose outcome is unknown, and a late success escapes the assertion. Record the
   call and pending state, and fail or otherwise explicitly settle the observation before
   treating it as a known boundary; add a regression. Do not infer a metering policy for
   that state.
2. **P2 — Opening attempts overwrite one another.** At the same `:127` and `:130` map
   writes, a second attempt for one operation replaces the first, while completion checks
   at `:300`–`:313` verify only that some successful open preceded dispatch. An independent
   synthetic probe rejects the first open with `MeteringPreflightError`, succeeds on a
   second, dispatches and completes with one metering record; `assertRun` accepts it and
   loses the preflight failure. This does not claim the current implementation retries or
   that the specification already forbids all retries. Preserve and check attempt history
   so that a rejection followed by continuation is observable; any intended retry policy
   should be decided explicitly rather than silently accepted by the watcher.
3. **P3 — Study 5 heading is stale.** The implementation report at
   `.res/somelogs.md/11-11+/library/reports/11-12-REPORT-A2.md:906` says 20 runs each,
   although its subsequent extended evidence and retained files contain 50 each. Correct
   the heading to avoid obscuring the final sample size. This does not invalidate the
   independently checked 100 retained runs.

### Boundary and policy evidence

The detached watcher now uses each turn's start offset and requires its user line followed
by exactly one assistant line with that turn's messages. In an independent synthetic test,
three valid turns with identical assistant text passed, including one following a failed
turn; a later turn lacking its own assistant line failed even though prior identical lines
existed. The committed tests also cover the two-turn positive and prior-text negative.

The watcher observes actual `metering.open`, rethrows the same synchronous error and
returns the original promise. Committed offline real-session tests establish today's three
fault paths: managed `beginOperation` failure after successful open has zero records;
detached `prepareTurn` failure after open has one; detached user-line failure before open
has zero. The two post-open cases reject an undeclared expectation and check declared 0/1
against the actual outcome. Preflight rejection and synchronous throw tests pass. The
pending and repeated-open probes above identify gaps in the observation itself. Question 4
(metering write failures) and question 5 (opened, not dispatched) require owner resolution
before the gate; no current characterization case invokes their declaration overrides.
No policy is inferred from these probes.

### Study 5 and change scope

I checked the 100 retained A1/A2 exit files, logs and 35-capture JSONL dumps: all exits
zero, with no failure or unhandled diagnostics; runs alternate first version by pair and
both versions use the same final watcher. Independent managed two-steer turn 1 recount,
in order P1-meter-P2 / P1-P2-meter / meter-P1-P2: A1 **45/5/0**, A2 **46/4/0**;
turn 2 is **0/0/50** in each. Agent-owned internal-command metering precedes the last
in-progress snapshot in **50/50** for each version. These selected counts match the
report; other cases and all three positions are reported there. Previous studies had
roughly 48–50 of 50 in the first managed position, versus 45 and 46 here; the final
watcher may affect timing on both versions. The comparison does not establish equal rates
or isolate a cause; finite samples and synchronous instrumentation limit inference.

Only watcher and watcher-test files changed between `2f3b073` and `8ac866e`; source,
pair rules and snapshot are unchanged. The cause-only change remains separate. Snapshot
SHA-256 is `47686d4ca0451cf89802c9df52d22d453c238f811b9864cd72358663bfd971e6`;
no snapshots were regenerated.

### Independent checks

- Complete offline suite: **1,196 pass, 0 fail**, 116 files, 35 snapshots, 127.23s.
- Focused characterization, turn-path, pair-rule and watcher suite: **99 pass, 0 fail**,
  35 snapshots, 16.28s. Source and test/fixture typechecks passed.
- Three extra synthetic probes passed their explicit assertions: detached repeated-text
  isolation works; the pending-open and failed-open retry probes reproduce the two gaps.
  These are fault injections, not production regression demonstrations.
- Tests used a temporary archive and offline fixtures; no implementation branch checkout,
  source/snapshot edit, live harness, push, or beta merge was performed.

## Owner metering decision and beta update

Merged beta `5e01135` into `controller-interface-reviews` at
`67232610ecbf0bd4fb9478a6af28bf08c8d49140`, without conflicts. Prior review commit
`5dacc7a` and beta `5e01135` are both ancestors. Read the updated execution plan and
controller-interface specification, including owner decision `0013b0f`: a durable
metering record is at most once per operation and writes are idempotent by operation ID,
including custom backends; in-process retry of the same record is allowed. A metering
write failure surfaces and can leave no durable record; no durable retry is promised.
An opened operation that never reaches the provider may leave zero or one no-usage
record; characterization asserts each mode's existing outcome.

The preceding pending-open and overwritten-attempt findings concern observation gaps;
they do not establish a prohibition on retrying `open()`. The write-retry decision does
not itself define an `open()` retry rule. The follow-up review will evaluate fixes against
the decision and grounded behavior, preserving attempt history without inventing a
broader prohibition. This update is documentation and branch integration only; no test
suite was run for the merge. Awaiting the completed fix assignment; B1 and the A2
coordinator gate remain held.

## Metering-open follow-up: `9273d4a`, exception `e3c65e6`

**Verdict: return the no-usage assertion gap for follow-up; B1 and coordinator gate stay
held.** Independently completed full and focused suites and the applicable typechecks are
green, but the watcher does not enforce the owner's no-usage condition. The two earlier
pending/open-history findings are addressed. The checkpoint failures below need coordinator
triage and cannot be relabeled as green runs.

### Findings

1. **P2 — Opened but undispatched metering does not check the no-usage condition.**
   `test/conversation-turns/contract-watch.ts:247`–`:250` retains only the event count;
   `:289`–`:306` and `:387`–`:416` accept one based on count, order and error text,
   without inspecting its usage. `contract-watch.test.ts:162`–`:195` emits only an ID;
   the real detached failure test at `:613`–`:632` pins one event but not its usage.
   Independent offline synthetic injection of a record with attributable 999 tokens after
   an open and no provider call passes `assertRun`, including with declared metering 1.
   Owner decision `0013b0f` allows none or **one no-usage record**. Check the actual
   attributed usage (taking its representation into account), pin the real detached outcome
   and include a negative positive-usage case. This is a watcher coverage gap; the probe
   does not demonstrate that current production records positive usage. See
   `$AGENTS_COMMON_ARTIFACTS_DIR/errors/11-15-a2-undispatched-metering-usage.md`.
2. **P2 — Pre-existing managed checkpoint validation failures need triage.** The retained
   A1 run 28 and A2 runs 23 and 26 each failed; raw captures contain
   `CheckpointValidationError: internalSessionActivatedAt must not be after updatedAt`
   (`src/persistence/checkpoint.ts:141`). In A2 run 23 the logged immediate failure is the
   old watcher's undeclared-open assertion; the captured handoff and next turn show the
   checkpoint error. The final watcher's changed policy would remove that assertion, but
   the recorded failed handoff/turn would still differ from the success snapshot. The A1
   occurrence establishes that the symptom predates A2; a machine clock explanation is a
   hypothesis, not a proven cause. These are 3 failed runs, not green characterization
   evidence. Coordinator/owner should triage under the current plan; fixing source is not
   authorized in this review. See
   `$AGENTS_COMMON_ARTIFACTS_DIR/errors/11-15-managed-checkpoint-activation-timestamp.md`.
3. **P3 — Failure timing in report conflicts with retained file timestamps.** The report's
   “Pre-existing intermittent checkpoint failure” section says all three Study 6 failures
   were on November 15 and none occurred in 300+ runs on November 13. The three retained
   log mtimes are November 13, 15:04–15:06 UTC; the study was resumed after restart for
   later runs. File mtimes are not conclusive wall-clock evidence given the suspected
   clock problem, but they conflict with that assertion. Verify/correct the chronology;
   it cannot establish environment correlation or root cause as stated.

### Observer and owner-decision checks

An independent synthetic probe confirms the original pending promise is returned unchanged,
a terminal event while pending is rejected even after late settlement, and a rejected
open followed by a successful one is retained and rejected unless the exact ordered
history is declared; a reversed declaration fails. Committed tests cover late rejection,
synchronous throws preserving error identity, single failed open, and the real managed
begin-operation failure (zero events), detached prepare-turn failure (one event), and
before-open failure (zero). The observer adds no new promise reaction relative to the
preceding watcher, but still attaches an observation reaction and is a private seam; its
presence can affect scheduling. These cases do not establish a general `open()` retry
policy. Case declarations check observed history, not permission for production behavior.

Decision `0013b0f` permits in-process retry of the same record, requires idempotence and
at most one durable record, surfaces write failures and permits no durable retry. The
watcher's declared close/record write-failure branches are synthetic expectations, not
proof of all backend failure paths. SQLite's keys are `(agent_conversation_id,
operation_id)` and `(agent_session_id, operation_id)` in
`src/persistence/sqlite-schema.ts:292`–`:325`; existing persistence-failure test at
`test/agent-session-metering-records.test.ts:926` checks no double close. Custom backend
idempotence is an obligation, not independently demonstrated here. The final watcher
currently checks event/durable counts where supplied, not every write-attempt history.

### Study 6

Independently checked all 100 exits, logs and 3,500 captured runs (35 per file): A1 49/50
exit zero, A2 48/50; no unhandled diagnostics in those logs. All three failures and their
raw checkpoint symptoms are identified above. The runner alternates version first per
pair; A1 and A2 study copies contain byte-identical watcher instrumentation. The final
watcher differs in case declarations/assertions and classification, not the recorded open
boundary. Affected runs supply useful but incomplete order evidence; they do not constitute
100 successful characterization gates. In particular, the A2 failed handoff lacks the
second turn.

Independent selected recount, managed combined-steer first turn, all three positions
`M→P1→P2 / P1→M→P2 / P1→P2→M`: A1 **0/46/4**, A2 **0/49/1**. Agent-owned internal
command, snapshot→meter / meter→snapshot: A1 **0/50**, A2 **1/49**. The report lists
other cases and positions separately, including the 49 A2 handoff second turns. Compared
with prior independently recorded Study 5 (first-turn A1 0/45/5, A2 0/46/4), both
versions remain shifted relative to earlier studies; the final instrumentation itself may
influence timing. The study overlaps other work for its last portion and finite samples
cannot prove equal timing, no effect, or a root cause. Earlier raw study files lost on
restart were not rechecked; previous review's independently recorded evidence stands.

### Independent gates and scope

- Full offline suite: **1,204 pass, 0 fail**, 116 files, 35 snapshots, 99.01s.
- Focused characterization, turn-path, pair-rule and watcher: **107 pass, 0 fail**,
  35 snapshots, 14.69s. `bun run typecheck` and test/fixture-scoped typecheck clean.
  A deliberately broader, nonstandard typecheck of all repository tests reports existing
  type errors; it is not the project's typecheck gate.
- Initial sandboxed full/focused attempts suffered fixture connection timeouts and were
  interrupted; completed runs above used offline fixtures with local connections outside
  the sandbox. No errors from those aborted attempts are counted as green runs.
- `5e01135` is an ancestor of both branches. Relative to `8ac866e`, `e3c65e6` changes
  only watcher and watcher tests; `src`, pair rules and snapshot match `5eeb54c`.
  SHA-256 of snapshot: `47686d4ca0451cf89802c9df52d22d453c238f811b9864cd72358663bfd971e6`.
  `cffce98` remains a separate snapshot-only cause commit. Diff check clean.
- No snapshot regeneration, source edit, implementation branch checkout, live harness,
  push or merge into beta. The numerical suite green does not settle the coverage finding
  or the checkpoint issue.

## No-usage follow-up: `937de8a`, exception `5676ce6`

**Verdict: return the no-usage shape validation gap for follow-up; B1 remains held.**
Independent full/focused numerical gates and the applicable typechecks are green. The
original 999-token probe is fixed for the recognized metered representation and the real
mode-specific case is pinned. The owner still needs to triage the pre-existing checkpoint
failure; the coordinator gate is separate.

### Finding

**P2 — Unrecognized or incomplete usage is silently classified as no usage.**
`test/conversation-turns/contract-watch.ts:85`–`:104` returns success for *any* status
other than `metered` at `:88`, although the documented known alternatives are
`usage_unavailable`, `baseline_required` and `counter_reset`. For `metered`, `:91`–`:100`
treat missing required counts and rated totals as zero by accepting `undefined` and
missing objects. The helper's own comment says other shapes cannot be established as no
usage, and the report says incomplete totals fail. An independent offline synthetic
undispatched turn passes the full `assertRun` with either
`{status: "unknown_future_status", attributable: {totalTokens: 999}}`,
`{status: "metered", attributable: {}}`, or an incomplete `ratedTotal: {}`. These are
fault-injected malformed/future records, not a demonstrated current production record.
Only known non-metered variants should be recognized and a metered result must supply
sufficient required fields to establish zero; add negative tests for unknown status and
missing required usage/rated-total fields, while continuing to ignore session-cumulative
counters. See `$AGENTS_COMMON_ARTIFACTS_DIR/errors/11-15-a2-unknown-usage-shapes.md`.

### No-usage and finalization evidence

Independent helper probes confirmed the known unavailable/reset/baseline statuses and a
zero-metered record with a large cumulative session counter pass; positive attributed
totals, reported deltas, category counts, rated amounts and per-model line items fail.
The committed tests exercise declared and undeclared undispatched outcomes, and allow
usage after dispatch. The real detached injected prepare failure pins one record with
`usage_unavailable`, error outcome, `not_attributable` pricing and `none` source; managed
begin-operation failure pins zero. The previous `cc854a2` positive-token counterexample
now fails as intended. Existing completion, order, count, error and transcript checks
remain; the change adds the usage check instead of removing them. The implementer's two
mutation scripts target dropping the check and wrongly including cumulative usage, and
its reported failures match the inspected tests; I did not rerun those mutations. They do
not cover the unknown/incomplete counterexamples above. This is a watcher limitation, not
proof of a production behavior change.

### Study 6 and checkpoint triage

I rechecked all 100 retained exits, logs and 3,500 raw captures, excluding the three
*failed case captures* from the comparison rather than pretending their runs passed.
A1 28, A2 23 and A2 26 remain failed; logs and captures identify checkpoint validation
symptoms (A2 23 also has the prior undeclared-open assertion). The two additional
worktree failure logs and the three study failure logs have November 13 mtimes in the
reported 14:51–15:06 UTC sequence. File timestamps alone are not definitive chronology;
the prior November 15/clock-cause claim is withdrawn, and root cause remains unknown.
The status issue asks the owner to decide whether to accept or investigate the existing
symptom. It can fail managed turns/handoff; the present evidence does not establish a
stuck channel or silent data loss. No source fix or policy decision is authorized here.

Independent complete-case recount confirms every listed managed and Agent-owned pair has
at least 49 observations per version. Managed combined steer turn 1, positions
`M→P1→P2 / P1→M→P2 / P1→P2→M`: A1 **0/45/4** (49), A2 **0/49/1** (50).
Turn 2 `M→P1→P2` is **49/50**; the other two positions are **0/0** each. Managed
permission is **50/49**, handoff first and second turn **50/49** each in the first
position; their other positions are zero. Other managed pairs have 50/50, with all three
positions separately checked. Agent-owned internal command snapshot→meter / meter→snapshot
is A1 **0/50**, A2 **1/49**; other listed Agent-owned pairs were 50 snapshot-first / 0
meter-first in each version. Zero is an observed count, not proof an ordering is
impossible; failed cases and unobserved events are excluded, not counted as zeros.

The comparison used identical then-current instrumentation for both versions. The final
watcher adds a synchronous record-map write and a later assertion; this may affect timing,
so the observation point similarity is useful but does not prove distribution equality or
absence of a material shift. Both versions show more combined-steer alternate ordering
than historical studies 1–3; finite samples, incomplete cases and overlapping work limit
inference. Historical raw artifacts from studies 1–5 were lost; earlier review rechecks
remain attributed but were not repeated here.

### Independent gates and scope

- Complete offline suite: **1,209 pass / 0 fail**, 116 files, 35 snapshots, 94.01s.
- Focused characterization, turn-path, pair-rule and watcher: **112 pass / 0 fail**,
  35 snapshots, 15.03s. Source typecheck and relevant test/fixture typecheck clean.
- `5676ce6` has parent `83114f1`; `cffce98` remains separate, beta `5e01135` is an
  ancestor, and old head is retained as `controller-interface-pre-usage-check-9273d4a`.
  Across the three reconstructed commit pairs only watcher and watcher-test files differ;
  source, pair rule and snapshot match `5eeb54c`. Snapshot SHA-256 remains
  `47686d4ca0451cf89802c9df52d22d453c238f811b9864cd72358663bfd971e6`.
  Diff check clean; no snapshot regeneration.
- Tests used a temporary archive and offline fixture agents. No source edit, implementation
  checkout, live harness, push, or merge into beta. Green suites do not settle the shape
  finding, checkpoint triage or coordinator gate.
