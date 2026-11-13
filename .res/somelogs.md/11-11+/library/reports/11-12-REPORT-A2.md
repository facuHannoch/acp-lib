# Report: Brief A2, the turn path (controller interface)

Spec: `../11-11-SPEC-controller-interface.md` (beta `1bda9ef`). Branch `controller-interface`
(beta merged in `d48ddcb`; beta-update report `11-12-REPORT-A2-beta-update.md`). Status and
release: bob-b, `controller-interface-status` at `14f56c4`.

**State: steps 1–4 done; review findings fixed in `e7f2d79`, `f54dc05` and `9e0f457`; the owner's
decisions (beta `fd9ec24`, `95e9cf2`) merged in `174200e` and `83114f1` and applied in the one
dedicated snapshot-exception commit `2f3b073` (which replaces `1ad325d` after the final review, then
`5eeb54c` after the watcher review). Gate: full suite 1,187 pass / 0 fail (two runs).**
The accepted connect/reconnect hang (spec, "A known hang, accepted for now") is unchanged and
represented as accepted (open question 3, answered). The spec correction (beta
`fcd1fd4`) was merged in `efe6ebe`; steps 2–4 were released at status `6992179`. The spec question
was
`.plan-execution/status/11-12-ISSUE-A2-turn-events.md` is corrected on beta and both branches have
brought the correction in. That question: `TurnEvent = TurnStarted | TurnTook`, versus
"`turn_started` is the only turn event the controller reports".

## Spec correction brought in (`efe6ebe`)

Task: `.plan-execution/tasks/controller-interface-A2-correction.md` (status `bef318c`).

| Item | Value |
| --- | --- |
| Beta brought in | `fcd1fd49b6bf844724fb86a3040b0866e0ec4488` |
| Method | `git merge --no-ff fcd1fd4` into `controller-interface` (no rebase; all commits kept, including step 1 `0383681` and its report `db3d979`) |
| Result | merge `efe6ebe`; `git merge-base --is-ancestor fcd1fd4 HEAD` holds; no conflicts |
| What it changed | only `library/11-11-SPEC-controller-interface.md`, 3 lines added and 2 removed: "the controller reports only the start of turns, never their end: `turn_started`, and for backend-scheduled controllers `turn_took`"; plus the unrelated typo `subscgentribe` (no contract effect, already noted for the spec owner) |
| `src/`, `test/` | unchanged by the merge; step 1's gate stands |

Effect on A2: the contracts (step 2) declare `TurnEvent = TurnStarted | TurnTook`, and the doc
comment says the controller never reports a turn's end. The `HarnessController` reports only
`turn_started`. Steps 2–4 stay held until bob-b confirms both branches contain the correction.

## Step 1: move `runPrompt` (`0383681`)

**What moved.** `AgentSession.runPrompt` (beta lines 3337–3788) is now `runTurn(ctx, item)` in
`src/conversation-turns/run-turn.ts`. `AgentSession.runPrompt` remains as a one-line,
non-async method returning `runTurn(this.turnRunContext(), item)`, so `pump` calls it exactly as
before and the promise it awaits is `runTurn`'s own.

| File | Lines | Contents |
| --- | --- | --- |
| `src/conversation-turns/run-turn.ts` | 336 | the turn, phases marked in today's order |
| `src/conversation-turns/recording.ts` | 205 | phase 3: the recording handlers and assistant-message state, built synchronously |
| `src/conversation-turns/context.ts` | 110 | `TurnRunContext`, and `PromptQueueItem` (moved from `agent-session.ts`) |
| `src/conversation-turns/record-helpers.ts` | 92 | the pure helpers the turn uses, moved verbatim (`legacyTranscriptText`, `legacyTranscriptMessages`, `persistenceOperationKind`, `toPersistenceJsonValue`, `defaultPermissionOutcome`, `permissionRecordOutcome`, `permissionWithAbort`); `agent-session.ts` imports the two it still uses |
| `src/conversation-turns/index.ts` | 2 | exports |

**Phases, in today's order** (header comment of `run-turn.ts`):
1. prepare: `beforePrompt`, participants, turn bookkeeping;
2. user records and the metered operation per mode (managed: preflight, then `beginOperation`,
   user presentation events, `syncBeforeDispatch`; detached: legacy user line, then metering);
3. recording handlers;
4. dispatch under the supervisor;
5. assistant records, metering closed before local persistence, transcript;
6. `afterPrompt`;
7. failure path.

No statement was reordered: the body is the original text with `this.x` replaced by the
matching context member.

**The context object.** `TurnRunContext` is grouped as the spec lists it: `controller`,
`supervisedPrompt`/`supervising`, `persistence`, `presentation`, `metering`, `steering`, `owner`
(lifecycle and owned-record chain), `turn` (begin/end/activity records), `log`, plus `session` for
the session state the turn reads or updates (cwd, default permission, internal session id, title,
participants, provider attachment, last recorded internal session id). Everything the session can
replace (controller, transcript runtime, attachment, owned-record chain tail, ...) is a getter, read
at the same moments the method read `this.…`. The session itself is not passed.

**Gate:**

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean |
| A1 characterization, three runs without update | 35 pass each (13.9 s, 12.6 s, 13.0 s); snapshot unchanged, SHA-256 `e19d85c8fed49ff4…` |
| full suite `bun test` | **1,132 pass, 0 fail, 113 files**: 101.6 s, then 89.3 s on a second run (the first was machine noise; earlier baseline 88.7 s) |
| `agent-session.ts` | **4,546 lines** (from 5,022; spec expects about 4,550 or less) |

**Deviations and why:**
- **Phases are marked sections in one function, not one function per phase.** The awaited phases
  (1, 2, 4–7) stay in one async function: moving each into its own async function would add a
  scheduling point at every phase boundary. A1 showed the turn path's record writes are sensitive
  to interleaving (the owned-record chain against direct metering writes), so "no phase is
  reordered" is safest kept literal. Only synchronous code moved out: `recording.ts` and
  `record-helpers.ts`. `run-turn.ts` stays under the spec's ~400-line split threshold.
- **Two extra files** beyond the spec's list (`recording.ts`, `record-helpers.ts`), for the split
  above. `PromptQueueItem` moved to `context.ts` so `run-turn.ts` doesn't import from
  `agent-session.ts`.
- **Imports pruned** in `agent-session.ts`: those only the moved code used (e.g.
  `ResponseAccumulator`, `OwnedPromptPostCommitError`, `unresolvedParts`).

**Limitations / risks to watch:**
- **The context is not small:** about 35 members across 9 groups. That is the spec's Risks sign
  ("hidden coupling in `runPrompt`"). It still doesn't pass the session, and each member is one
  thing the original method touched. Step 4 replaces the queue item with a turn context and may let
  some of it shrink.
- **Possible gaps:** the A1 snapshots and the full suite are the evidence that order didn't change;
  no new tests were added in step 1 (the brief asks for none).

## Commits (A2)

| Commit | Step | Content |
| --- | --- | --- |
| `0383681` | 1 | `runPrompt` moved to `src/conversation-turns/` |
| `b5d13a9` | 2 | `src/conversation-controller/contracts.ts`, `index.ts` |
| `d8c1fe2` | 3 | `AgentController` turn methods; `SupervisedProvider` moved; `supervisedPrompt` takes a provider |
| `47d9931` | 4 | `AgentSession` drives turns through `send`; turn context; `cause`; `abandonTurn`; new tests |
| `cffce98` | 4, snapshot-only | A1 snapshots gain `cause` on `turn_started`: **237 lines added, 0 removed**, all inside `cause` blocks (39 blocks × 6 lines, plus one extra id for each mode's combined steer run) |

Between `47d9931` and `cffce98` the A1 characterization fails only on the missing `cause` (the
brief puts the snapshot change in its own commit). The gate is on `cffce98` and later.

## Step 2: contracts (`b5d13a9`)

`src/conversation-controller/contracts.ts`:
- **Members:** `ConversationController`'s turn members (`send(run): Promise<void>`, `subscribeTurns`
  with `TurnEvent`, `prepareTurn`, `abandonTurn`, `subscribeOutput`, `cancel`, `forceStop`, optional
  `prepareInternalPrompt`).
