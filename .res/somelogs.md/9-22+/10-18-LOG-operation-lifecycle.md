# Operation lifecycle implementation log

Branch: `operation-lifecycle`, created from the current `session-loading` checkout at the user's correction (not alpha).
Existing README/todo edits, README-n, .agents, and the unrelated HTTP-controller note are excluded from commits.
This is the log requested by the user; it supersedes the old log filename mentioned in the plan.

## Baseline

- Typecheck passed. Sandboxed integration tests could not start ACP fixtures reliably; the targeted suite passed outside the sandbox (12/12).
- Full baseline outside the sandbox: 1012 passed, 1 failed. Existing failure: `SessionManager.restoreAgentSession > stages provider identity before publishing the restored record`: expected simulated restored-record failure, got `internalSessionActivatedAt must not be after updatedAt`. This predates implementation; retained as a known baseline issue.

## Phase 0 — preparatory extractions

- Extracted the existing transactional error writer, tool timing tracker, injectable timers, and output subscriptions across ACP clients/controller leaf replacements. Requests for files and terminals also count as output.
- Steering uses the extracted tracker with the same settling rules. Observation callbacks isolate listener exceptions.
- Added test13 skeleton, documentation, and m1 measurements with mock/real adapters and disposable SQLite artifacts.
- Validation: typecheck passed; focused steering/error/tracker tests: 29 passed. Mock m1 passed (first output 10ms); its immediate mock completion is correctly labelled completed rather than an acknowledged cancel.
- Review: writer body retains the existing capture, transaction, audit and publish sequence; no content is retained by output observers.
- Testing gaps: mock m1 cannot measure actual cancel acknowledgement or compaction. Real measurements are deferred to phase 7. Baseline restoration timestamp failure remains unrelated.
- Full phase 0 gate: 1013 passed, the same 1 baseline restoration test failed, with the same diagnosis; no new regression identified. The plan's literal all-green baseline gate cannot be met without addressing that pre-existing issue; proceeding with the baseline explicitly accounted for.

## Phase 1 — supervisor, visibility, bounded cancel

- Added a supervisor per visible/internal prompt, operation snapshots and stage events. During supervised turns steering reads the supervisor's tool-boundary callback; only the supervisor tracks tools for those turns.
- Permissions receive an optional AbortSignal, settle cancelled on interrupt/process exit/stop, ignore late consumer answers, and leave the permission handler's promise unable to block ACP cancellation. The session wrapper records the cancelled decision too.
- Cancellation resends at half grace and force-stops at grace. Forced interrupts resolve as cancelled, retain captured partial response content, and report `cancel: forced` and `endedBy: interrupt`.
- Validation: typecheck passed, 34 tests passed (supervisor fake clock, actual ACP permission/ignored-cancel fixtures, existing steering and permission regressions); mock test13 s1 passed through a second prompt.
- Review: timers and output listeners are disposed after settlement, repeated cancels preserve the first reason, unrelated session output is filtered, and forced-stop teardown starts before queue release.
- Testing gaps: automatic reconnect after forced stop belongs to phase 4. Real s1 depends on the harness exposing an actual permission request. Fixture tests cover late/unanswered permission handling but do not cancel arbitrary filesystem/terminal host work. No new regressions identified in the focused checks; the baseline restoration issue remains.

## Phase 2 — stale detection and recorded failures

- Added a pure stale policy (first/next output, independently disabled limits, optional oldest-tool deadline), validated limits, and supervisor timers that suspend for permissions/tools.
- Stalls cancel through the same bounded path and reject with OperationStalledError, phase, operation ID, partial messages, cancellation disposition and metering. Existing failure capture persists partial replies as failed. Stalled metering closes cancelled with no invented usage.
- Added Agent and detached-conversation lifecycle config, owner operationFailed hook, shared error writer use, error codes and allow-listed phase details. Confirmed canonical error publication on the committed-record bus.
- Validation: typecheck passed; 32 tests passed across lifecycle, supervisor, policy and existing error-record suites; mock test13 s5 passed. Checked both silent phases, optional tool timeout, permissions lasting beyond limits, failed partial messages and committed stall errors.
- Review found and fixed a phase 1 integration regression: AgentAdapterRegistry copied only the old adapter fields, losing cancelGraceMs, so Agent-owned conversations silently used 30 seconds. It now validates and preserves the configured grace, including transition snapshots. The owned fixture test exposed this by timing out, and now passes.
- Testing gaps: forced-stop recovery is still phase 4, so phase 2 does not yet promise a second prompt after forced stop. Real compaction signals and upstream header stalls remain unmeasured. Baseline restoration failure remains; no additional known regression after the registry fix.
