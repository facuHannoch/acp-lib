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

## Control requests: deadlines removed; queue-default note

Decision (2026-10-18): the operation lifecycle covers model requests (turns, internal inference, recap) and cancel,
not control requests. The fixed control deadlines (`control.requestMs` / `initializeMs` / `loadIdleMs`, 60 s, which
force-stopped the process on expiry) contradicted "active by default": no hanging control request was ever observed,
a slow `session/list` during a healthy turn killed the turn (review item 2), and a large session that takes a minute
or more to load would be killed on every attempt. Control requests are back to the pre-spec behaviour: they end when
the harness answers or the process exits (the ACP SDK rejects pending requests when the connection closes).

- Removed `AcpClient.controlRequest`, `ProviderRequestTimeoutError`, the `provider_request_timeout` error code,
  `OperationLifecycleConfig.control` and its pass-through to the client (controller and manager), and the
  list/delete special case from fix 2 (now moot). `initialize` is raced against process exit only, as before.
  The `stop()` fence added with the deadlines stays; `forceStop` uses it.
- Tests: `operation-control.test.ts` removed (it only tested deadlines); the fixture's replay-interval option went
  with it. The list test now asserts that an unanswered `session/list` during a running turn neither fails nor stops
  the turn and stays pending until the process ends.
- Docs: spec section 6 rewritten with the reason, guarantee scope, settings and tests updated; plan row struck;
  changelog and consumer guide updated. The guide now states the `busyDelivery: "queue"` consequence in the lifecycle
  section and next to the `busyDelivery` setting: after a failure every prompt joins the hold until one is sent with
  `delivery: "steer"`.
- Validation: typecheck passed; full suite 1038 passed, 0 failed.
- Separate topic noted: automatic rotation or handoff for long sessions that load slowly.

## Spec: recovery steers stop at the next queued message (review item 5)

Spec section 4 now states the rule explicitly, with the user's example: after a stall, the steers combined into the
recovery prompt are those up to the next queued message, not including it; steers after a held queued message run
after it, in order. The implementation still combines steers across a held queued message; the fix is pending.

## Spec: hold trigger and release scope (review item 6)

Agreed and written into spec section 4: only a turn the provider received that ends `stalled` or `error` holds the
queue; a prompt rejected before it was sent holds nothing. Only a consumer turn that completes releases the hold;
internal prompts (recap and similar) do not. The implementation still holds on any queue-loop failure and releases on
any successful prompt-kind item; the fix is pending.

## Spec: continuation after a crash uses the existing rules (review item 3)

Agreed and written into spec sections Guarantee, 4, 9 and 11. Reconnect (`ensureProvider`) only notices the process is
gone, starts a new one and loads the session. When the load fails because the harness no longer has the session, the
conversation applies the rule it applies at open: Agent-owned checkpoint recovery (already reused via
`recoverInPlace`), SessionManager's `ContinuationStrategy` list via `acquireOpeningContinuation` (to be separated from
the opening-only transcript bootstrap), or `sessionLoadFailure` without persistence. With nothing left, the
conversation shows `continuation_unavailable` instead of failing every prompt with a load error. Guarantee 4 was
reworded accordingly: the next prompt runs or is refused with a visible, stable reason. Implementation pending; today
`ensureProvider` throws `provider_session_load_failed` on every prompt outside Agent-owned conversations.

## Implementation: review items 5 and 6

- **5. Recovery steers stop at the next queued message.** `SteeringController.prepareRun` combined steers by skipping
  held queue messages, so `steer, queue, steer` after a stall sent both steers together. `takeNext()` now records
  where it took the head from, and the run continues only with the items that directly follow it in the FIFO,
  stopping at any non-steer (held or not). `#headRun` (used for `followedBy`) applies the same rule from the first
  runnable item.
- **6. Hold trigger and release.** `supervisedPrompt` records the turn whose supervised provider request itself
  rejected (`providerFailedTurnId`); only that turn calls `steering.failed()`. A prompt that fails before reaching
  the provider (reconnect failure, owned preparation, blocked) ends with `turnEnded(undefined)` and holds nothing.
  `turnEnded` releases the hold only for a consumer turn (`#active` is set only for consumer prompts).
- Tests (`operation-lifecycle.test.ts`): "recovery steers stop at the next queued message; steers after it run after
  it" (the user's example: `what happened?` alone, then `deploy the website`, then `and update the record`) and "a
  prompt that fails before reaching the provider holds nothing" (a transient load failure via the fixture's new
  `LIFECYCLE_FAIL_LOAD_FILE`). Both fail without the fix and pass with it. Release by internal prompts is not covered
  by a dedicated test.
