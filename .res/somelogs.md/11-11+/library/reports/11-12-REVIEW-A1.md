# Independent review: A1 characterization tests

Latest verdict: follow-up at `9de0ca3` resolves P1/P2 and meets the A1 gates; see the appended follow-up. The original red verdict below is retained as historical evidence. A2 remains held pending user release.

Reviewed `e4ecb7e1bde559b2dbbbb5b9e41313bda554a2ed..a6d0945`
(`f5e724c`, `52050ee`, `686d401`, `a6d0945`) against the entire authoritative
`11-11-SPEC-controller-interface.md` at that beta commit, including both appendices.
Reviewer branch: `controller-interface-reviews`. Line references to added files below
refer to `a6d0945`; source references also exist unchanged on beta.

**Verdict: A1 is not gate-complete. A2 must remain held.** Typecheck and the three-run
characterization check pass. The full-suite gate fails independently, for a reproduced
pre-existing defect. The timing workaround also needs correction or an explicit scope
exception; passing three runs does not make a sleep an event barrier.

## Findings, ranked by severity

### P1 — The full-suite gate remains red (pre-existing source defect)

Locations: `src/internal-inference/coordination/manager.ts:157` (`close`), `:240`
(heartbeat interval), `:363` (its only cleanup); trigger in
`test/internal-inference/manager.test.ts:122`. The A1 report correctly discloses the
failure at `reports/11-12-REPORT-A1.md:26`.

The runtime in that test ignores abort and never resolves. `close()` fences its
execution and closes persistence but does not clear the execution's interval. Cleanup
is local to `execute`'s `finally`, which the never-resolving runtime cannot reach.
The discarded heartbeat promise rejects when it writes to closed SQLite every 10s.

Independent complete A1 run: **1,130 pass, 1 fail, 1 unhandled error; 1,131 tests,
113 files, 86.38s**. The heartbeat stack ends at manager `:241`; Bun attributes it to
the bridge characterization case. A later `ENOENT posix_spawn 'bun'` originates from
that case continuing after its temporary cwd has been cleaned up. It is secondary,
not evidence that the fixture command is absent.

Independent reproduction with **unchanged beta**, without any A1 test or fixture:
`bun test ./test/internal-inference/manager.test.ts /tmp/controller-a1-heartbeat-idle.test.ts`,
where the temporary second file contains only a 12s idle test with a 20s timeout.
Result: **8 pass, 1 fail, 10.75s**, same closed-SQLite error and heartbeat stack.
This confirms the reported root cause independently; it is not introduced by A1.

Spec `:501` requires the complete suite green. Separate passing subsets cannot meet
it. Do not hide this with a long heartbeat interval, suppressed errors, reordered test
files or omitted tests. A source fix is outside A1's authorized tests-only scope;
escalate that scope decision to the user, then require a complete green rerun.

### P2 — Fixed completion delay avoids the race instead of synchronizing on an event

Locations: `test/conversation-turns/characterization.test.ts:606`–`:609` and
`test/fixtures/lifecycle-agent.ts:150`–`:152`.

The new `LIFECYCLE_END_DELAY_MS: "100"` separates the final chunk from the provider
result using wall-clock time. It lets `ownerRecordWrite` usually drain before the
direct `ownerLifecycle.meteringRecorded` write. It is not a guarantee that the record
has committed, and makes the test stop exercising the immediate chunk/result boundary.
Spec `:623`–`:624` explicitly calls for waiting on events to stabilize a flaky snapshot.

Independently verified the underlying race by changing **only this env value to "0" in
the temporary archive**, leaving production source and snapshots untouched, then running
`bun test test/conversation-turns/characterization.test.ts -t 'a tool start'` repeatedly.
Run 1 passed; run 2 failed. The diff swaps the assistant in-progress snapshot and metering
record in both `committedBus` and the persisted records, including their sequence numbers.
The temporary test file was restored afterwards.

The delay does **not** hide the initial tool boundary: its snapshot still shows
`waiting → tool_running → streaming`. It does hide the completion-side race the report
identifies and leaves stability dependent on the storage/scheduler finishing within
100ms. Replace it with explicit test/fixture synchronization on the committed message
record before releasing the result, without sorting/dropping records or changing source
under A1. If that deliberately narrowed scenario is the accepted characterization,
record that limitation explicitly; it does not establish an order for immediate
chunk-plus-result delivery. An exception to the spec's event-wait rule needs an explicit
decision, not an assertion that a fixed delay satisfies it.

## Coverage and capture assessment

The 35 tests comprise the required 23 all-modes cases and 12 once-only tests:

| Scenario | Agent-owned | Managed | Detached |
| --- | --- | --- | --- |
| Plain prompt | yes | yes | yes |
| Queued second prompt | yes | yes | yes |
| Combined steer messages | yes | yes | yes |
| Interrupt running turn | yes | yes | yes |
| Stall | yes | yes | yes |
| Permission answered by handler | yes | yes | yes |
| Internal command | yes | yes | yes |
| Handoff with summary | yes | yes | excluded by spec |

