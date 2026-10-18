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

## Phase 3 — internal inference and recap

- Routed disposable harness inference through the same supervisor and Agent-level settings. Abort requests use bounded cancellation. Internal handles expose a live operation snapshot via a getter, so lastOutputAt remains current without a per-token event stream.
- Kept the existing retry/backoff strategy intact; failed attempts retain providerCode stalled and phase in failureDetails. Stalled attempts meter as cancelled. Hidden recap stalls follow the existing adoption failure record and baseline-floor path.
- Validation: typecheck passed; 59 tests passed across lifecycle, harness runtime, durable inference manager and existing adoption tests. New integration coverage proves stalled inference retries into a second fresh session, stage visibility, durable stall details, and adoption completing after a stalled recap with a baseline checkpoint.
- Review: output subscriptions and timers end with each disposable session; inference activity is cleared on settlement. Existing small-history adoption rules intentionally create no baseline floor when nothing lies beyond the recovery tail; the stall test uses history beyond that tail.
- Testing gaps: real-harness inference retry and automatic compaction remain for measurements; custom runtimes without output subscription cannot report output activity. No new regressions identified; baseline restoration timestamp issue remains.

## Phase 4 — reconnect and checkpoint recovery in place

- Read open/start, continuation acquisition, provider attachment and checkpoint recovery end to end before refactoring. Extracted the existing load classification/error/recovery block into one manager method; both open and reconnect use it. The existing recovery rules fit an injected fresh-conversation acquisition callback.
- Fixed dead-leaf detection, added strict controller reconnect, teardown fencing, connection snapshots and provider_reconnected events. Provider operations ensure their leaf is connected; failed reloads remain retryable with the prior session attachment.
- Agent-owned checkpoint recovery seeds and records a fresh provider thread on the original conversation object. Detached/SessionManager paths only reload, retaining their existing transcript uncertainty rules.
- Validation: typecheck passed; 47 lifecycle, startup, continuation, load and error-record tests passed. Mock test13 s2/s3 passed with real SIGSTOP/SIGKILL, stored stall error and retained context after the next prompt. New tests cover forced interrupt/stall followed by prompt, immediate next prompt after a crash, in-place checkpoint recovery and a failed load followed by a successful retry.
- Review caught a disconnect ordering race: SDK request rejection can precede the process exit callback. Transport now checks the SDK AbortSignal synchronously and notifies connection observers on abort, preventing the next prompt from reusing a dead stream. Recovery failures stop the candidate and restore the old logical attachment for retry.
- Testing gaps: real adapter reloads and long histories remain for phase 7. The SessionManager process-death uncertain boundary remains explicitly out of scope. No new regression identified; baseline restoration timestamp issue remains.

## Phase 5 — recovery steers and held queues

- Added stalled/error turn endings, stall delivery, held/released events, heldBy on pending messages and pendingHold on snapshots.
- The serial executor now accepts a selection callback. Steering selects eligible work while preserving held queue messages in place; recovery steers can combine across those held messages. The next normal turn releases the hold; explicit queue messages remain held, and withdrawal works.
- Stall rejections include followedBy IDs for the combined recovery steers. Interrupt/steer behavior is unchanged, including a cancel that loses a race with normal completion.
- Validation: typecheck passed; 35 lifecycle/steering/queue tests passed; mock test13 s4 passed using SIGSTOP. Added integration coverage for a queue ahead of two recovery steers, idle hold, explicit queue during hold, withdrawal and ordered release.
- Review: held-only conversations become idle without spinning the drain; controls remain eligible; default busyDelivery queue continues to require an explicit steer after a failure, as specified.
- Testing gaps: message hold/release events are live (captured in smoke results), not new canonical record kinds. Persisted turn-ending storage remains the separate requirement 3 identified by the spec; this phase extends the typed values. Real harness s4 remains for phase 7. No new regression identified; baseline restoration issue remains.
