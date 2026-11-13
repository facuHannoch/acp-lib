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