The once-only cases cover withdrawn and dropped messages with their promises awaited;
failed provider startup with prompt rejection and `turn_failed`; PTY and auth-refused
startup; both bridge paths; capability reads; acknowledged and forced internal-prompt
stall cancellation; and instant permission/tool boundaries.

Startup results/progress are tested directly on the controller, which exposes the raw
contract; the auth refusal also has a detached conversation test. The capability case
checks the controller before start and the Agent-owned conversation after create, after
force stop and after reconnection. This is a reasonable placement adaptation because
conversation creation starts the controller before returning; it does not literally
exercise a conversation object before its initial start. These deviations are disclosed,
not hidden omissions, and should be accepted explicitly by the coordinator/user.

The internal prompt forced case exercises **supervisor force escalation**, not an
explicit consumer `forceStop()` call. It pins `cancel: "forced"`, metering, handoff failure
and zero extra `turn_*` events. This satisfies the escalation reading of "cancelled by
force"; if the intended requirement was an explicit consumer force stop, that extra
case remains absent and requires clarification before calling that interpretation met.

Agent-owned records use the SQLite reader and committed-record bus; managed records use
the actual v2 transcript; detached records use legacy JSONL. Results are captured
separately. Compacted events retain the required ids/order; stages are included in the
boundary and internal-stall cases. They do not form a single combined chronology with
SQLite commits, so A2's explicit finalization-order tests remain necessary.

Normalization preserves array order and record/transcript sequence numbers. Its shared
id map preserves handle/turn/composite record relations. Inspected combined steer
snapshots retain both delivered message ids, the first message's run id, and the two
user records keyed to that run (`:user`, `:user:2`). Volatile time/duration/process/path
fields are normalized; hashes and identifier-like literals are additionally normalized.
Known ids are replaced globally in text, which also masks the fixture tool name `sleep`
when it equals its tool-call id; semantic text coverage is consequently narrower than
raw-record coverage. No evidence of sorted event arrays or discarded record ordering.

No source changes exist in the reviewed range. The auth fixture is offline and models
usable connection/failed session creation, then successful authentication and fresh
startup. The lifecycle fixture defaults to its previous behavior and guards cancellation
during the optional delay. Background checkpointing is explicitly disabled only in the
new Agent-owned setup. Existing snapshot content from `52050ee` is unchanged in
`686d401` (snapshot diff: 3,077 additions, zero deletions).

## Independent gate evidence

Tests ran from a `git archive a6d0945` extraction under `/tmp`, using installed dependencies;
the implementer's branch/worktree was never checked out or modified. Fixture/PTY tests
required execution outside the sandbox; the initial sandbox attempt timed out during
provider startup and is excluded from gate results.

| Check | Independent result |
| --- | --- |
| `bun run typecheck` | clean |
| Added tests/auth fixture checked by temporary tsconfig extending repo config | clean |
| Characterization run 1 | 35 pass, 0 fail, 35 snapshots; 12.75s |
| Characterization run 2 | 35 pass, 0 fail, 35 snapshots; 12.69s |
| Characterization run 3 | 35 pass, 0 fail, 35 snapshots; 12.84s |
| Snapshot SHA256 after each run | `e19d85c8fed49ff4cd1fd514aa5f8ca03b9d22cc8c00fd964b64e2a978b8cb5a` |
| Complete `bun test` | **RED: 1,130 pass / 1 fail / 1 error, 86.38s** |
| Unchanged-beta manager + temporary idle reproduction | **8 pass / 1 fail, 10.75s** |

Three normal runs and unchanged bytes are independently verified. The implementer's
three `--update-snapshots` regenerations were not independently repeated; they are not
needed to claim the three normal-run check. No snapshots were regenerated for this review.
Logs and temporary reproduction files are outside the repository under `/tmp/controller-a1-*`.

## Spec decisions to preserve for later briefs

`__snapshots__/characterization.test.ts.snap:13399` and `:13419` pin
"AgentController is not started — call start() first"; `:12976` pins the PTY error.
B1 can rename the class and preserve these observable strings, consistent with no new
ACP behavior and immutable A1 snapshots. If the requested rename includes changing
those strings, that conflicts with the snapshot rule: A2's isolated `cause` addition
is the only authorized exception. Surface this to the user before any error-string or
snapshot change; no exception is approved by this review.

No merge, push, production edit, live harness session, or change to protected worktrees,
files or processes was performed. A2 remains gated on user release and the unmet gates.

## Follow-up review — `a6d0945..9de0ca3` (2026-11-12)

Reviewed commits `80eeb10` (event barrier), `6957407` (P2 report), `50cd497`
(separately user-approved heartbeat fix and regression), and `9de0ca3` (final report).
References in this section are at `9de0ca3`. This follow-up supersedes the original
finding dispositions above; the original evidence remains intact.

### Finding dispositions and cleanup review

