# Review — controller interface A2 verification

I reviewed the report-only commit `c6c6a005` (`library/reports/11-22-REPORT-A2-verify.md`) against
[Brief A2](../11-11-SPEC-controller-interface.md#brief-a2-the-turn-path-through-send-prepareturn-and-abandonturn)
and the Interface section. The source is the same as at `d11cd18`. I read it through a `git archive` copy and the
reviews worktree, without checking out `controller-interface-verify`.

**Verdict: no blocking findings.** Steps 1–4 are present, and the code matches the report. The five required tests
check what the step asks for. The intermittent failures look like test timing, not a race in `src/` that meets the
triage rule. One wording difference is between the spec and the code (finding 1), and the line count is above the
spec's estimate (finding 2).

## Findings, by severity

None of them blocks.

1. **The spec's commands-listener signature differs from the code (non-blocking; fix the spec wording).**
   - Spec L225 has `subscribeAvailableCommands?(listener: () => void)`.
   - `src/conversation-controller/contracts.ts:106` has `listener: (commands: readonly InternalSessionCommand[]) => void`.
   - The code's version is wider and still compatible: a zero-argument listener can be passed in TypeScript, and
     no caller breaks.
   - This counts as "contradicts another part of a spec", so under triage the **spec wording** gets fixed to the
     code's signature. There's no reason to change the code.
2. **`agent-session.ts` is 4,641 lines (non-blocking).** The hard rule (spec L514: under 5,022) holds. The spec gives
   "about 4,550 or less" as an expectation, not a gate. The extra 91 lines came after the extraction (4,546 at
   `0383681`): from step 4's send/readiness/abandon wiring and later fixes. **Accept**, and update the spec's
   expected figure, or move the steer-run construction (L2306–2385) out later if the file grows again.
3. **Two changes to the order of operations that the spec doesn't describe (non-blocking; accept, add a sentence to
   the spec).**
   - *Readiness started at `send`, then awaited together with acceptance* (`agent-session.ts` around L2348–2351:
     `ensureProvider()` started, then `await Promise.all([ready, accepted])` before `runPrompt`). Readiness used to
     run inside the turn. It overlaps acceptance now, but nothing is delivered or dispatched before both settle.
     A rejected acceptance fails the turn, and the queue waits for a still-running readiness before the next
     operation (around L2385), so there are no overlapping reconnects.
     - What changes in observable order was covered by the two owner-approved order allowances (`6e46e40`).
     - The A1 snapshots are otherwise unchanged.
     - Nothing gets stuck or lost, so the triage rule doesn't call for a fix.
   - *ACP input built at preparation instead of inside the deferred `prompt()` closure.* Building the input is pure,
     and the provider still starts only after the supervisor subscribes (`supervisor.ts:120–127`: `subscribeOutput`
     comes before `provider.prompt()`, which itself is deferred by `Promise.resolve().then`). Nothing observable
     changes.

   Both are acceptable. The spec's "How a turn runs" section should say that readiness starts at `send` and is
   awaited together with acceptance.
4. **The finalization-failure test sets its "provider finished" flag in the test's own hook (minor).**
   `turn-path.test.ts:142` sets `providerFinished` inside the replaced `afterPrompt`. That only shows `afterPrompt`
   was reached, which itself implies the provider finished. The assertion is weak but holds. **Accept.**

## Steps 1–4 checked

- **Step 1.** `AgentSession` delegates to `runTurn(this.turnRunContext(), turn)`. `run-turn.ts` has 353 lines, and
  its phases run in the reported order: prepare, user writes/metering, dispatch under the supervisor, finish
  records/metering, finalize, failure.
- **Step 2.** `contracts.ts` has the turn members with doc comments, an optional `TurnRun.turnId`,
  `TurnEvent = TurnStarted | TurnTook`, `PreparedTurn { turnId, live }`, and `SupervisedProvider` in
  `src/operations/contracts.ts`.
