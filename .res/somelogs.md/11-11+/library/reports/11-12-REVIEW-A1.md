# Independent review: A1 characterization tests

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
