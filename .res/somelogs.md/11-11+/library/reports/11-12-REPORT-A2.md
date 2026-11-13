# Report: Brief A2, the turn path (controller interface)

Spec: `../11-11-SPEC-controller-interface.md` (beta `1bda9ef`). Branch `controller-interface`
(beta merged in `d48ddcb`; beta-update report `11-12-REPORT-A2-beta-update.md`). Status and
release: bob-b, `controller-interface-status` at `14f56c4`.

**State: step 1 done and committed; the spec correction (beta `fcd1fd4`) is merged in `efe6ebe`.
Steps 2–4 are held** until bob-b confirms both branches contain it. The spec question was
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

## Steps 2–4

Not started (held; see above).
