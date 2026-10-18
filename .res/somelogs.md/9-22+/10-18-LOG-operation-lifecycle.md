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

## Phase 6 — control-request deadlines

- Added one AcpClient deadline helper for initialize, new, list, delete, config and replaying load/resume/fork requests. Load deadlines refresh on matching replay updates; authentication remains untimed.
- Expiry throws ProviderRequestTimeoutError, starts process teardown synchronously and preserves a stop promise so reconnect waits for cleanup. Startup timeouts are never swallowed as the controller's unauthenticated-session compatibility fallback. Owned configuration timeout failures use the shared error writer.
- Validation: typecheck passed; 26 tests passed across controls, launcher, session loading/commands and lifecycle. Coverage includes silent initialize/new/list/config/delete/load, replay lasting beyond the idle deadline while making progress, authentication outlasting requestMs, and launcher preparation outlasting initializeMs.
- Review: every deadline and replay subscription is removed at settlement; timeout remains the primary diagnosis even when killing closes pending SDK requests. Invalid deadlines are rejected before spawn.
- Known limitation: generic `npx` (or another installer wrapper) gives ACP no signal for when a download ends and its child starts reading. Initialization timing begins after launcher preparation and transport startup; preparatory downloads belong in a custom launcher's prepare() to exclude them. A default npx command that downloads after spawn is still counted. This readiness gap is logged explicitly rather than pretending stdio exposes an unobservable child-readiness event.
- Testing gaps: no real interactive login, installer download, or prolonged production replay measured here. No new regressions identified; the baseline restoration timestamp failure remains.

## Phase 7 — measurements, defaults, release documentation and combined review

- Ran m1 on three throwaway Codex sessions and three Claude sessions, using default models. Codex: first protocol output 8–12ms, longest observed tool-free silence 3260–4128ms, cancel acknowledgement 32–72ms, load 514–621ms. Claude: first output 3–15ms, silence 1989–4296ms, cancel 4–5ms, load 828–848ms. Protocol output includes non-text updates, as required by the spec.
- Ran a longer Codex m1 with 24 extra short turns: 53 replay updates, load 554ms, maximum replay gap 535ms (including initial wait), cancel 10ms. Automatic compaction was not forced. Retained conservative 120s/180s output limits, 30s cancellation grace and 60s controls because these measurements do not justify tighter compaction-sensitive defaults.
- Full test13 mock run passed all six scenarios. Real Codex passed freeze/load/context, kill/load/context, recovery-steer/hold/release and measurements. Strengthened s5 to require an actual tool and elapsed duration: the 20-second real Codex tool passed. Codex s1 did not issue a native permission request, so its real permission scenario is a recorded coverage gap, not a pass.
- OpenCode m1 and every full-run scenario were attempted, but the default upstream rejected model calls: its free tier is restricted to use within OpenCode. No model or provider settings were changed to work around that external restriction. Raw summaries are committed under smoke-tests/test13-operationLifecycle/measurements/; transient SQLite databases remain in /tmp for inspection.
- Added release notes and consumer documentation. Smoke runs now continue independent scenarios, preserve failure summaries, and print ten-second elapsed heartbeats. m1 also measures actual load duration/replay gaps, with an optional history-turn count.
- Full review initially found one exact snapshot assertion that omitted the three new documented fields; updated that assertion. Existing event-ordering tests pass. This was an expected additive contract change, not changed ordering. The full baseline's intermittent restoration timestamp failure did not recur in the final full gates.
- Review fixes: cancel notification failures cannot stop escalation; synchronous failures of cancel/force primitives remain bounded; a completed turn winning the cancel race no longer claims acknowledgement; controller forceStop rejects pending prompts with ForcedStopError; stop fencing survives teardown and is awaited before reuse; handoff targets use their own adapter grace (new test completes in 138ms despite a 2000ms source grace).
- Degraded-mode review: raw terminal output now feeds visibility. Its default output-silence limits stay disabled because PTY mode cannot identify tools or permissions; explicit configured limits and bounded cancellation remain available. This avoids introducing false stalls for long-running degraded tools. Real PTY execution was not tested.
- Validation: typecheck passed; final full suite 1039 passed, 0 failed. The subsequently added target-grace integration test and related lifecycle/handoff/supervisor gates passed 24/24. Prior focused combined review gates passed 47/47. Full source diff whitespace checks passed. No unresolved implementation regression identified.
- Remaining scope gaps: real Codex permission cancellation (fixture coverage passes); OpenCode upstream access; forced automatic compaction; installer readiness inside spawned commands (phase 6); persisted turn-ending requirement 3 and SessionManager library-crash uncertainty remain separate as described by the spec. Manual end-to-end testing follows this commit and the completed source review.

## Manual end-to-end review — delivery-order correction