- **Step 3.** `controller.ts:316–366`:
  - `send` checks the turn ID, the run being non-empty, and duplicates. It emits `turn_started` with
    `sentBySession: true` synchronously, then returns a resolved promise.
  - `prepareTurn` and `prepareInternalPrompt` wrap `prompt({...input, handlers})` with the controller's own
    output, cancel and force stop.
  - `abandonTurn` deletes from `reportedTurns` and does nothing on a repeat. `prompt` stays.
- **Step 4.**
  - The run's state is registered and checked against accepted messages before `controller.send(run)`.
  - `runPrompt({ turnId, cause, messages })` takes the turn context.
  - When the turn fails, `abandonTurn` is called before `turn_failed`.
  - Completion stays the session's, after finalization.

## The five required tests (`test/conversation-turns/turn-path.test.ts`)

| Requirement | Test | Holds? |
| --- | --- | --- |
| Combined steer cause lists both IDs; records keyed by the turn | L92 | Yes. It checks the exact `turn_started` causes `[a.id, b.id]` and user record IDs `a:user`, `a:user:2`. |
| Provider-connection failure → `abandonTurn`, `turn_failed`, rejects | L120 | Yes. It checks that `abandonTurn` is called once with the turn ID, that `prepareTurn` isn't called, that the events are `turn_started` then `turn_failed`, and that the prompt rejects. |
| Finalization failure → `turn_failed`, not `turn_completed` | L142 | Yes (see finding 4). |
| Config change waits for the turn's finalization (slow `afterPrompt`) | L161 | Yes. A test-controlled gate holds finalization, and the test checks the queue state while held and the exact order afterwards. Every wait has a limit. |
| Duplicate or unknown message ID throws | L387 (unit), L230 (unknown ID at dispatch, before `send`), L416 (controller duplicate) | Yes. |

## Intermittent failures (the four error notes)

My run: a fresh `git archive c6c6a005` in `/tmp/clad2a-a2.8Imx`, with `node_modules` linked. I ran
`turn-path.test.ts`, `operation-lifecycle.test.ts` and `checkpointing/strategy.test.ts` together four times. Logs
are in `/tmp/clad2a-a2.8Imx.run-{1..4}.log`.

| Run | Result |
| --- | --- |
| 1 | 45 pass, 0 fail, 15.36 s |
| 2 | 45 pass, 0 fail, 11.87 s |
| 3 | 45 pass, 0 fail, 12.30 s |
| 4 | 45 pass, 0 fail, 15.62 s |

None of the failures reproduced in isolation. My assessment of each:

- **Coalesced checkpoint watermark** (`strategy.test.ts:122–181`). This one could have meant lost data, so I read
  the coordinator.
  - `coordinator.ts` `afterCheckpointCompleted` re-enqueues whenever the run's `requestedThroughSequence` is above
    the covered sequence. The test awaits the second `request()` before releasing the first. So the higher
    watermark is stored before the first checkpoint completes, and nothing in the code drops it.
  - The failure note says Bun measured the test at **169 ms**, while the loop polls against a **3,000 ms**
    `Date.now()` deadline. With coverage still at 2, that loop can only end early if the wall clock jumped forward
    by about 3 s. That's plausible on WSL2, where the clock is resynced.
  - So the test most likely asserted before the second checkpoint ran. I'm classifying it as **test timing**.
    **Accept.** If it comes back: use `performance.now()` for the deadline, or wait on a checkpoint event.
- **Managed continuation timeout, owned continuation timeout (`load_failed` instead of `missing`), and
  cancellation-record timeout with `SQLITE_IOERR_FSTAT`** (`operation-lifecycle.test.ts:320/375/518`).
  - All three happened in the same full run, under full-suite load, with 5 s or 20 s limits. Each later error
    (missing transcript, FSTAT, a different load-error class) comes *after* the timeout. They look like teardown
    removing the temp directory or process while the test body is still running. They don't look like a first
    cause.
  - All passed in cod2a's later runs and in my four runs.
  - **Accept** as test timing under load. The `load_failed`/`missing` classification would only matter if it shows
    up without a timeout. I didn't find a path in `src` that could get stuck or lose data.

## Gate evidence not repeated

I didn't run the typecheck or the full `bun test ./test`. My evidence is the four targeted runs above plus reading
the code.