**P1 resolved by `50cd497`.** The only production change is the isolated heartbeat fix.
`src/internal-inference/coordination/manager.ts:77` retains the interval on the active
execution; `:257` assigns it before any awaited preparation or runtime work. `close()`
first marks the execution fenced (`:169`), then clears its timer (`:172`) before its
shutdown repository write and before the Agent closes persistence. The callback's
fenced check (`:246`) also prevents a queued callback from initiating a new heartbeat.
Normal execution retains its `finally` cleanup (`:374`); clearing an already-cleared
interval is harmless. Graceful shutdown still allows live executions to maintain their
leases until they finish or are fenced.

For the SQLite path, a heartbeat already initiated before fencing is serialized on the
backend's write queue; the shutdown failure write and backend close wait for queued
writes (`src/persistence/sqlite-backend.ts:301`, `:432`). Clearing an interval cannot
cancel an already-started promise, but this change does not start additional fenced
writes or close SQLite ahead of that existing queue. No new blocking cleanup race was
found in the affected path. This is a narrow fenced-execution fix, not a general proof
of every scheduler/close interleaving or arbitrary custom repository behavior.

The regression at `test/internal-inference/manager.test.ts:160` uses a genuinely
abort-ignoring, never-returning runtime and real 250ms heartbeat configuration. After
close it observes **800ms** (the actual code, exceeding three intervals), checks that
heartbeat call count does not increase, and checks for unhandled rejections (`:189`–`:195`).
It restores the spy/listener in `finally`. The listener does not conceal a broken test:
I independently ran this new test with unchanged beta production source in a temporary
archive, and it failed with the original heartbeat/closed-SQLite stack (0 pass / 1 fail,
398ms). With the fix, all nine manager tests plus the original temporary 12s idle test
pass (10 pass / 0 fail, 14.16s). Thus the regression is sensitive to the original defect,
and the original long-window reproduction no longer fails.

Limitations: the new test does not require a successful pre-close beat, use a nonzero
shutdown grace period, or force every possible in-flight repository/claim race. Its
before/after failure and the code inspection establish the targeted leak fix. No
broader shutdown guarantee is claimed, and no extra source change is requested.

**P2 resolved by `80eeb10`.** `test/conversation-turns/characterization.test.ts:627`
subscribes before prompting, filters for this turn's committed in-progress assistant
message (`:628`–`:629`), and releases a unique, initially absent gate file. The record
bus publishes after persistence commit. The lifecycle fixture emits the initial tool
start immediately at `test/fixtures/lifecycle-agent.ts:140`, emits its final message
at `:144`, then waits for the file (`:149`–`:159`) before replying with the result.
The 2ms polling interval checks a condition; it does not substitute elapsed time for
a completed commit. Cancellation while waiting changes `pending`, so the next check
returns without a second result. Ungated fixture behavior is unchanged. No fixed
completion delay remains.

This supplies the explicit event barrier requested by the original review, and leaves
the initial attachment-boundary stage sequence intact. It deliberately characterizes
commit-before-result delivery; it does not fix or pin a universal order for a final
chunk and result delivered together. That pre-existing unordered scenario remains a
disclosed limitation, not a reason to sort records or loosen snapshots. A failure to
write the gate is not swallowed (its rejection/test timeout fails verification).

### Snapshot integrity and independent checks

`git diff a6d0945..9de0ca3 -- test/conversation-turns/__snapshots__
test/conversation-turns/normalize.ts` is empty. Three independent ordinary characterization
runs passed, each with 35 pass / 0 fail and all 35 snapshots (12.65s, 12.68s, 12.95s).
The file hash after every run remained
`e19d85c8fed49ff4cd1fd514aa5f8ca03b9d22cc8c00fd964b64e2a978b8cb5a`.
No snapshots were regenerated. Source typecheck is clean; a temporary tsconfig covering
the added/changed tests and fixtures is also clean.

Verification used `/tmp/controller-a1-followup`, extracted from the exact reviewed commit,
and offline fixture processes only. The separate before-fix experiment copied only the
new test into an unchanged-beta temporary archive. No production source was edited by
the reviewer. The implementer's loaded stress runs were not repeated independently;
three ordinary stable runs plus the event-barrier inspection cover the requested gate.

**Final follow-up verdict: A1 gates now hold at `9de0ca3`, including the separately
approved fix.** The independently run complete `bun test` is **1,132 pass / 0 fail,
113 files, 35 snapshots, 88.39s**, with no unhandled error reported. P1 and P2 are
resolved; no blocking finding remains to return to the implementer. No split-run
substitution was used.

Remaining scope/interpretation limitations from the original review remain disclosed:
controller-level startup access, supervisor force escalation rather than explicit consumer
force stop, compact event capture, disabled background checkpoints, and the intentionally
gated completion scenario. Existing error strings remain pinned: no B1 snapshot/error-text
exception is granted. This verifies A1; it does not release A2, which still requires the
user's explicit release. No merge, push, or protected-path/process changes were made.
