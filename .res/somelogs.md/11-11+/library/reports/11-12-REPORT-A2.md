# Report: Brief A2, the turn path (controller interface)

Spec: `../11-11-SPEC-controller-interface.md` (beta `1bda9ef`). Branch `controller-interface`
(beta merged in `d48ddcb`; beta-update report `11-12-REPORT-A2-beta-update.md`). Status and
release: bob-b, `controller-interface-status` at `14f56c4`.

**State: steps 1–4 done, and the three blocking review findings (`11-12-REVIEW-A2.md` at
`c2e8f4b`) fixed in `e7f2d79`. Gate met: full suite 1,142 pass / 0 fail.** One pre-existing A1
snapshot race still needs the owner's decision (open question 1). The spec correction (beta
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

## Open questions

1. **A pre-existing order race in an A1 snapshot (the managed combined-steer case).** While
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
2. **`agent-session.ts` is 4,613 lines after the review fixes (4,594 before), not ~4,550.** The spec's hard limit (shorter than 5,022) holds.
   B1 will move or retype more of the session.

## Gaps and limitations

- `send` accepting a run is not separately observable for the `HarnessController` (it resolves
  at once); the backend-scheduled semantics (the queue operation ending at acceptance) are B2's.
- The unknown-id check compares the run with the session's own run (built from its queue items),
  so for ACP it guards against a bug in building the run, not against external input.
- The "config waits for finalization" test proves the order over a 100 ms window.