- Changelog and consumer guide updated. Validation: typecheck passed; full suite 1040 passed, 0 failed.

## Implementation: continuation after a crash (review item 3)

- `ensureProvider` keeps only reconnecting: start a process, load the session. A load failure goes to
  `continueWithoutProviderSession`, which applies the conversation's existing rule:
  - Agent-owned: `recoverInPlace` (unchanged); a `provider_session_missing` failure from it (no `recover` policy or
    no checkpoint) now marks the conversation unavailable instead of failing every prompt.
  - SessionManager (v2 transcript): `acquireOpeningContinuation` was split; the strategy loop is now
    `acquireContinuation(checkpoint, strategies, failedLoad?)`, called at open and after a crash with the current
    checkpoint and the reconstruction strategies of the list the conversation was opened with (stored as
    `continuationStrategies`). The opening-only parts (transcript bootstrap, staging a loaded session) stay in the
    opening path; the transcript builder now reads `v2TranscriptPath`.
  - No transcript persistence: `providerSession.onFailure` (stored as `sessionLoadFailure`; `"new"` for a
    conversation started new). `"new"` starts a fresh session and reports `provider_reconnected` with the new
    `via: "fresh"`.
  - A failure that is not "session missing" (`isMissingProviderSessionError`) stays transient: that operation fails
    with `provider_session_load_failed` and the next one retries.
  - With nothing left: `continuationAcquired = false`, so `promptability` reports `continuation_unavailable`, the
    prompt that found it rejects with the reason, and later prompts are refused.
- Tests (`operation-lifecycle.test.ts`): the detached reload test now uses a transient failure (fixture
  `LIFECYCLE_FAIL_LOAD_FILE`) and checks it stays promptable; new tests cover a detached conversation (`"new"` →
  `via: fresh`; `onFailure: "error"` → unavailable), a SessionManager conversation (load-only → unavailable;
  `new_from_transcript` → recovered with a new session), and an Agent-owned conversation without `recover` →
  unavailable. The three new tests fail without the change.
- Spec section 4 wording aligned (where the reasons are reported; the "no transcript persistence" row).
  Changelog and consumer guide updated. Validation: typecheck passed; full suite 1043 passed, 0 failed.

## Real-harness runs after the review fixes (2026-10-19)

Authorized by the user. test13 full runs on Codex, Claude and OpenCode, throwaway conversations only, data in the
session scratchpad, models not set. Results saved as `smoke-tests/test13-operationLifecycle/measurements/2026-10-19-*`.

- Codex (5000ms limits): s2, s5, m1 ×3 passed; s3 and s4 failed with `incomplete_response` stalls; s1 failed
  (no native permission request, as on 10-18).
- Claude (5000ms limits): s3, s4, m1 runs 1 and 3 passed; s2 and m1 run 2 failed with `incomplete_response`; s1 (no
  permission request) and s5 (the tool was not run) failed as harness coverage gaps.