- **Types:** `TurnRun` (optional `turnId`), `TurnContent`, `PreparedTurn`, `TurnCause`,
  `TurnStarted`, `TurnTook`, `TurnEvent`, `StartResult`, `ControllerStartEvent`.
- **Doc comments** follow the corrected wording: the controller reports only the start of turns
  (and `turn_took` for backend-scheduled ones), never their end.
- **Not here yet:** the lifecycle, settings and capability members, and `implements`, are B1's (the
  file says so).

Gate: typecheck clean.

## Step 3: `AgentController` turn methods (`d8c1fe2`)

- **`send(run)`:**
  - requires `turnId` (error: "send: a session-scheduled run requires its turnId");
  - throws on an empty or repeated message id list;
  - records the turn as reported and calls the turn listeners synchronously with `turn_started`
    (`sentBySession: true`, cause = the run's message ids);
  - returns `Promise.resolve()`.
- **`prepareTurn(turnId, content)`** marks the turn executed and returns a `PreparedTurn`:
  - `live: true`;
  - `prompt()` calls today's `prompt({ ...content.input, handlers: content.handlers })`;
  - `subscribeOutput`, `cancel` and `forceStop` are the controller's own.
  - It starts nothing.
- **`prepareInternalPrompt(content)`:** the same, without bookkeeping.
- **`abandonTurn`:** removes the turn from the reported set; idempotent; never stops work.
- **`SupervisedProvider`** moved to `src/operations/contracts.ts`; `supervisor.ts` re-exports it.
- **`supervisedPrompt`** takes a `SupervisedProvider` instead of a closure. The turn passes
  `controller.prepareTurn(...)`; the internal prompt passes
  `controller.prepareInternalPrompt({ input: { text }, handlers: {} })`. `OperationSupervisor` is
  unchanged and still subscribes before calling `prompt()`.
- **`prompt`** stays.

Gate: typecheck clean; A1 snapshots unchanged (three runs); full suite 1,132 pass / 0 fail, 91.3 s.

## Step 4: the session drives turns (`47d9931`, `cffce98`)

- **`pump`'s prompt branch**, in order:
  1. `steering.prepareRun`, `steering.turnStarted` (unchanged);
  2. build the run (`turnRunOf`: turn id = first message id, `messageIds` = every original message);
  3. check it (`checkTurnRun`);
  4. register `sentRuns[turnId]`;
  5. `await controller.send(run)`. The controller reports `turn_started` inside the call, and the
     session's listener emits the public `turn_started { turnId, cause }`, at the same point in the
     sequence as before (after `turnStarted`, before `ensureProvider`);
  6. then `ensureProvider`, delivery report, `runTurn({ turnId, cause, messages: prompt })`,
     `turn_completed`;
  7. on failure: `controller.abandonTurn(turnId, err)` (idempotent: a no-op once the turn was
     prepared), then `turn_failed`, as before;
  8. `sentRuns` cleared in `finally`.
- **The listener** is bound in `bindController` like the other controller subscriptions, guarded
  by `this.controller === controller`:
  - `turn_took`: logged and ignored (B2);
  - a turn with `sentBySession: false`: logged and abandoned (B2);
  - a report for a turn the session didn't send: logged.
- **`runTurn(ctx, turn: TurnContext)`** with `{ turnId, cause, messages? }`. Today's preparation runs
  from `messages`; a turn without messages throws (B2; no ACP path reaches it). `recording.ts` now
  takes the turn id and the consumer's handlers rather than the queue item.
- **Public:** `turn_started` gains `cause: TurnCause` (`agent-conversation-contracts.ts`).
- **Completion** stays after finalization; no phase moved.

**New tests** (`test/conversation-turns/turn-path.test.ts`, 7):
- a combined steer run: `turn_started` causes are `[first]` and `[a, b]`; user record ids are
  `first:user`, `a:user`, `a:user:2`;
- a provider-connection failure: `abandonTurn` is called once with the turn id, `prepareTurn` never,
  events `turn_started, turn_failed`, and the prompt rejects;
- a finalization failure (`afterPrompt` throws after the provider finished): `turn_failed`, no
  `turn_completed`;
- a config change queued during a slow `afterPrompt`: order `afterPrompt:start`, `afterPrompt:end`,
  `turn_completed`, `configuration_started`. A 100 ms window inside `afterPrompt` gives a wrong
  implementation the chance to start early; checking that something does not happen needs a
  bounded window;
- invalid runs: the session check refuses an empty run, a repeated id, an unknown id, and a turn
  id that is not the first message's id;
- the run ids of single and combined prompts;
- the controller refuses a run without a turn id, with repeated ids, or empty. A valid run reports
  `turn_started` synchronously inside `send` and resolves, and `abandonTurn` is idempotent.

The two `afterPrompt` tests wrap the Agent-owned conversation's private `ownerLifecycle.afterPrompt`
(a cast). That is the only seam for a slow or failing finalization without touching `src/`.

**Gate:**

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean (new test files clean under the temporary tsconfig) |
| characterization + turn-path, three runs without update | 42 pass each (14.1 s, 13.7 s, 14.0 s); snapshot file unchanged |
| full suite `bun test` | **1,139 pass, 0 fail; 114 files; 104.6 s** (1,132 + 7) |
| `agent-session.ts` | **4,594 lines** (5,022 before A2; 4,546 after step 1; +48 in step 4 for the context's turn wiring, the turn listener and `sentRuns`). Under 5,022, but ~44 over the spec's "about 4,550" expectation |

**Order of operations:** no reordering. One added scheduling point: `await controller.send(run)`
(an already resolved promise) before `ensureProvider`. Every A1 snapshot matched apart from
`cause`, and the race below is not made more frequent by it (measured below).

## Review fixes (`e7f2d79`)

Task: `.plan-execution/tasks/controller-interface-A2-review-fixes.md` (status `6a476a8`).

**P1: a yield between the turn report and `ensureProvider` changed ACP behaviour.**
- **Cause:** `pump` awaited `send`'s already resolved promise, which added a scheduling point
  between the controller's synchronous `turn_started` and `ensureProvider`. Before A2 there was
  none.
- **Fix:** when the controller reported the turn inside `send` (session-scheduled, so the report is
  its acceptance), `pump` doesn't await the promise. It attaches a `.catch` that logs, and goes
  straight on to `ensureProvider`. A controller that didn't report inside `send`
  (backend-scheduled, B2) is awaited, so the acceptance contract still holds for it. The report
  stays synchronous inside `send`.
- **Boundary probe:** I ran the same probe on the A1 gate commit (`9de0ca3`, from a `git archive`
  copy) and on the fix, using a detached conversation on the echo fixture. Scenarios: `forceStop`,
  `stop`, `interrupt` and `interrupt({ clearQueue })` right after `prompt()`; `forceStop`,
  `interrupt` and `stop` from a `turn_started` listener; a second prompt, a queued-then-withdrawn
  prompt, and a steer prompt from a `turn_started` listener.
- **Results:** all 10 outcomes and event sequences are identical to A1. Before the fix, two
  differed: `forceStop` right after `prompt()` reconnected and completed (A1: rejected,
  `turn_started, turn_failed`); `stop` from the listener failed with "conversation is stopped"
  (A1: `AgentSessionOperationError`). The probe scripts are outside the repo
  (`/tmp/a2-fix/boundary-probe*.ts`).
- **Regression tests:** "a force stop right after prompt() fails the turn without reconnecting, as
  before" and "a stop from a turn_started listener fails the turn as before".

**P2: the unknown-id check was tautological.**
- **Fix:** the session keeps `acceptedMessages`, the ids of messages it accepted and hasn't settled.
  An id is added in `enqueuePrompt` and removed in the item's own `resolve`/`reject`, which every
  settlement path goes through (result, failure, withdraw, drop, combined-run fan-out). `pump`
  checks each run id against that set, independently of how the run was built. Queue order and
  turn id = first message id are still checked.
- **Integration test:** "a run naming a message the session does not know is refused at dispatch,
  before send" wraps the session's (private) `steering.prepareRun` to return a combined run with
  an extra unknown id. It asserts:
  - the prompt rejects with the unknown-id error;
  - `controller.send` is never called;
  - the only turn event is `turn_failed` (no `turn_started`, since the controller never reported);
  - the next prompt runs normally, with only its own id.

**P3: the fixed delay in the finalization-order test.**
- **Fix:** the test now holds `afterPrompt` on a test-controlled gate. It waits (bounded, 5 s) until
  `afterPrompt` is entered, then queues the config change and checks synchronously that it is
  queued behind the turn: `phase` is `prompting`, `queuedOperationCount` is 1, and nothing but
  `afterPrompt:start` has happened. Then it releases the gate and checks the order: `afterPrompt:end`,
  `turn_completed`, `configuration_started`.
- **Why it's deterministic:** if the queue moved past the turn before finalization, the config
  change would be taken at once, so the queued check would fail every time. All waits go through a
  bounded `within(...)`; there's no fixed delay.
- **Also:** the trailing blank line at the end of `agent-session.ts` is gone (`git diff --check`
  clean).

**Checks that the tests catch the bugs:** the new turn-path tests run against the reviewed commit
`524af30` (in a `git archive` copy): the three new regression tests fail there and pass at
`e7f2d79`. The barrier test passes on both; the queue already waited, the old test just proved it
with a delay.

**Gate (`e7f2d79`):**

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean; new test files clean under the temporary tsconfig; `git diff --check` clean |
| characterization + turn-path, three runs without update | 45 pass each (13.3 s, 14.0 s, 13.7 s); snapshot unchanged, SHA-256 `d25f05a19cadeb8f…` (the hash the reviewer recorded) |
| full suite `bun test` | **1,142 pass, 0 fail; 114 files; 91.3 s** (1,139 + 3) |
| `agent-session.ts` | **4,613 lines** (+19 for the acceptance branch and the accepted-message registry) |

## Follow-up review fixes (`f54dc05`)

Task: `.plan-execution/tasks/controller-interface-A2-followup-fixes.md` (status `4bc275b`).

**A rejected `send` after a synchronous report was discarded.**
- **Fix:** `pump` now:
  1. observes `send`'s promise at once (`.catch(() => undefined)`, so it is never unhandled);
  2. starts `ensureProvider()` immediately after the report, as before (no scheduling point between
     them, so the first review's P1 is not reintroduced);
  3. then `await`s the acceptance before dispatching.
- **Result:** a rejection fails the turn through the normal failure path: `abandonTurn`,
  `turn_failed`, the prompt rejects, no `turn_completed`. The turn is never prepared. A controller
  that didn't report inside `send` (backend-scheduled, B2) is awaited before anything else.
- **Cost:** for the `HarnessController`, the only addition is one `await` of an already resolved
  promise *after* `ensureProvider`. The boundary probe is still identical to A1 in all 10 scenarios
  (re-run on `f54dc05`).
- **Regression:** "a send rejected after the controller reported the turn fails it: abandoned, no
  completion". It wraps the real controller's `send`: the real synchronous report, then a rejected
  promise. It asserts the rejection error, no `prepareTurn`, `abandonTurn` with the turn id, events
  `turn_started, turn_failed`, and that the next prompt runs normally.

**Accepted membership didn't prove ownership or order.**
- **Fix:** the registry is now a `Map` of id to `{ order, dispatched }`. `order` is the acceptance
  sequence (the queue is FIFO; steering combines contiguous steers from the head, so a run's
  messages follow acceptance order); `dispatched` is set when a run takes the message.
- **Checks** (`checkTurnRun` with a lookup over the session's own state, plus the queue's
  `snapshot()`): every run id must be accepted and unsettled, out of the queue, taken by no other
  run, and in strictly increasing acceptance order; the turn id is the first id. All ids are marked
  dispatched before `send`. Entries are still removed when the message's promise settles.
- **Regression:** "a run that takes a message still waiting in the queue is refused at dispatch;
  that message runs once, in its own turn". With a slow first turn and two queued messages A and B,
  it wraps `steering.prepareRun` so A's run also names B. A is refused ("…which is still queued")
  and never reaches `send`. B then runs once, in its own turn: `send` receives `[first]`, `[B]`;
  causes are `[first]`, `[B]`; `turn_failed` only for A.
- **Helper cases added:** taken, still queued, out of order. The existing unknown and duplicate
  cases are kept.

**The gated test's failure path held the turn open.**
- **Fix:** the gate is released in `finally`, and the turn's and the config change's promises are
  observed from the start (then asserted to have resolved).
- **Checked:** in a copy outside the repo with the phase assertion deliberately broken, the test
  fails in 116 ms with just that assertion error: no unhandled rejection, no `afterEach` timeout.

**The tests catch the bugs:** the current turn-path tests run against `e7f2d79`: the three
new/changed tests (rejected send, still-queued injection, helper cases) fail there and pass at
`f54dc05`.

**Gate (`f54dc05`):**

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean; new test files clean under the temporary tsconfig; `git diff --check` clean |
| characterization + turn-path, three runs without update | 47 pass each (14.4 s, 14.8 s, 14.1 s); snapshot unchanged, SHA-256 `d25f05a19cadeb8f…` |
| full suite `bun test`, two runs | **1,144 pass, 0 fail; 114 files**; 92.4 s and 94.9 s (1,142 + 2 new tests) |
| boundary probe vs A1 | identical, 10 scenarios |
| `agent-session.ts` | 4,623 lines |

**Limitations:**
- The order check relies on acceptance order matching queue order. That holds for today's FIFO
  queue and contiguous steer combining; a future scheduler that reorders messages would need its
  own rule (backend-scheduled runs are B2).
- The fault injections go through private seams: `steering.prepareRun`, and replacing the
  controller's `send` on the instance. The real `AgentController.send` never rejects after
  reporting.
- The intermittent Agent-owned internal-command order the reviewer saw once (assistant snapshot
  vs metering record) did not occur in my two full runs. I haven't analysed it; see open question 1.

## Second follow-up fix (`9e0f457`)

Task: `.plan-execution/tasks/controller-interface-A2-followup-3-fix.md`.

**A rejected acceptance waited behind a pending reconnect.**
- **Fix:** `pump` still starts `ensureProvider()` right after the synchronous report, but now waits
  for readiness and acceptance together, failing fast (`Promise.all([ready, accepted])`). A rejected
  `send` fails the turn at once, even while the reconnect is held: `abandonTurn`, `turn_failed`, the
  prompt rejects once, and the message leaves the registry.
- **The reconnect in flight:** if it is still running when the turn fails, the queue operation waits
  for it to settle (either way) before the next operation starts. Without that, the next operation's
  `ensureProvider` would start a second reconnect on top of it.
  - The wait is only taken when that readiness is still running; otherwise nothing is awaited, so
    normal turns get no extra scheduling point.
  - It is bounded like any reconnect: by the provider answering or the process ending. That is what
    the operation already waited for before (on A1).

**Probes:**
- **Boundary probe:** still identical to A1 in all 10 scenarios.
- **Rejected acceptance during a held reconnect** (lifecycle fixture, `session/load` unanswered):
  the prompt now rejects in about 2 ms with `acceptance rejected`; before, it was still pending.

**Regression:** "fails the turn at once; the reconnect in flight is waited for, not repeated; stop
and cleanup finish". The lifecycle fixture gains an opt-in `LIFECYCLE_HOLD_CONTROL` +
`LIFECYCLE_HOLD_FILE` (hold one method until a file exists, then answer normally; default
unchanged), so the test controls when the reconnect's `session/load` is answered. Its steps:
1. With the load held, a prompt whose `send` rejects after the real report fails within a 2 s
   bound: `abandonTurn` with its id, events `turn_started, turn_failed`.
2. A message queued behind it has not started, and `reconnect` was called once.
3. After the load is released, the queued message completes on the same reconnect: still one
   `reconnect` call, one `provider_reconnected`.
4. `stop()` finishes within 5 s.
5. No unhandled rejection was recorded.

On `f54dc05` it fails at its 2 s bound and cleans up (the cleanup always releases the held load).

**Gate (`9e0f457`):**

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean; new test files clean under the temporary tsconfig; `git diff --check` clean |
| turn-path tests, three runs | 13 pass each |
| characterization + turn-path, three runs without update | 46/2, 47/1, 48/0. Snapshot file unchanged each run (SHA-256 `d25f05a19cadeb8f…`). The failures are the pre-existing managed combined-steer race (identified in a repeat: the second turn's `metering_recorded` vs a presentation event, the pair the reviewer saw); see below |
| full suite `bun test`, two runs | **1,145 pass, 0 fail; 114 files**; 92.4 s and 92.1 s (1,144 + 1) |
| boundary probe vs A1 | identical, 10 scenarios |
| `agent-session.ts` | 4,634 lines |

**The intermittent snapshot orders, measured.** The characterization file alone, 20 runs each:

| Code | Agent-owned `an internal command` | managed `two steer messages combined` |
| --- | --- | --- |
| A1 gate `9de0ca3` (no A2 code) | **3 / 20** | 1 / 20 |
| this commit `9e0f457` | 0 / 20 | 3 / 20 |

- **Both races exist in the unchanged A1 code.** That includes the internal-command order the
  reviewer saw once in a full run, so it is pre-existing.
- **The samples are too small** to say whether rates differ.
- **Nothing was changed for them;** they stay with the owner (open question 1).

## Owner decisions and the snapshot exception (`2f3b073`, replacing `1ad325d` and `5eeb54c`)

Tasks: `.plan-execution/tasks/controller-interface-A2-owner-decisions.md` and
`controller-interface-A2-managed-decision.md`.

**Beta brought in:**
- `fd9ec24` (merge `174200e`): contractual orders, the narrow exception, the accepted connect hang,
  the finding and the TODO;
- `95e9cf2` (merge `83114f1`): the widened managed exception.

Both are documentation only, and neither conflicted. The uncommitted candidate was preserved through
the second merge (byte-identical to its backup).

**The one dedicated commit: `2f3b073`** (was `5eeb54c` until the watcher fixes; see "Watcher
follow-up fixes"). It contains `test/conversation-turns/characterization.test.ts`, its snapshot,
`pair-rule.ts`, `pair-rule.test.ts`, `contract-watch.ts` and `contract-watch.test.ts`; nothing else.
The text below describes the exception as first consolidated in `5eeb54c`; the watcher checks are
described as they are now, in `2f3b073`.
- **How it replaced `1ad325d`:** after the final review (`11-12-REVIEW-A2.md` at `72406be`), the
  first exception commit `1ad325d` and its report commit `d7303d8` were replaced so that the
  corrected exception is still a single commit.
- **Steps:** the old head `d7303d8` was kept as branch `controller-interface-pre-consolidation-d7303d8`;
  `git reset --soft 83114f1`; the corrected test files committed as `5eeb54c`; the report committed
  after it.
- **Safety:** no other branch contained `1ad325d` or `d7303d8` (checked on the reviews and status
  branches), and nothing was pushed. The snapshot in `5eeb54c` is byte-identical to `1ad325d`'s; the
  test files are exactly the ones that passed the gate below.

**Accepted alternatives, nothing else.**
- **Managed:** a turn's metering event may sit anywhere among that turn's *response* presentation
  events.
  - **Canonical form:** the metering event is moved before the contiguous same-turn response
    presentations directly ahead of it.
  - **Bounds:** it never crosses another kind of event or another turn's events, and presentations
    are never reordered among themselves.
  - **Deliberately narrower than "any presentation event":** the turn's own user-message
    presentations are not crossed. They are written before dispatch, and no observed variant
    involves them. Letting metering cross them would hide a real regression.
- **Agent-owned:** a turn's metering record vs its last in-progress assistant snapshot record, either
  order. Decided on the raw records: kind `message`, the same turn, role `assistant`, status
  `in_progress`, a `:snapshot:` id, and the turn's last such record.
  - **Canonical form:** metering first. In the records, the pair keeps its own two sequence numbers,
    reassigned in ascending order.
  - **The bus:** it must list exactly the records' ids in the records' order (`canonicalOwnedRecords`
    throws otherwise, and `assertRun` checks it on the raw run). The same pair, by record id, is the
    only thing swapped on the bus. Since the review, the bus no longer has its own looser rule: a
    completed or non-assistant snapshot, another turn's snapshot, a record in between, or a
    bus/record disagreement can't be hidden.
  - **The actual sequence numbers are checked on the raw run before this,** so the swap can never
    hide a gap, a duplicate or a misordering: strictly increasing and unique; each record id unique.
- **Focused tests** (`pair-rule.test.ts`, 15):
  - **Allowed forms:** all three managed positions give one form; tool presentations count;
    Agent-owned both orders give one form with the pair's sequence numbers.
  - **Forbidden ones:** crossing user presentations, other kinds of event or other turns'
    presentations; reordering presentations among themselves; duplicate metering kept (not
    merged); a completed or non-assistant snapshot, another turn's snapshot, a non-last snapshot, or
    a record in between, all not moved; bus disagreement, including the reviewer's counterexample,
    refused.

**Explicit checks, per case, on the raw run** (`watchContract` / `assertRun`; a timeline that is never
snapshotted):

| Contract | How it is checked |
| --- | --- |
| each stream keeps its order | Agent-owned records: sequence numbers strictly increasing and unique; the bus equals the records' ids in order; managed transcript: `seq` is 1..n; events in emission order (the snapshot) |
| a turn's records and metering appear once, ids stable | exactly one `metering_recorded` per metered turn, one for each completed turn and one for each failed turn that reached the provider (below); Agent-owned: exactly one `<turn>:metering` record per metered turn and none for any other turn, record ids unique; managed: likewise one `metering_reference` per metered turn, none otherwise |
| metering after the provider's result | every controller the conversation uses is wrapped: the first at once, a handoff target at its first `turn_started`. Each wrap returns the same promise (or rethrows the same error) and records "called" and "outcome" for the open turn; the outcome is the promise settling (result or rejection) or a synchronous throw. Every completed turn must have reached the provider, have exactly one outcome and its metering after it. Failed turns: see "Watcher follow-up fixes" |
| final assistant message before completion | at `turn_completed` (synchronously), for a result with `n` messages: Agent-owned, the committed `<turn>:assistant:<n>` record with the last message's content, and no higher ordinal; managed, a terminal `message:<turn>:assistant:<n>` transcript line with the last message's text, and no higher ordinal; detached, the last assistant line holds exactly the turn's messages |
| `turn_completed` after metering, transcript, `afterPrompt` | metering before completion (full timeline); managed: at completion the transcript has the closed operation and the metering reference; Agent-owned: `ownerLifecycle.afterPrompt` is wrapped (same promise) and must have settled before `turn_completed` |
| managed exception bounds | over the complete timeline, after the run: each completed turn's metering lies after its `turn_started` and before its `turn_completed`; `turn_completed` comes after the turn's last presentation event (later arrivals included); no presentation item goes back to `in_progress` |

**Forced and rejected provider paths:** for these, the outcome is the rejection of the controller's
promise (a forced stop or a transport failure), or a synchronous throw. Metering must come after it,
and in every case it does (stalls, ignored cancels, forced internal stalls). Failed turns are
classified explicitly (see "Watcher follow-up fixes"); none is skipped.

**Proof the handoff coverage works:** in a temporary copy with re-wrapping on `turn_started`
removed, both handoff cases fail on `reachedProvider`.

**Snapshot:** 14 cases moved into the canonical form (5 Agent-owned, 3 managed, 6 once-only). Each was
verified mechanically to differ from the previous snapshot only by order: the same multiset of lines
apart from sequence values, and the same set of sequence numbers. No other case or line changed.

### Comparative counts (methodology, data, analysis)

**Methodology.** Two studies, each 50 runs of the whole characterization file on A1 (`9de0ca3`) and
50 on A2. A1 and A2 runs alternate one after the other, so they share the machine's load. Nothing
else ran meanwhile, and snapshots were never updated.
- **Instrumentation:** each run comes from a `git archive` copy outside the repo whose test file is
  patched to append each case's normalized capture to a dump, taken *before* the pair rule. The true
  orders are counted.
- **Study 1:** the test file as it was before this change (no contract checks).
- **Study 2:** the final test file (contract checks on) on both A1 and A2.
- **Why study 2:** the turn-2 `P1 → M → P2` variant had been seen with the checks on but not in
  study 1.
- **Interruption:** study 2 was interrupted at 46 pairs by a session restart. The partial 47th pair
  was discarded and pairs 47–50 were rerun the same way.
- **Analysis:** for each managed turn with two response presentation events, metering's position
  among them is counted separately for all three positions. For each Agent-owned turn, the metering
  record's position vs the last in-progress snapshot is counted. Every run's capture is also checked
  against the rule: after it, each case must have exactly one form.

**Managed: metering's position among the turn's two response presentation events P1, P2** (A1 / A2, 50 runs each).

| Case (managed) | Turn | P1 / P2 | Study | `M → P1 → P2` | `P1 → M → P2` | `P1 → P2 → M` |
| --- | --- | --- | --- | --- | --- | --- |
| a handoff with a summary | `<id:1>` | message in_progress / message completed | study 1 | 50 / 50 | 0 / 0 | 0 / 0 |
| a handoff with a summary | `<id:4>` | message in_progress / message completed | study 1 | 50 / 50 | 0 / 0 | 0 / 0 |
| a permission request answered through the handler | `<id:1>` | message in_progress / message completed | study 1 | 50 / 50 | 0 / 0 | 0 / 0 |
| a plain prompt | `<id:1>` | message in_progress / message completed | study 1 | 50 / 50 | 0 / 0 | 0 / 0 |
| a second prompt queued behind a running one | `<id:1>` | message in_progress / message completed | study 1 | 50 / 50 | 0 / 0 | 0 / 0 |
| a second prompt queued behind a running one | `<id:2>` | message in_progress / message completed | study 1 | 50 / 50 | 0 / 0 | 0 / 0 |
| a stalled prompt | `<id:1>` | message in_progress / message error | study 1 | 0 / 0 | 0 / 0 | 50 / 50 |
| an internal command | `<id:1>` | message in_progress / message completed | study 1 | 50 / 50 | 0 / 0 | 0 / 0 |
| an interrupt of the running turn | `<id:1>` | tool in_progress / tool in_progress | study 1 | 0 / 0 | 50 / 50 | 0 / 0 |
| two steer messages combined into one run | `<id:1>` | tool in_progress / tool completed | study 1 | 0 / 0 | 49 / 49 | 1 / 1 |
| two steer messages combined into one run | `<id:2>` | message in_progress / message completed | study 1 | 50 / 50 | 0 / 0 | 0 / 0 |
| a handoff with a summary | `<id:1>` | message in_progress / message completed | study 2 | 50 / 50 | 0 / 0 | 0 / 0 |
| a handoff with a summary | `<id:4>` | message in_progress / message completed | study 2 | 50 / 50 | 0 / 0 | 0 / 0 |
| a permission request answered through the handler | `<id:1>` | message in_progress / message completed | study 2 | 50 / 50 | 0 / 0 | 0 / 0 |
| a plain prompt | `<id:1>` | message in_progress / message completed | study 2 | 49 / 50 | 1 / 0 | 0 / 0 |
| a second prompt queued behind a running one | `<id:1>` | message in_progress / message completed | study 2 | 50 / 50 | 0 / 0 | 0 / 0 |
| a second prompt queued behind a running one | `<id:2>` | message in_progress / message completed | study 2 | 50 / 50 | 0 / 0 | 0 / 0 |
| a stalled prompt | `<id:1>` | message in_progress / message error | study 2 | 0 / 0 | 0 / 0 | 50 / 50 |
| an internal command | `<id:1>` | message in_progress / message completed | study 2 | 50 / 50 | 0 / 0 | 0 / 0 |
| an interrupt of the running turn | `<id:1>` | tool in_progress / tool in_progress | study 2 | 0 / 0 | 50 / 50 | 0 / 0 |
| two steer messages combined into one run | `<id:1>` | tool in_progress / tool completed | study 2 | 0 / 0 | 49 / 48 | 1 / 2 |
| two steer messages combined into one run | `<id:2>` | message in_progress / message completed | study 2 | 49 / 50 | 1 / 0 | 0 / 0 |

**Agent-owned: metering record vs the turn's last in-progress assistant snapshot record** (A1 / A2, 50 runs each).

| Case | Turn | Study | snapshot → metering | metering → snapshot |
| --- | --- | --- | --- | --- |
| agent-owned > a handoff with a summary | `<id:1>` | study 1 | 50 / 50 | 0 / 0 |
| agent-owned > a handoff with a summary | `<id:4>` | study 1 | 50 / 50 | 0 / 0 |
| agent-owned > a permission request answered through the handler | `<id:1>` | study 1 | 50 / 50 | 0 / 0 |
| agent-owned > a plain prompt | `<id:1>` | study 1 | 50 / 50 | 0 / 0 |
| agent-owned > a second prompt queued behind a running one | `<id:1>` | study 1 | 50 / 50 | 0 / 0 |
| agent-owned > a second prompt queued behind a running one | `<id:2>` | study 1 | 50 / 50 | 0 / 0 |
| agent-owned > a stalled prompt | `<id:1>` | study 1 | 50 / 50 | 0 / 0 |
| agent-owned > an internal command | `<id:1>` | study 1 | 4 / 2 | 46 / 48 |
| agent-owned > two steer messages combined into one run | `<id:2>` | study 1 | 50 / 50 | 0 / 0 |
| once > a permission request sent the instant the prompt reaches the agent shows in the operation's stages | `<id:1>` | study 1 | 50 / 50 | 0 / 0 |
| once > a provider that fails to start: the prompt rejects with turn_failed | `<id:1>` | study 1 | 50 / 50 | 0 / 0 |
| once > a queued message withdrawn, its promise awaited | `<id:1>` | study 1 | 50 / 50 | 0 / 0 |
| once > a tool start sent the instant the prompt reaches the agent shows in the operation's stages | `<id:1>` | study 1 | 50 / 50 | 0 / 0 |
| once > an internal prompt (handoff summary) that stalls in a tool and its cancel is acknowledged | `<id:1>` | study 1 | 50 / 50 | 0 / 0 |
| once > an internal prompt (handoff summary) that stalls silently and is cancelled by force | `<id:1>` | study 1 | 50 / 50 | 0 / 0 |
| agent-owned > a handoff with a summary | `<id:1>` | study 2 | 50 / 50 | 0 / 0 |
| agent-owned > a handoff with a summary | `<id:4>` | study 2 | 50 / 50 | 0 / 0 |
| agent-owned > a permission request answered through the handler | `<id:1>` | study 2 | 50 / 50 | 0 / 0 |
| agent-owned > a plain prompt | `<id:1>` | study 2 | 50 / 50 | 0 / 0 |
| agent-owned > a second prompt queued behind a running one | `<id:1>` | study 2 | 50 / 50 | 0 / 0 |
| agent-owned > a second prompt queued behind a running one | `<id:2>` | study 2 | 50 / 50 | 0 / 0 |
| agent-owned > a stalled prompt | `<id:1>` | study 2 | 50 / 50 | 0 / 0 |
| agent-owned > an internal command | `<id:1>` | study 2 | 2 / 2 | 48 / 48 |
| agent-owned > two steer messages combined into one run | `<id:2>` | study 2 | 50 / 50 | 0 / 0 |
| once > a permission request sent the instant the prompt reaches the agent shows in the operation's stages | `<id:1>` | study 2 | 50 / 50 | 0 / 0 |
| once > a provider that fails to start: the prompt rejects with turn_failed | `<id:1>` | study 2 | 50 / 50 | 0 / 0 |
| once > a queued message withdrawn, its promise awaited | `<id:1>` | study 2 | 50 / 50 | 0 / 0 |
| once > a tool start sent the instant the prompt reaches the agent shows in the operation's stages | `<id:1>` | study 2 | 50 / 50 | 0 / 0 |
| once > an internal prompt (handoff summary) that stalls in a tool and its cancel is acknowledged | `<id:1>` | study 2 | 50 / 50 | 0 / 0 |
| once > an internal prompt (handoff summary) that stalls silently and is cancelled by force | `<id:1>` | study 2 | 50 / 50 | 0 / 0 |

Cases not listed have no such pair, or a single order in every run.

**What studies 1 and 2 can and can't show:**
- **Size:** they are 50 + 50 runs each, i.e. **100 A1 and 100 A2 runs in total** (the previous
  version of this report wrongly said 200 and 200).
- **Raw variants:** in those runs, every raw variant is one of the orders counted above, and after
  the rule each case has exactly one form.
- **Diagnostics not kept:** study 1 kept only the `(fail)` lines, and study 2 only the `(fail)` and
  `error` lines. Neither kept the full output or the exit status of each run. So an unhandled error
  between tests, a setup or teardown diagnostic, or a nonzero exit without a `(fail)` line **cannot
  be ruled out for studies 1 and 2: unknown, not zero.**
- **What they did retain:** study 1's listed failures were only the known orders (A1: 4
  internal-command and 1 managed-steer runs; A2: 2 and 1). Study 2: A2 listed no failures; A1 listed
  exactly the 14 snapshot mismatches expected from A1's old snapshot in every run, and no
  contract-check failure.

### Study 3: complete per-run evidence (the final test file)

**Methodology:**
- **Runs:** 50 runs of `characterization.test.ts` on A1 (`9de0ca3`) and 50 on A2 (`5eeb54c`), the
  same test file on both.
- **Order:** alternating per pair (odd pairs A1 first, even pairs A2 first), so neither always runs
  first. Nothing else ran meanwhile.
- **Kept per run:** the complete output (`/tmp/a2-fix/s3/logs/<version>-<n>.log`), the exit status
  (`…exit`), and the raw captures before the pair rule (`dump-<version>-<n>.jsonl`, 35 per run).
- **A1 copy:** `git archive 9de0ca3` plus the final test files (`characterization.test.ts`,
  `pair-rule.ts`; `normalize.ts` is unchanged since A1). Its snapshot is the final snapshot with
  exactly its 39 `cause` blocks removed (the inverse of `cffce98`). The remaining `"cause"` keys
  (error causes) matched A1's own snapshot: 4. So an A1 failure would be a real difference, not
  `cause`. The A2 copy is `git archive 5eeb54c`.
- **Instrumentation in both:** a test-name tracker and one dump write per case.

**Classification of every run:**
- **A1:** 50/50 exit 0, no `(fail)`, no unhandled error.
- **A2:** 50/50 exit 0, no `(fail)`, no unhandled error.
- **Searched for:** the logs were searched for `Unhandled` and `error between tests` as well as
  `(fail)`.
- **Unclassified nonzero results:** none.

| Case (managed) | Turn | `M → P1 → P2` (A1 / A2) | `P1 → M → P2` | `P1 → P2 → M` |
| --- | --- | --- | --- | --- |
| a handoff with a summary | `<id:1>` | 50 / 50 | 0 / 0 | 0 / 0 |
| a handoff with a summary | `<id:4>` | 50 / 50 | 0 / 0 | 0 / 0 |
| a permission request answered through the handler | `<id:1>` | 50 / 50 | 0 / 0 | 0 / 0 |
| a plain prompt | `<id:1>` | 50 / 50 | 0 / 0 | 0 / 0 |
| a second prompt queued behind a running one | `<id:1>` | 50 / 50 | 0 / 0 | 0 / 0 |
| a second prompt queued behind a running one | `<id:2>` | 50 / 50 | 0 / 0 | 0 / 0 |
| a stalled prompt | `<id:1>` | 0 / 0 | 0 / 0 | 50 / 50 |
| an internal command | `<id:1>` | 50 / 50 | 0 / 0 | 0 / 0 |
| an interrupt of the running turn | `<id:1>` | 1 / 0 | 49 / 50 | 0 / 0 |
| two steer messages combined into one run | `<id:1>` | 0 / 0 | 50 / 48 | 0 / 2 |
| two steer messages combined into one run | `<id:2>` | 50 / 50 | 0 / 0 | 0 / 0 |

| Case (Agent-owned) | Turn | snapshot → metering (A1 / A2) | metering → snapshot |
| --- | --- | --- | --- |
| agent-owned > a handoff with a summary | `<id:1>` | 50 / 50 | 0 / 0 |
| agent-owned > a handoff with a summary | `<id:4>` | 50 / 50 | 0 / 0 |
| agent-owned > a permission request answered through the handler | `<id:1>` | 50 / 50 | 0 / 0 |
| agent-owned > a plain prompt | `<id:1>` | 50 / 50 | 0 / 0 |
| agent-owned > a second prompt queued behind a running one | `<id:1>` | 50 / 50 | 0 / 0 |
| agent-owned > a second prompt queued behind a running one | `<id:2>` | 50 / 50 | 0 / 0 |
| agent-owned > a stalled prompt | `<id:1>` | 50 / 50 | 0 / 0 |
| agent-owned > an internal command | `<id:1>` | 0 / 0 | 50 / 50 |
| agent-owned > two steer messages combined into one run | `<id:2>` | 50 / 50 | 0 / 0 |
| once > a permission request sent the instant the prompt reaches the agent shows in the operation's stages | `<id:1>` | 50 / 50 | 0 / 0 |
| once > a provider that fails to start: the prompt rejects with turn_failed | `<id:1>` | 50 / 50 | 0 / 0 |
| once > a queued message withdrawn, its promise awaited | `<id:1>` | 50 / 50 | 0 / 0 |
| once > a tool start sent the instant the prompt reaches the agent shows in the operation's stages | `<id:1>` | 50 / 50 | 0 / 0 |
| once > an internal prompt (handoff summary) that stalls in a tool and its cancel is acknowledged | `<id:1>` | 50 / 50 | 0 / 0 |
| once > an internal prompt (handoff summary) that stalls silently and is cancelled by force | `<id:1>` | 50 / 50 | 0 / 0 |

**Timing-shift investigation, all three studies:**
- **No position shows a noticeable shift between A1 and A2;** the largest per-position difference
  in any study is 2 in 50 runs.
- **Combined-steer turn 1:** `P1 → M → P2` / `P1 → P2 → M` were 49/1 and 49/1 (study 1), 49/1 and
  48/2 (study 2), 50/0 and 48/2 (study 3), A1 then A2.
- **Agent-owned internal command,** metering after snapshot / metering first: study 1 A1 4/46 and
  A2 2/48; study 2 2/48 and 2/48; study 3 0/50 and 0/50.
- **The rare message-turn `P1 → M → P2`** appeared only on A1 in study 2, and in earlier ad-hoc runs
  on A2.
- **Managed interrupt, new in study 3:** `M → P1 → P2` appeared once on A1, a position not seen
  before (otherwise `P1 → M → P2`, 49 on A1 and 50 on A2). The rule covers it.
- **No noticeable shift between A1 and A2 in any of the three positions.** Finite samples cannot
  establish equal rates.

**Limitations:**
- **The exception accepts orders that are deterministic today** in some cases: the stalled prompt's
  error path drains presentations before metering; the interrupt case. The snapshot no longer pins
  those particular orders. Their contractual parts are still asserted (metering after the result,
  completion after metering and the last presentation).
- **Measurement effects:** study 2's checks read the transcript synchronously at `turn_completed`.
  That may shift timing slightly, which is why both conditions are reported. The controller wrap
  returns the same promise and adds no scheduling point.
- **The Agent-owned rule needs the pair adjacent** (it always was, in all 150 A1 and 150 A2 runs of
  the three studies). A non-adjacent swap would fail the snapshot rather than be accepted.
- **The late-presentation bound has no synthetic unit test.** It is checked over the complete
  timeline in every case, but there is no fabricated late event.
- **The `afterPrompt` observation goes through a private seam** (`ownerLifecycle`), as the
  turn-path finalization test does.

**Gate (`5eeb54c`):**

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean; test files (including `pair-rule*.ts`) clean under the temporary tsconfig; `git diff --check` clean |
| pair-rule tests | 15 pass |
| characterization + turn-path + pair-rule, three runs without update | 63 pass each (14.9 s, 14.8 s, 14.9 s); snapshot unchanged and byte-identical to `1ad325d`'s (SHA-256 `47686d4ca0451cf8…`) |
| full suite `bun test`, two runs | **1,160 pass, 0 fail; 115 files**, exit 0; 94.4 s and 103.1 s (1,145 + 15 pair-rule tests) |
| study 3 | 100/100 runs exit 0 (above) |
| `agent-session.ts` | 4,634 lines (unchanged since `9e0f457`) |

## Watcher follow-up fixes (in `2f3b073`, replacing `5eeb54c`)

Task: `.plan-execution/tasks/controller-interface-A2-watcher-fixes.md`. Review:
`11-12-REVIEW-A2.md` at `54ced2e`, final-fixes section, against `26c7868`. All three findings were
test/evidence findings; nothing in `src/` changed.

**Where the watcher is now:** `watchContract` moved from `characterization.test.ts` to
`test/conversation-turns/contract-watch.ts`. It is typed structurally (a conversation with a
`connection.prompt` and `subscribe`), so `contract-watch.test.ts` (27 tests) can drive it with
synthetic conversations. `characterization.test.ts` only imports it; its cases and `snapshot()` are
unchanged.

**Finding 1: a provider-dispatched failed turn with no metering passed.** Every failed turn is now
classified, and each class has one exact expectation. Nothing is skipped:

| Failed turn | How it is identified | Required |
| --- | --- | --- |
| reached the provider | a `provider_called` marker for the turn | exactly one outcome; exactly one `metering_recorded`, after the outcome and before `turn_failed`; the error carries the record (`AgentSessionOperationError` or `OperationStalledError`, as `String(error)` in `turn_failed`); the mode's record once (below) |
| metering preflight rejection | not dispatched; error `MeteringPreflightError: …` | no metering at all (spec: a preflight rejection needs no record) |
| closed before the provider call | not dispatched; the error carries the record (for example the supervisor or `prepareTurn` failing after the operation opened) | exactly one metering, before `turn_failed` |
| failed before the metered operation | not dispatched; any other error (provider never ready, pre-dispatch persistence failure) | no metering |
| metering-close failure | **declared by the case** (`expectMeteringWriteFailure(turn, "close")`) | no metering event and no record |
| metering-record failure | **declared by the case** (`expectMeteringWriteFailure(turn, "record")`) | the event once, after the outcome; the mode's record (Agent-owned `<turn>:metering`, managed `metering_reference`) absent |

- **The mode's record:** for every turn (completed, failed or metered), Agent-owned must have
  exactly `[<turn>:metering]` when the turn has one metering event (and no declared record
  failure), and no metering record otherwise. Managed: the same with `metering_reference` lines.
  Before, only turns with an event were checked.
- **The metering-write failures are explicit, not inferred.** The watcher cannot tell a metering
  write failure from another error by itself, so a case must declare it. No characterization case
  declares one today, and none has one. Whether such a turn is allowed to end without a record is a
  contract question; see open question 4.
- **What the real cases exercise** (classification printed in a temporary copy, then removed): one
  dispatched stalled failure per mode (`OperationStalledError`, one metering after the outcome and
  before the failure), and the Agent-owned `ProviderSessionError` case, which fails before the
  metered operation with no metering. The 36 completed turns are checked as before, plus the
  metering-after-outcome and once-only outcome checks.

**Finding 2: the final-message check accepted an earlier message.** At `turn_completed`, for a
result with `n` messages (last text `L`):
- **Agent-owned:** the committed record `<turn>:assistant:<n>` exists, its `content` is `L`, and no
  `<turn>:assistant:<k>` with `k > n` was committed (`afterPrompt` numbers them `1..n`,
  `src/agent/persisted-lifecycle.ts`).
- **Managed:** a transcript line `message:<turn>:assistant:<n>` (role assistant, the turn's
  operation id) with a terminal status, whose last structured text (or `text`) is `L`, and no higher
  ordinal for the turn.
- **Detached:** lines carry no turn id. Each turn appends its one assistant line on its own path
  before it ends, so at completion the last assistant line must hold exactly the turn's message
  texts, in order. This replaces the cumulative count check.
- **Negative cases:** in each mode, a two-message turn where only the first message was recorded.
  Also: Agent-owned other content, and a record beyond the last; managed, the last message only in
  progress, or with other text; detached, an earlier turn's line as the last one.

**Finding 3: a synchronous `prompt` throw was not an outcome.** The wrapper now calls the controller
inside `try`. A synchronous throw records `provider_outcome` and rethrows the same error. Otherwise
it attaches the same settle handlers as before and returns the same promise. It adds no `await` and
no new promise in the turn path's chain; the handlers hang off the side, as before. Tests: a
synchronous throw (identity of the rethrown error), a rejected promise (identity of the returned
promise), a forced stop (`ForcedStopError`), a resolved result (identity), and metering before a
still-pending outcome (fails).

**The tests are meaningful (mutation check):** in a temporary copy, each fix was reverted on its
own, and the synthetic tests failed:
- **the synchronous-throw wrapper:** 1 test failed;
- **metering optional for dispatched failures:** 2 failed (the reviewer's probe, and the declared
  close failure);
- **the old "any final message" checks:** 6 failed (all the per-mode negative cases).

The file was restored byte for byte (`cmp`).

**Study instrumentation, and whether the comparative measurements still represent the final tests:**
- **What changed in the instrumentation:**
  - studies 1–3 ran the watcher of `5eeb54c`. The final watcher adds a `try` around the provider
    call and different synchronous reads at `turn_completed` (the same transcript read; a filter
    instead of `some` over the committed records);
  - it adds no scheduling point. The dump hook (`instrument2.py`) anchors on the unchanged
    `assertRun` call in `snapshot()` and applies unchanged.
- **Assessment:**
  - the comparative counts measure the raw capture orders produced by `src/`, and `src/` is
    identical (`git diff 5eeb54c 2f3b073 -- src` is empty);
  - the observation differs only by synchronous work at the same points, so I expected no shift,
    but checked rather than assumed.
- **Supplement, study 4:** 20 runs of the final test files (a `git archive` copy of `5eeb54c` with
  the final `characterization.test.ts` and `contract-watch.ts`, the same instrumentation; full logs,
  exit codes and 700 raw captures in `/tmp/a2-fix/s4/`):
  - **Runs:** 20/20 exit 0, no `(fail)`, no unhandled error.
  - **Managed:** every position equals study 3's A2 column in proportion. Combined-steer turn 1 was
    `P1 → M → P2` 20/20 (48/2 in study 3); interrupt `P1 → M → P2` 20/20; stalled `P1 → P2 → M`
    20/20; all others `M → P1 → P2`.
  - **Agent-owned:** all as study 3, except the internal command, which had 2 of 20 with the
    snapshot first (0 of 50 in study 3; 2–4 of 50 in studies 1 and 2, on both A1 and A2). That is
    within the range already measured, and covered by the rule.
  - **Verdict:** the comparison still represents the final tests; nothing material to escalate.
    20 runs is a smaller sample than 50, and finite samples cannot establish equal rates.
- **Repetition:** the final characterization and watcher tests were also run 20 times in a row in
  the worktree: 62 pass / 0 fail each time, exit 0, snapshot unchanged.

**Consolidation (the single exception commit kept):**
- the head `26c7868` was kept as branch `controller-interface-pre-watcher-fixes-26c7868`. No other
  branch contained `5eeb54c` or `26c7868`, and nothing was pushed;
- `git reset --soft 83114f1`; the exception's six test files committed by explicit path as
  `2f3b073`; this report committed after it;
- `git diff 5eeb54c 2f3b073` touches only `characterization.test.ts` (the watcher removed and
  imported) and the two new `contract-watch` files. The snapshot (SHA-256 `47686d4ca0451cf8…`),
  `pair-rule.ts`, `pair-rule.test.ts` and `src/` are byte-identical to `5eeb54c`'s.

The cause-only snapshot commit `cffce98` is still separate and unchanged.

**Limits:**
- **Detached identification is positional:** detached transcript lines carry no turn id, so the
  check relies on each turn appending its own line before it ends. A line appended for the turn
  after its completion would fail the check; one appended by another turn in between would also
  fail, because of the text comparison.
- **Error classes are read from `turn_failed.error`** (`String(error)`, the name prefix). A
  renamed error class would fail the check loudly rather than pass silently.
- **The metering-write exception is declared, not observed.** No case produces one, so it is
  covered only synthetically (both kinds, with negative cases).
- **Managed messages:** the check assumes the presentation ordinal equals the result's message
  count. It does in every case; a mismatch would fail rather than pass.

**Gate (`2f3b073`):**

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean; test files (including `contract-watch*.ts`) clean under the temporary tsconfig; `git diff --check` clean |
| contract-watch tests | 27 pass (146 assertions) |
| characterization + turn-path + pair-rule + contract-watch, three runs without update | 90 pass each (14.9 s, 16.5 s, 14.3 s); snapshot unchanged (SHA-256 `47686d4ca0451cf8…`) |
| full suite `bun test`, two runs | **1,187 pass, 0 fail; 116 files**, exit 0; 97.8 s and 105.7 s (1,160 + 27) |
| study 4 | 20/20 runs exit 0 (above) |
| `agent-session.ts` | 4,634 lines (unchanged) |

## Open questions

1. **Answered (owner, beta `fd9ec24`, `95e9cf2`): the two non-contractual orders are accepted; see
   "Owner decisions and the snapshot exception".** Original text: **A pre-existing order race in an
   A1 snapshot (the managed combined-steer case).** While
   generating the `cause`-only snapshot, one regeneration put the cancelled first turn's
   `metering_recorded` event after a `presentation_recorded` (the settled `read-0` tool) instead of
   before it. I discarded that regeneration; the committed one has 0 removed lines.
   - **Measured on the unchanged A1 gate commit** (`9de0ca3`, from a `git archive` copy):
     **8 of 80** runs of `-t "managed two steer"` flip it.
   - **On A2** (`cffce98`): **3 of 65**.
   - **So it predates A2** and A2 doesn't make it worse. A1's 14 runs didn't catch it.
   - **Cause:** in managed mode the tool's settled presentation is written through the
     presentation queue (asynchronous), while `closeOperation` emits `metering_recorded` directly.
     When the steer cancel lands right at the tool boundary, the two race. It's the same class as
     A1's P2.
   - **No test barrier pins the dominant order** (metering first): the only thing a test can hold
     back is the provider's reply, which would force the minority order.
   - **Options for the owner:** (a) a `src/` change ordering the two (out of A2's scope; would change
     the turn path's order); (b) capture these two event kinds in separate per-kind sequences for
     this case. That's a weaker comparison and arguably loosening, so it needs an explicit decision;
     (c) accept a known intermittent failure (about 1 in 10–20 runs of that case; the full suite was
     green in every run here).
   - **Until decided:** the gate can occasionally fail on this case. It would show exactly this
     diff, not an A2 regression.
   - **The reviewer also reproduced it** (on A1 and on A2) with a different pair: the **second,
     completed** turn's in-progress `presentation_recorded` and its `metering_recorded`. So the race is
     between managed-mode presentation writes and metering events generally, not one pair. It is
     escalated to the owner; nothing here changes it.
   - **A second intermittent order, reported by the reviewer:** one full-suite run at `babc5b1`
     failed the Agent-owned `an internal command` case (assistant in-progress snapshot vs metering
     record, in both the bus and SQLite). Targeted probes were 30/30 on A1 and on the follow-up. It
     looks like the Agent-owned record race found in A1 (the owned-record chain against direct
     metering writes), but that is a hypothesis, not established. It is escalated with question 1,
     unchanged.
2. **`agent-session.ts` is 4,634 lines after the second follow-up (4,594 at `524af30`), not ~4,550.** The spec's hard limit (shorter than 5,022) holds.
   B1 will move or retype more of the session.
3. **Answered (owner, beta `fd9ec24`): accepted as today's behaviour and a named exception to
   "nothing waits forever"; the fix is the integration spec's cancellable connect (stage 2a). A2
   keeps the queue waiting on an in-progress reconnect and fails the prompt at once on a rejected
   `send`.** Original text: **A pre-existing stop hang during a held reconnect (outside A2).** On the unchanged A1 commit, with
   no fault injected: if the provider's reconnect (`session/load`) is never answered, the prompt
   never settles and `stop()` doesn't finish either (still pending after 2 s in the probe). The
   current code behaves the same when nothing is injected. `AgentSession.stop()` calls
   `controller.stop()` and then waits for the queue, but `controller.stop()` cannot reach a client
   that is still being brought up (it only becomes the controller's client once `bringUp`
   resolves). So the operation waiting on that reconnect, and `stop()` behind it, wait for the
   provider. Making `stop` cancel a reconnect in progress would be new ACP behaviour in
   `controller.ts`, outside A2's "no new behaviour" scope, so I did not change it. This is a
   question for the owner. The new regression test releases the held load before stopping;
   without a release, its cleanup would hit this hang. (Probe: `/tmp/a2-fix/held-reconnect-probe.ts`.)

4. **New, for the owner: a turn whose metering write fails.** If closing the metered operation
   throws (`MeteringEngine.close` never throws for usage problems, but a persistence or resolver
   failure could), or the Agent-owned `meteringRecorded` write or managed `finishV2Prompt` fails,
   the turn ends without its metering record. On the failure path, a managed write
   failure is logged (`transcript_terminal_write_failed`), and the turn still fails with its own error. The spec's
   "metering once" does not say whether that is allowed. The watcher accepts it only when the case
   declares it (`expectMeteringWriteFailure`), and no case does.
   - **Also observed (not changed):** on the success path, a failing `meteringRecorded` sends the
     turn down the failure path, which calls `meteringRecorded` again with the same record
     (`run-turn.ts`, `closed ??`). That is a second write attempt of one record, not a second
     metering.
   - **Question:** should such a turn be a contract violation (the case must fail), or a named
     exception like the preflight rejection? Until decided, it stays declared-only.

## Gaps and limitations

- `send` accepting a run is not separately observable for the `HarnessController` (it resolves
  at once); the backend-scheduled semantics (the queue operation ending at acceptance) are B2's.
- The unknown-id check compares the run with the session's own run (built from its queue items),
  so for ACP it guards against a bug in building the run, not against external input.
- The "config waits for finalization" test proves the order over a 100 ms window.
