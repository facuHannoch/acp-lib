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