- OpenCode: every model call rejected upstream ("free models aren't available from your current network ...
  abusive traffic from this IP"). Each failure surfaced as a normal prompt error; no configuration was changed.
- Rerun with 15000ms limits: Codex s3, s4 passed; Claude s2 and m1 ×3 passed. The 5000ms failures were real silences
  over 5 seconds (in s2/s3 on the prompt after the reconnect, not the frozen prompt: that one stalled `no_response`
  as expected). A first suspicion that trailing updates from the previous turn were misclassifying the phase was
  wrong. No library defect found. README now recommends 15000ms limits for real runs.
- Not exercised on a real harness: the item-3 path (harness lost the session after a crash); s2/s3 only cover a
  session that reloads.

## OpenCode real runs with a configured model (2026-10-19)

The user logged into OpenCode; the default model was still a free one, blocked from this network. At the user's
request the model was set for the runs only through `OPENCODE_CONFIG_CONTENT` (`opencode-go/deepseek-v4.1-flash`;
the user's OpenCode config is unchanged). A one-prompt check confirmed the model answers.

- Full run, 15000ms limits: s5 and m1 ×3 passed; s1 produced a chat question, not a permission request; s2, s3, s4
  stalled `incomplete_response` on the first prompt after the reconnect.
- Isolation: a raw `AcpClient` load-then-prompt in a fresh process answered in 2s; a mid-turn SIGKILL followed by
  load-then-prompt answered in 3s; the Agent API `forceStop` + reconnect answered in 2s; test13 s3 alone with 120000ms
  limits passed in 15s. s2–s4 together with 60000ms limits passed.
- Cause (harness behaviour, not a library defect): after a reload, OpenCode first completes the interrupted turn and
  only then answers the new prompt. In s3 the reply to "What exact keyword ...?" was the 8,800-character story the
  killed turn had asked for, followed by the keyword, completed 16s after the prompt. The silence is long enough to
  trip 15s limits; the 120/180s defaults cover it.
- Consumer-visible consequence to note for later: on OpenCode the reply after a crash recovery can contain the
  interrupted turn's output. Not addressed here.
- Results: `measurements/2026-10-19-opencode-*`. README updated (use 60000ms limits for OpenCode).

## Cleanup 1: comments, imports, dead code (no behaviour change)

- Doc comments put back on the code they describe: `meteredInternalPrompt` (was above `restartProviderFresh`), the
  metering config doc (was above `operationLifecycle`, which got its own), `lastUsageUpdate` in `AcpClient` (was
  above `stopPromise`; `stopPromise` and `pendingPermissions` got short docs), and `AcpTransport.onCrash` (was above
  `onDisconnect`, which now says it fires on any connection close).
- Imports moved below the file header comments in `agent-session.ts`, `client.ts`, `degraded/pty-client.ts`;
  duplicate imports merged; the inline `import("…")` types the branch added replaced by normal imports
  (`agent-session.ts`, `controller.ts`, `agent-conversation-owner.ts`).
- `AgentController.prompt`: removed a `try`/`catch` that could never catch (the client's `prompt` is async).
- `AcpClient`: the repeated permission-cancel and disconnect-listener loops became `cancelPendingPermissions()` and
  `notifyDisconnected()`.
- Validation: typecheck passed; full suite 1043 passed, 0 failed.

## Cleanup 2a: source style pass (no behaviour change)

- `src/operations/*`: header comment on the supervisor, doc comments on the exported types and limits, blank lines
  between members, one statement per line; the supervisor's repeated forced result and stall-error marking became
  `forcedResult()`, `stalled()` and `markCancel()`. Logic unchanged.
- `agent-session.ts`: `supervisedPrompt`, `ensureProvider`, `continueWithoutProviderSession`, `permissionWithAbort`
  and the long lines in the queue loop, `runPrompt` and `meteredInternalPrompt` split to the file's usual layout.
- `controller.ts`: an `ObservableLeaf` type replaces two inline casts; listener loops expanded. `client.ts`: the stop
  fence, permission cancel and permission race expanded. `acp-transport.ts`: the seven request wrappers share one
  `observed()` helper.
- `agent/error-record-writer.ts` re-indented with a doc comment; long lines split in `agent.ts`, the conversation
  manager, the internal-inference handles and manager, and the steering controller (which gained
  `#queuedMessages()` for the hold/release loops).
- Validation: typecheck passed; full suite 1043 passed, 0 failed.

## Cleanup 2b: test style pass (no behaviour change)

- `operation-lifecycle.test.ts`: shared helpers (`tempDir`, `ownedAgent`, `recordEvents`, `hangingPermission`,
  `harnessPid`), static imports instead of per-test dynamic ones, one statement per line. Test names and assertions
  unchanged; the list test now uses the common `conversation()` helper.
- `operation-supervisor.test.ts`: the fake clock expanded, `completed()` and `controllablePrompt()` helpers.
  `operation-stale-policy.test.ts`: the fixtures split onto lines.
- `fixtures/lifecycle-agent.ts`: a header documenting its modes and faults; the prompt handler moved to its own
  function; one statement per line.
- Validation: full suite 1043 passed, 0 failed; test13 mock s1–s5 passed.

## Cleanup 3: test13 runner and README (no behaviour change)

- `index.ts`: one function per scenario (`s1`, `freezeOrKill` for s2/s3, `s4`, `s5`, `m1`), helpers `check`,
  `harnessPid`, `newConversation`, `recordEvents`, `ask` (mock or real prompt); one statement per line. Variables,
  console lines and the `results.json` format are unchanged. Mock run: s1–s5 and m1 ×3 passed.
- `README.md`: rewritten in the test11 layout (how to run, variables table, scenarios table, reading the results,
  results by date). The 15000ms / 60000ms limit advice and the `OPENCODE_CONFIG_CONTENT` model override are in
  the variables and intro; all earlier findings kept.

## Deprecate AgentConversation.listSessions()

Agreed with the user. `AgentConversation.listSessions()` (legacy SessionManager surface) merges the catalog and the
harness's `session/list` into `MergedSession[]`, puts the harness id in `agentSessionId` for harness-only entries,
and swallows a harness listing failure. It is marked `@deprecated` in favour of `agent.conversations` and
`agent.conversations.listProviderSessions()` (which propagates failures). Behaviour unchanged. Changelog updated;
the user's README.md example was not touched.

## Item 3 on real harnesses: test13 s6 and the missing-session classifier

- New test13 scenario s6: stop the process, delete the session in the harness (`session/delete`, or
  `opencode session delete` for OpenCode, which does not offer it over ACP; only sessions the run created), prompt
  again. Without a checkpoint: expects `provider_session_missing` and `continuation_unavailable`. With a second Agent
  (`onLoadFailure: "recover"`, its own `agent.sqlite-recovery`) and a manually published checkpoint: expects
  `via: "recovered"`, a new provider session and the keyword. The mock fixture now deletes on `session/delete`.
- First real run: Codex and Claude failed with `provider_session_load_failed`, i.e. the missing session was treated
  as transient and every prompt would fail. Probes captured the errors: Claude `-32002 Resource not found: <id>`;
  Codex `-32603 Internal error` with `data.details` "session <id> is archived. Run `codex unarchive <id>` ..." (its
  delete archives) or "no rollout found for thread id" (never existed, already recognised); OpenCode `-32603
  Internal error: OpenCode service failure` with `data.service: "session"` (already recognised).
- `isMissingProviderSessionError` now also recognises `-32002` (ACP resource not found; the classifier only sees load
  failures) and the Codex archived text. Unit tests added in `test/checkpointing/recovery.test.ts`.
- Rerun: s6 passed on Codex, Claude and OpenCode (DeepSeek V4.1 Flash via `OPENCODE_CONFIG_CONTENT`). Results in
  `measurements/2026-10-19-*-s6*.json`. Full suite 1044 passed; mock test13 s1–s6 passed.

## listSessions(): a failed harness listing throws

Following the deprecation, `AgentConversation.listSessions()` no longer swallows a failed harness listing; it throws
instead of returning the catalog half as if complete. The REPL's own listing code is unchanged. Test: "a failed
harness listing is reported by the deprecated merged listSessions" (fixture `LIFECYCLE_FAIL_CONTROL`, committed with
the s6 change). Changelog updated. Full suite 1044 passed.

## Consumer guide: harness behaviours after a crash; OpenCode issue draft

The lifecycle section of `CONSUMER_GUIDE.md` now notes two observed harness behaviours: OpenCode completes the
interrupted turn before answering the next prompt after a reload, and Codex archives a deleted session (treated as
missing). An issue for OpenCode was drafted for the user to review and post; it was not posted.

## 2026-10-19: test13 s1 covered on OpenCode

s1 (interrupt while the permission handler never answers) had never run on a real harness: none asked for
permission. OpenCode asks when given `"permission":{"bash":"ask","edit":"ask"}` in `OPENCODE_CONFIG_CONTENT` (for the
run only, with `"model":"opencode-go/deepseek-v4.1-flash"`). The real s1 prompt was reworded to tell the model to call
the bash tool without asking first (the old wording invited a chat question); the mock path is unchanged and passes.
One real run: s1 passed (AbortSignal fired, prompt `cancelled`, `cancel: "acknowledged"`, next prompt completed).
No library change. Results in `measurements/2026-10-19-opencode-s1.json`.

## 2026-10-19 — compaction silence on OpenCode (test7)

Added an opt-in `--record-updates <file>` to `smoke-tests/test7-compaction/compaction-smoke.ts` (raw
`session/update` lines with timing). One stress run on OpenCode 1.18.34 with DeepSeek V4.1 Flash, 12k
window: 40 compactions in ~175s. The summary streams as `agent_message_chunk` (3,005) and
`agent_thought_chunk` (525); no `tool_call`. First update after a compaction starts ≤ 1.3s, longest gap
4.4s: no stall risk at 120/180s. Compactions lasted 2–6s; a long compaction on a large context is not
measured. Noted in the test7 README. The throwaway OpenCode sessions were deleted.