- Manually drove a new real Codex conversation through seed, SIGSTOP, prompt, queued message, status inspection, explicit repair steer, record inspection and clean shutdown using an interactive API driver (no model selection).
- Functional results: OperationStalledError/no_response/forced; disconnected + idle with a visible held queue; repair loaded the same provider session and remembered MANUAL-KIWI-742; held message then completed DONE; one canonical stalled record with phase; final connected/idle state and no pending messages.
- Manual observation caught a phase 4/5 integration regression: message_delivered was emitted by prepareRun before ensureProvider completed, so it preceded provider_reconnected. Fixed by retaining batch selection timing and deferring only the delivery notification until the provider is ready. A failed reconnect now emits no premature delivery notification.
- Validation: typecheck passed; 41 steering/lifecycle/state/queue tests passed, including a new assertion that provider_reconnected precedes stall delivery. Reviewed the small diff: combining still happens before turn_started observers can enqueue more work, preserving existing batching semantics. The committed pre-correction full suite passed 1040/1040. Repeating full checks and the manual scenario on the corrected code follows.
- Testing gap: the first manual run is evidence for functionality and discovery of the ordering bug; it is not claimed as a clean final pass. Its database remains at /tmp/acp-operation-manual-1792288950155/agent.sqlite.

## Final corrected validation and manual end-to-end pass

- On commit 419936e, typecheck and the complete suite passed: 1040 tests, 0 failures, 4076 assertions across 106 files (68.41s). Reviewed the complete branch diff with git diff --check; no whitespace errors. The original restoration timestamp failure did not recur, and no unrelated restoration code was changed.
- Repeated the interactive real Codex manual scenario on the corrected committed code. A fresh conversation remembered MANUAL-KIWI-742. Froze only its own newly spawned harness PID 162015 with SIGSTOP, started a prompt, and added an explicit queue message. Observed waiting → cancelling(reason stalled), then OperationStalledError with code stalled, phase no_response, cancel forced.
- Manually read status after failure: idle, disconnected, promptable, one queued message held by the failed operation. Sent an explicit steer through the same conversation object. Observed provider_reconnected(via loaded) BEFORE message_delivered(via stall), confirming the ordering correction. The repaired model returned MANUAL-KIWI-742; message_released fired; the queued turn completed with DONE.
- Inspected persistence through the API: exactly one stalled error record, source operation, recoverability retryable, the failed operation ID, and phase no_response. The active provider-session mapping retained 01a14cc0-a72e-7502-8185-0ff7909b878a across recovery. Final snapshot: connected, idle, operation null, hold null, zero queued messages. Clean shutdown completed successfully.
- Final manual artifacts: /tmp/acp-operation-manual-1792289055860/agent.sqlite (conversation agc-3bcb0811-b579-48bc-adfc-90b8884a159e). The disposable interactive driver was /tmp/acp-operation-manual.ts. Artifacts are local inspection evidence and are not committed databases.
- Cleaned up the obsolete sandbox-restricted initial baseline run and its known fixture processes after the successful unrestricted validation. Remaining working-tree changes are the user's original README.md/todo.md edits and original untracked files; none were included in implementation commits.
- Testing scope: unit/fake-clock policy and escalation, real ACP fixtures, full regression suite, all mock smoke scenarios, real Codex/Claude measurements, real Codex freeze/crash/long-tool/steer smoke checks, and a manually driven real Codex recovery. Remaining gaps and known limitations are listed in phases 6–7 (OpenCode provider access, native Codex permission scenario, compaction, PTY execution and installer readiness). No unresolved regression produced by these commits remains identified.

## Post-implementation review — fixes 1, 2, 4

A review of the whole branch diff (2026-10-18) found defects not listed above. Three were fixed here; the others
(missing-session recovery outside Agent-owned checkpoints, steer combining across held messages, the hold's
trigger/release scope, and maintainability) wait for decisions or a cleanup pass.

- **1. A normal completion racing the stall cancel was reported as a stall.** The supervisor threw
  `OperationStalledError` whenever the stall timer had fired, even if the harness then answered `end_turn`, so a
  complete reply was stored as failed. It now reports a stall only when the request really ended cancelled.
  Test: `operation-supervisor.test.ts` "a turn that completes normally after the stall cancel keeps its result".
- **2. A timed-out `session/list` killed the running turn.** `AgentConversation.listSessions()` sends it outside the
  queue on the live client; its deadline stopped the process and the working turn failed with `ACP connection
  closed`, while `listSessions()` still reported success. `session/list` and `session/delete` now fail only the
  request on expiry; startup, load and configuration requests still stop the process. Spec section 6 updated.
  Tests: `operation-lifecycle.test.ts` "a session/list that times out during a running turn fails only the list";
  `operation-control.test.ts` now expects list/delete to keep the process.
- **4. Late output after a forced stop.** On inspection, updates were already safe: `AcpClient.stop()` clears the
  session id and `handleUpdate` drops updates for any other session. The remaining hole was a permission request
  the dying process wrote after `stop()` without a prior cancel; it is now answered `cancelled` without reaching
  the finished turn's handler. Not covered by a dedicated test (the window is the SIGTERM→SIGKILL interval).
- Both new tests fail without the fixes and pass with them. Validation: typecheck passed; full suite 1042 passed,
  0 failed.
- Gap still open: `AgentConversation.listSessions()` swallows a provider listing failure and returns the catalog
  entries only; that predates this branch and was left unchanged.
