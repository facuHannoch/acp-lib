# Review — controller interface B2 verification

I reviewed the report-only commit `7c00cb70` (`library/reports/11-22-REPORT-B2-verify.md`) against
[Brief B2](../11-11-SPEC-controller-interface.md#brief-b2-turns-the-backend-starts-and-the-conformance-suite).
I read the code through `git archive 7c00cb70` and the reviews worktree; I didn't check out
`controller-interface-verify`. My probe ran offline with its own ACP fixture and no live harness. I reviewed only
`7c00cb70`, not cod2a's later test edits.

**Verdict: no blocking findings.**

- Step 5 and the conformance table hold.
- (a) is a gap in the fake and in the test's assertion, not a session bug that real controllers can trigger.
- (b) is a bug in the test double.
- (c) is a mix of spec wording and test gaps. None of it is a must-fix.

## (a) Late output after a force stop

**Code reading.** The session doesn't guard against late output. The recording handlers in
`src/conversation-turns/recording.ts` (~L116–160: `onResponseChunk`, `onActivity`, and the rest) have no "turn
ended" flag. Anything that calls them after the turn finished still reaches the consumer callback and can flush an
`in_progress` assistant snapshot under that turn. So the session relies on each controller to stop calling a turn's
handlers once the turn ends. Each controller does that:

- **HarnessController / AcpClient.** Handlers are reachable only through `AcpClient.active`
  (`src/client.ts` L803–841, L925–945). `active` is set for the duration of `transport.prompt` and cleared in
  `finally`. `handleUpdate` returns early when `active` is null. `HarnessController.forceStop`
  (`controller.ts:371–374`) fires the force listeners and then `stop()`, which tears down the client.
- **NativeController.** Each turn has a `released` flag. `stop` and force stop release the turn, and the event paths
  skip released turns (`native/controller.ts` ~L245, L266, L482–483).

**Probe.** I wanted to know whether data already buffered in the ACP pipe could still reach the old handlers in the
gap between the supervisor's forced result and `AcpClient.active` being cleared. So I wrote an ACP fixture that
streams `agent_message_chunk` updates without stopping (200 per `setImmediate`):

- Files: `/tmp/clad2a-b2.*/test/zz-probe/flood-agent.ts` and `b2-late.test.ts`, temporary and outside the repo.
- The probe runs an Agent-owned conversation on a real `HarnessController`. It force-stops after 50 chunks, and
  counts `onResponseChunk` calls after `forceStop()` was called, after the prompt settled, and over a further 300 ms.

Results over 5 rounds:

| Round | Chunks before | After `forceStop` | After settle | Assistant records |
| --- | --- | --- | --- | --- |
| 1–5 | 200–639 | **0** | **0** | One `in_progress` snapshot (normal, written at the first chunk), then the turn's final record `failed`. Nothing after. |

**Triage.**

- With the real controllers, the old turn gets no late output. The case can only happen with a controller that
  breaks its contract, like the fake's `deliverLate`.
- Even then, the effect is one extra `in_progress` snapshot under a turn that has already failed. Nothing gets
  stuck and nothing is lost.
- So it isn't a source bug under triage. **Accept.** Two follow-ups, both optional:
  1. **Spec wording.** The spec (L647, "late output arriving after a force stop is dropped, not recorded on the
     next turn") should say that dropping is the *controller's* contract: once a turn has ended, the controller
     stops calling its handlers. The session's guarantee is that output can't land on the *next* turn, and the
     existing test (`fake-only.test.ts:147`) does assert that.
  2. **Cheap extra safety, if the owner wants it.** Add a `closed` flag to the recording handlers, set when the
     turn completes or fails, so late callbacks are dropped. That's about 5 lines in `recording.ts`. The fake test
     could then also assert that no callback fires and no record is written. It isn't required.

## (b) The fake turns an ended turn's cancel into "cancelled"

Confirmed by reading `test/conversation-controller/fake-controller.ts`:

- `cancel` sets `cancelled = true` unconditionally (L151).
- The result is `cancelled ? "cancelled" : script.status` (L171).
- A turn prepared with `ended: true` (`live: false`) therefore replays as cancelled if `cancel()` comes before the
  replay. The interface says a cancel does nothing once the backend has ended the turn.

This is a **bug in the test double only**; no source code is affected.

- **Fix:** record a cancel only while the turn is live, e.g. `cancel: () => { if (!replaying) { cancelled = true; onCancel(); } }`,
  or decide the status from whether the turn was live when the cancel arrived.
- Then add the missing combined case: B ended and held, C running, cancel B, and check that B's replay stays
  `completed` and C keeps running.

Not blocking. It's in `test/` and can go in with cod2a's authorized test edits.

## (c) Coverage gaps

| Gap | Classification |
| --- | --- |
| Steer isn't in the shared nine | **Test gap, accept.** Steer is covered by dedicated tests on every subject: the fake in `backend-scheduled.test.ts` L114/238/300, Harness in `turn-path.test.ts` L92 and the A1 snapshots, and Native in checkpoint L45 and controller L160. Optionally add a tenth shared case later. |
| Shared suite runs the lifecycle fixture instead of echo | **Spec wording.** For the shared cases, lifecycle does everything echo does: its default prompt echoes. It also adds the tool, silence and failed-load scenarios the cases need. Update B2's wording to "lifecycle". |
| The fake never emits usage; the shared usage row doesn't check amounts | **Test gap, small.** Metering records are created, but the conformance case doesn't check that reported usage reaches them. Suggest the fake return non-null `usage` from `prompt()` and the shared case assert the metered amounts. Not a must-fix: nothing gets stuck or lost in the source. |
| Stale changelog and test-header lines | **Docs.** The two "later native backend" / "none today" lines are only outdated. The local-withdrawal bullet is *wrong*: the code still runs the later turn and ignores only the withdrawn ID for settlement. The changelog contradicts the code, so fix that bullet (triage: wording). Also update the stale "interface has no message payload yet" header in `conformance.ts`. |

## Step 5 and the conformance table checked

I spot-checked these against `7c00cb70`, and they match the report:

- The subscriber in `agent-session.ts` ~L745–773 routes `sentBySession: false` reports to `backend-turns.ts` as a
  `backend_turn` queue item, and the pump dispatches it (~L2386).
- `run-turn.ts` skips the user writes and the ACP input when `messages` is absent.
- `turn_took` merges into the cause and settles the taken handles after the turn's terminal event.
- The native release filtering is there.

I agree with the report's present/different/missing labels. The only additions are the late-output assertion
(a) and the ended-turn cancel (b) above.

## Gate evidence

I didn't rerun the typecheck or the full suite. cod2a's run (1,402/131, snapshot hash unchanged) stands. My evidence
is the code reading plus the 5-round flood probe.
